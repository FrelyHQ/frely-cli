import assert from "node:assert/strict";
import test from "node:test";
import type { LocalProviderBinding } from "../provider/state.js";
import type { ShareLocalProviderInput, ShareLocalProviderResult } from "../provider/share.js";
import { modelShareArguments, parseModelShareArguments, shareModel, type ModelShareDeps } from "./model-share.js";
import { runServiceCommand, serviceUsage } from "./service-run.js";

const provider: LocalProviderBinding = { providerId: `prv_${"a".repeat(24)}`, name: "n", driver: "openai-compatible", baseUrl: "http://127.0.0.1:8080/v1", providerBaseUrl: "https://x.test/local-provider/v1", models: ["glm-5.3-flash"], createdAt: new Date().toISOString() };

function fakes(result: Partial<ShareLocalProviderResult> = {}) {
  const calls: ShareLocalProviderInput[] = [];
  const confirmed: string[] = [];
  const deps: ModelShareDeps = {
    share: async (input): Promise<ShareLocalProviderResult> => { calls.push(input); return { provider: { ...provider }, slot: "personal", resumed: false, accessPoints: [{ id: "ap_1", name: "alice/glm-5.3-flash", model: "glm-5.3-flash" }], ...result }; },
    confirmLan: async (url) => { confirmed.push(url); },
    readSecret: async () => "sk-from-stdin",
  };
  return { calls, confirmed, deps };
}

test("`share model` and `--type model` both ask for a model share", () => {
  assert.deepEqual(modelShareArguments(["model", "ollama"]), ["ollama"]);
  assert.deepEqual(modelShareArguments(["--type", "model", "--url", "http://x/v1"]), ["--url", "http://x/v1"]);
  assert.deepEqual(modelShareArguments(["--type=model", "--json"]), ["--json"]);
  assert.equal(modelShareArguments(["--type", "mcp", "--port", "1"]), undefined);
});

test("model share arguments", () => {
  const options = parseModelShareArguments(["openai-compatible", "--url", "http://192.168.1.2:3000/v1", "--models", "a, b", "--name=NewAPI", "--creator", "--key-stdin", "--max-concurrent", "4", "--json"]);
  assert.deepEqual(options, { driver: "openai-compatible", url: "http://192.168.1.2:3000/v1", models: ["a", "b"], name: "NewAPI", creator: true, keyStdin: true, maxConcurrent: 4, json: true });
  assert.equal(parseModelShareArguments([]).driver, "ollama");
  assert.throws(() => parseModelShareArguments(["vllm"]), /ollama or openai-compatible/);
  assert.throws(() => parseModelShareArguments(["--creator", "--slot", "s"]), /either --slot or --creator/);
  assert.throws(() => parseModelShareArguments(["--bogus"]), /Unknown option/);
  assert.throws(() => parseModelShareArguments(["--max-concurrent", "0"]), /1 to 64/);
});

test("sharing returns the AccessPoint; a network address is confirmed first and the key comes from stdin", async () => {
  const { calls, confirmed, deps } = fakes();
  let out = "";
  assert.equal(await shareModel(parseModelShareArguments(["openai-compatible", "--url", "http://192.168.201.98:3000/v1", "--key-stdin"]), { write: (text) => { out += text; } }, deps), 0);
  assert.deepEqual(confirmed, ["http://192.168.201.98:3000/v1"]);
  assert.equal(calls[0]?.lan, true);
  assert.equal(calls[0]?.key, "sk-from-stdin");
  assert.equal(calls[0]?.accessPoints, true);
  assert.match(out, /AccessPoint: alice\/glm-5\.3-flash/);
  assert.ok(!out.includes("sk-from-stdin"));
});

test("a loopback address needs no confirmation and is not marked as a network address", async () => {
  const { calls, confirmed, deps } = fakes();
  await shareModel(parseModelShareArguments(["--url", "http://127.0.0.1:11434/v1", "--json"]), { write: () => undefined }, deps);
  assert.deepEqual(confirmed, []);
  assert.equal(calls[0]?.lan, undefined);
});

test("without the right to create AccessPoints the share still succeeds and says why", async () => {
  const { deps } = fakes({ accessPoints: [], accessPointNote: "Your plan cannot create AccessPoints" });
  let out = "";
  assert.equal(await shareModel(parseModelShareArguments([]), { write: (text) => { out += text; } }, deps), 0);
  assert.match(out, /No AccessPoint was made/);
  assert.match(out, /Your plan cannot create AccessPoints/);
  let json = "";
  await shareModel(parseModelShareArguments(["--json"]), { write: (text) => { json += text; } }, deps);
  assert.deepEqual(JSON.parse(json).accessPoints, []);
  assert.equal(JSON.parse(json).note, "Your plan cannot create AccessPoints");
});

test("`frely service share model` runs through the service command and the usage lists it", async () => {
  const { calls, deps } = fakes();
  let out = "";
  const code = await runServiceCommand(["share", "model", "ollama"], { write: (text) => { out += text; } }, {
    control: async () => { throw new Error("not a service share"); }, probe: async () => false, ensureFrpc: async () => "", spawnFrpc: () => { throw new Error("no"); },
    signal: new AbortController().signal, installDaemon: async () => undefined, model: deps,
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.match(out, /AccessPoint:/);
  assert.match(serviceUsage(), /frely service share model/);
});

test("`frely provider share` is gone: it is an unknown command and help no longer lists it", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const entry = fileURLToPath(new URL("../index.js", import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [entry, "provider", "share", "ollama"]), (error: Error & { stderr: string }) => /Unknown provider command/.test(error.stderr));
  const help = JSON.parse((await promisify(execFile)(process.execPath, [entry, "help", "--agent", "--json"])).stdout) as { commands: Array<{ id: string }> };
  assert.ok(!help.commands.some((command) => command.id === "provider.share"));
  assert.ok(help.commands.some((command) => command.id === "service.share"));
});
