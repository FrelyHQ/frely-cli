import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { registerLocalOnlyProvider } from "../provider/register.js";
import type { LocalProviderBinding } from "../provider/state.js";
import { buildDefinition, saveDefinition } from "./definition.js";
import { describeRun, startTask, waitForTaskRun, type ManagerDeps } from "./manager.js";
import { openTaskModel } from "./model-route.js";
import { createTaskRun, snapshotOf } from "./run-store.js";
import { executeTaskRun } from "./worker.js";

let root: string;
let cwd: string;
const saved: Record<string, string | undefined> = {};
before(async () => {
  root = await mkdtemp(join(tmpdir(), "frely-route-"));
  for (const name of ["FRELY_CREDENTIAL_STORE", "FRELY_CREDENTIAL_KEY", "FRELY_SANDBOX"]) saved[name] = process.env[name];
  process.env.FRELY_CREDENTIAL_STORE = "encrypted-file";
  process.env.FRELY_CREDENTIAL_KEY = "cd".repeat(32);
  process.env.FRELY_SANDBOX = "off";
});
after(async () => {
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(root, "config-"));
  cwd = await mkdtemp(join(root, "work-"));
});

interface Seen { method: string; url: string; authorization?: string; body: string }
async function endpoint(models: string[], key: string, statusForModels = 200): Promise<{ baseUrl: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    seen.push({ method: request.method ?? "", url: request.url ?? "", ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}), body });
    const authorized = request.headers.authorization === `Bearer ${key}`;
    response.writeHead(authorized ? statusForModels : 401, { "content-type": "application/json" });
    if (request.url === "/v1/models") response.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
    else response.end(JSON.stringify({ choices: [{ message: { content: `answer from ${models[0]}` } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, seen, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

const noLogin = async () => ({ reason: "not signed in" });
const io = { err: () => undefined, interactive: false };

/** The program: one chat call through $OPENAI_BASE_URL with the key it was given. */
const CALL = `node -e 'fetch(process.env.OPENAI_BASE_URL + "/chat/completions", { method: "POST", headers: { authorization: "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json" }, body: JSON.stringify({ model: process.env.FRELY_MODEL, messages: [] }) }).then((r) => r.json()).then((j) => console.log("GOT " + j.choices[0].message.content))'`;

test("a task calls a model endpoint registered on this computer directly: the real key is added outside the program", async () => {
  const server = await endpoint(["glm-5.3-flash"], "sk-lan");
  try {
    await registerLocalOnlyProvider({ driver: "openai-compatible", url: server.baseUrl, key: "sk-lan" }, io);
    await saveDefinition(buildDefinition({ name: "translate", command: CALL, cwd, model: "glm-5.3-flash" }));
    const jobs: Promise<void>[] = [];
    const deps: ManagerDeps = { spawnWorker: (runId) => { jobs.push(executeTaskRun(runId)); } };
    const done = await waitForTaskRun((await startTask("translate", {}, deps)).runId, 30_000);
    await Promise.all(jobs);
    const final = await waitForTaskRun(done.runId, 5_000);
    assert.equal(final.status, "completed", JSON.stringify(final.error));
    assert.match(String((await describeRun(final, { tail: true })).logTail), /GOT answer from glm-5.3-flash/u);
    const chat = server.seen.find((item) => item.url === "/v1/chat/completions");
    assert.equal(chat?.authorization, "Bearer sk-lan", "the real key reaches the endpoint");
    assert.equal(JSON.parse(chat!.body).model, "glm-5.3-flash");
    assert.equal(final.modelStats?.requests, 1);
    assert.equal(final.modelUsed, "glm-5.3-flash");
    assert.ok(!JSON.stringify(final).includes("sk-lan"), "the run record never holds the key");
  } finally { await server.close(); }
});

test("start-failure fallback: a rejected key or an unknown model moves to the next model, and a failed chain stops the run", async () => {
  const bad = await endpoint(["model-a"], "right-key");
  const good = await endpoint(["model-b"], "key-b");
  try {
    await registerLocalOnlyProvider({ driver: "openai-compatible", url: bad.baseUrl, key: "wrong-key", models: ["model-a"] }, io);
    await registerLocalOnlyProvider({ driver: "openai-compatible", url: good.baseUrl, key: "key-b" }, io);
    const record = await createTaskRun({ trigger: "manual", snapshot: { ...snapshotOf(buildDefinition({ name: "fb", command: "true", cwd, model: "model-a", fallbackModels: ["missing", "model-b"] }), []) } });
    const lines: string[] = [];
    const opened = await openTaskModel(record, (text) => lines.push(text), { gateway: noLogin });
    assert.equal(opened?.name, "model-b");
    assert.match(lines.join("\n"), /model-a cannot be started \(the key was rejected\)/u);
    assert.match(lines.join("\n"), /missing cannot be started \(not signed in\)/u);
    assert.match(lines.join("\n"), /Using model-b instead of model-a/u);
    await opened!.close();

    const doomed = await createTaskRun({ trigger: "manual", snapshot: snapshotOf(buildDefinition({ name: "doom", command: "true", cwd, model: "model-a" }), []) });
    await assert.rejects(openTaskModel(doomed, () => undefined, { gateway: noLogin }), /No model could be started.*the key was rejected/u);
  } finally { await bad.close(); await good.close(); }
});

test("no fallback for anything but a start failure: an endpoint that answers errors on calls is not swapped mid-run", async () => {
  const server = await endpoint(["only"], "k");
  try {
    await registerLocalOnlyProvider({ driver: "openai-compatible", url: server.baseUrl, key: "k" }, io);
    const record = await createTaskRun({ trigger: "manual", snapshot: snapshotOf(buildDefinition({ name: "once", command: "true", cwd, model: "only", fallbackModels: ["other"] }), []) });
    const opened = await openTaskModel(record, () => undefined, { gateway: noLogin });
    assert.equal(opened?.name, "only");
    const response = await fetch(`${opened!.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "only" }) });
    assert.equal(response.status, 200);
    await response.text();
    // A model that is not on this computer and cannot go to Frely is refused, not guessed.
    const stray = await fetch(`${opened!.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "stranger" }) });
    assert.equal(stray.status, 502);
    assert.match(await stray.text(), /not signed in/u);
    assert.equal(opened!.stats().requests, 1);
    await opened!.close();
  } finally { await server.close(); }
});

test("a path outside the model calls is refused by the proxy", async () => {
  const server = await endpoint(["m"], "k");
  try {
    await registerLocalOnlyProvider({ driver: "openai-compatible", url: server.baseUrl, key: "k" }, io);
    const record = await createTaskRun({ trigger: "manual", snapshot: snapshotOf(buildDefinition({ name: "paths", command: "true", cwd, model: "m" }), []) });
    const opened = await openTaskModel(record, () => undefined, { gateway: noLogin });
    const refused = await fetch(`${opened!.baseUrl.replace(/\/v1$/u, "")}/v1/files`, { method: "POST", body: "{}" });
    assert.equal(refused.status, 404);
    await opened!.close();
  } finally { await server.close(); }
});

test("providers that are only prepared are not used, and a LAN provider is probed at its own address", async () => {
  const providers: LocalProviderBinding[] = [{ providerId: `prv_${"b".repeat(24)}`, name: "p", driver: "openai-compatible", baseUrl: "http://192.168.201.98:3000/v1", providerBaseUrl: "https://x.test/local-provider/v1", models: ["m"], createdAt: new Date().toISOString(), pending: true }];
  const record = await createTaskRun({ trigger: "manual", snapshot: snapshotOf(buildDefinition({ name: "pend", command: "true", cwd, model: "m" }), []) });
  await assert.rejects(openTaskModel(record, () => undefined, { providers: async () => providers, gateway: noLogin }), /not signed in/u);
  const urls: string[] = [];
  const fetchFn = (async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }); }) as unknown as typeof fetch;
  const opened = await openTaskModel(record, () => undefined, { providers: async () => [{ ...providers[0]!, pending: false }], gateway: noLogin, fetchFn });
  assert.deepEqual(urls, ["http://192.168.201.98:3000/v1/models"]);
  await opened!.close();
});
