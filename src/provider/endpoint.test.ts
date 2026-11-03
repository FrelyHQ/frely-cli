import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { acquireEndpointSlot } from "./endpoint-slots.js";
import { openLocalProviderRequest, fetchLocalModelIds } from "./local.js";
import { confirmLanEndpoint, registerLocalOnlyProvider, removeLocalOnlyProvider, setProviderKey } from "./register.js";
import { readProviderKey } from "./key.js";
import { defaultEndpointLimit, isLanBaseUrl, listLocalProviders, normalizeLocalOpenAiBaseUrl, normalizeLoopbackOpenAiBaseUrl, saveLocalProvider } from "./state.js";

let root: string;
const saved: Record<string, string | undefined> = {};
before(async () => {
  root = await mkdtemp(join(tmpdir(), "frely-endpoint-"));
  for (const name of ["FRELY_CREDENTIAL_STORE", "FRELY_CREDENTIAL_KEY"]) saved[name] = process.env[name];
  process.env.FRELY_CREDENTIAL_STORE = "encrypted-file";
  process.env.FRELY_CREDENTIAL_KEY = "ab".repeat(32);
});
after(async () => {
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => { process.env.XDG_CONFIG_HOME = await mkdtemp(join(root, "config-")); });

test("local Provider addresses: loopback or private IP literals only", () => {
  for (const ok of ["http://127.0.0.1:3000/v1", "http://192.168.201.98:3000/v1/", "http://10.0.0.5/v1", "http://172.16.0.1:8080/v1", "http://172.31.255.254/v1", "http://[fd00::5]:8080/v1", "http://localhost:11434/v1"]) {
    assert.doesNotThrow(() => normalizeLocalOpenAiBaseUrl(ok), ok);
  }
  for (const bad of ["http://172.32.0.1/v1", "http://172.15.0.1/v1", "http://8.8.8.8/v1", "http://example.com/v1", "http://nas.local:3000/v1", "http://192.168.1.1.nip.io/v1", "https://192.168.1.2/v1", "http://192.168.1.2/api", "http://user:pw@192.168.1.2/v1", "http://[fe80::1]/v1", "http://169.254.169.254/v1", "http://192.168.1.256/v1"]) {
    assert.throws(() => normalizeLocalOpenAiBaseUrl(bad), Error, bad);
  }
  assert.equal(isLanBaseUrl("http://192.168.1.2:3000/v1"), true);
  assert.equal(isLanBaseUrl("http://127.0.0.1:3000/v1"), false);
  assert.equal(defaultEndpointLimit("http://127.0.0.1:3000/v1"), 1);
  assert.equal(defaultEndpointLimit("http://192.168.1.2:3000/v1"), 6);
  // The strict loopback check used for remote requests is unchanged.
  assert.throws(() => normalizeLoopbackOpenAiBaseUrl("http://192.168.1.10:11434/v1"), /loopback/u);
});

test("a network address is confirmed by the owner in person", async () => {
  await assert.rejects(confirmLanEndpoint("http://192.168.1.2:3000/v1", { err: () => undefined, interactive: false }), /terminal on this computer/u);
  await assert.rejects(confirmLanEndpoint("http://192.168.1.2:3000/v1", { err: () => undefined, interactive: true, ask: async () => "no" }), /not confirmed/u);
  await confirmLanEndpoint("http://192.168.1.2:3000/v1", { err: () => undefined, interactive: true, ask: async () => " YES " });
  await confirmLanEndpoint("http://127.0.0.1:3000/v1", { err: () => undefined, interactive: false });
});

test("call slots: the limit holds, a freed slot is reused, a dead owner's slot is taken over, tasks go before remote callers", async () => {
  const a = await acquireEndpointSlot("e1", 2, { kind: "remote" });
  const b = await acquireEndpointSlot("e1", 2, { kind: "remote" });
  assert.ok(a && b);
  assert.equal(await acquireEndpointSlot("e1", 2, { kind: "remote" }), undefined);
  assert.equal(await acquireEndpointSlot("e1", 2, { kind: "task", waitMs: 200, pollMs: 20 }), undefined);
  await a!();
  // A waiting task blocks remote callers: it takes the freed slot, the remote caller is refused meanwhile.
  const waiting = acquireEndpointSlot("e1", 2, { kind: "task", waitMs: 2000, pollMs: 20 });
  await b!();
  const taskSlot = await waiting;
  assert.ok(taskSlot);
  assert.ok(await acquireEndpointSlot("e1", 2, { kind: "remote" }), "a free slot, no task waiting");
  await taskSlot!();
  // Another endpoint is independent.
  assert.ok(await acquireEndpointSlot("e2", 1, { kind: "remote" }));
});

test("a slot whose owner died is taken over", async () => {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const dir = join(process.env.XDG_CONFIG_HOME!, "frely", "endpoint-slots", createHash("sha256").update("e3").digest("hex").slice(0, 24));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "slot-0"), JSON.stringify({ pid: 2 ** 22 + 777, token: "dead" }));
  assert.ok(await acquireEndpointSlot("e3", 1, { kind: "remote" }));
});

async function modelServer(handler: (url: string, authorization: string | undefined, body: string) => { status: number; body: unknown }): Promise<{ baseUrl: string; seen: Array<{ url: string; authorization?: string }>; close(): Promise<void> }> {
  const seen: Array<{ url: string; authorization?: string }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    seen.push({ url: request.url ?? "", ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) });
    const result = handler(request.url ?? "", request.headers.authorization, body);
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, seen, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

test("registering for this computer only: key kept in the credential store, nothing shared", async () => {
  const server = await modelServer((url, authorization) => (url === "/v1/models" && authorization === "Bearer sk-upstream" ? { status: 200, body: { data: [{ id: "glm-5.3-flash" }, { id: "other" }] } } : { status: 401, body: {} }));
  try {
    await assert.rejects(registerLocalOnlyProvider({ driver: "openai-compatible", url: server.baseUrl }, { err: () => undefined, interactive: false }), /HTTP 401/u);
    const binding = await registerLocalOnlyProvider({ driver: "openai-compatible", url: server.baseUrl, key: "sk-upstream", name: "NewAPI", maxConcurrent: 3 }, { err: () => undefined, interactive: false });
    assert.match(binding.providerId, /^lcl_[0-9a-f]{24}$/u);
    assert.deepEqual(binding.models, ["glm-5.3-flash", "other"]);
    assert.equal(binding.localOnly, true);
    assert.equal(await readProviderKey(binding.providerId), "sk-upstream");
    const { readFile } = await import("node:fs/promises");
    const file = await readFile(join(process.env.XDG_CONFIG_HOME!, "frely", "local-providers.json"), "utf8");
    assert.ok(!file.includes("sk-upstream"), "the key is never in the Provider file");
    // Remote callers cannot use a registration that stays on this computer.
    await assert.rejects(openLocalProviderRequest({ providerId: binding.providerId, request: { method: "GET", path: "/v1/models" } }), /not shared/u);
    await assert.rejects(registerLocalOnlyProvider({ driver: "openai-compatible", url: server.baseUrl, key: "sk-upstream" }, { err: () => undefined, interactive: false }), /already registered/u);
    await setProviderKey(binding.providerId, undefined);
    assert.equal(await readProviderKey(binding.providerId), undefined);
    await removeLocalOnlyProvider(binding.providerId);
    assert.deepEqual(await listLocalProviders(), []);
    assert.equal(await readProviderKey(binding.providerId), undefined);
  } finally { await server.close(); }
});

test("a shared Provider adds its key for remote calls, tells a buyer 'busy' at its limit, and fetches models with the key", async () => {
  const server = await modelServer((url, authorization) => (authorization === "Bearer sk-up" ? { status: 200, body: url.endsWith("/models") ? { data: [{ id: "m1" }] } : { ok: true } } : { status: 401, body: {} }));
  try {
    const providerId = `prv_${"a".repeat(24)}`;
    const { saveProviderKey } = await import("./key.js");
    await saveProviderKey(providerId, "sk-up");
    await saveLocalProvider({ providerId, name: "n", driver: "openai-compatible", baseUrl: server.baseUrl, providerBaseUrl: "https://frely.cloud/local-provider/v1", models: ["m1"], createdAt: new Date().toISOString(), slot: "personal", hasKey: true, maxConcurrent: 1 });
    assert.deepEqual(await fetchLocalModelIds(server.baseUrl, 2000, { key: "sk-up" }), ["m1"]);
    const first = await openLocalProviderRequest({ providerId, request: { method: "POST", path: "/v1/chat/completions", body: { model: "m1" } } });
    assert.equal(first.status, 200);
    assert.equal(server.seen.at(-1)?.authorization, "Bearer sk-up");
    const second = await openLocalProviderRequest({ providerId, request: { method: "POST", path: "/v1/chat/completions", body: { model: "m1" } } });
    assert.equal(second.status, 429, "the endpoint's one slot is taken");
    await first.response.body?.cancel();
    await first.release?.();
    const third = await openLocalProviderRequest({ providerId, request: { method: "GET", path: "/v1/models" } });
    assert.equal(third.status, 200);
    await third.response.body?.cancel();
    await third.release?.();
  } finally { await server.close(); }
});
