import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseServiceGrant, serviceFrpcConfigToml } from "./service-config.js";
import { parseServiceShareArguments, runServiceCommand, runServiceSession, type ServiceCommandDeps } from "./service-run.js";
import type { ServiceControl } from "./service-control.js";
import { listLocalServices, saveLocalService } from "./service-state.js";

const SID = "frps_" + "ab".repeat(12), SVC = "svcs_" + "cd".repeat(12);
const grantValue = () => ({
  id: SID, serviceShareId: SVC, expiresAt: new Date(Date.now() + 3600_000).toISOString(), node: "dmit-la", bandwidthBytesPerSecond: 1048576, remainingBytes: 5 * 1048576,
  frpc: { serverAddr: "203.0.113.7", serverPort: 7000, user: SID, token: "frs_" + "T".repeat(43), proxyName: "svc", proxyType: "stcp", secretKey: "K".repeat(43), allowUsers: ["frpv_dmit-la"] },
});

test("a valid service grant parses and is copied", () => {
  const grant = parseServiceGrant(grantValue());
  assert.equal(grant.frpc.proxyType, "stcp");
  assert.deepEqual(grant.frpc.allowUsers, ["frpv_dmit-la"]);
});

test("a service grant with anything unexpected is refused", () => {
  const bad: Array<(g: ReturnType<typeof grantValue>) => unknown> = [
    (g) => ({ ...g, id: "x" }), (g) => ({ ...g, serviceShareId: "svcs_1" }), (g) => ({ ...g, expiresAt: "soon" }), (g) => ({ ...g, remainingBytes: -1 }),
    (g) => ({ ...g, frpc: { ...g.frpc, proxyName: "other" } }), (g) => ({ ...g, frpc: { ...g.frpc, proxyType: "http" } }), (g) => ({ ...g, frpc: { ...g.frpc, user: "frps_" + "00".repeat(12) } }),
    (g) => ({ ...g, frpc: { ...g.frpc, serverAddr: "evil.test\"\nx" } }), (g) => ({ ...g, frpc: { ...g.frpc, serverPort: 0 } }), (g) => ({ ...g, frpc: { ...g.frpc, token: "bad" } }),
    (g) => ({ ...g, frpc: { ...g.frpc, secretKey: "short" } }), (g) => ({ ...g, frpc: { ...g.frpc, allowUsers: [] } }), (g) => ({ ...g, frpc: { ...g.frpc, allowUsers: ["*"] } }),
    (g) => ({ ...g, frpc: { ...g.frpc, allowUsers: ["a\nb"] } }), (g) => ({ ...g, frpc: undefined }), () => null, () => [],
  ];
  for (const mutate of bad) assert.throws(() => parseServiceGrant(mutate(grantValue())), /invalid service session/u);
});

test("the config has one stcp proxy named svc on loopback and nothing else", () => {
  const toml = serviceFrpcConfigToml(parseServiceGrant(grantValue()), 8123);
  assert.equal((toml.match(/\[\[proxies\]\]/gu) ?? []).length, 1);
  assert.match(toml, /name = "svc"\ntype = "stcp"\nsecretKey = "K{43}"\nallowUsers = \["frpv_dmit-la"\]\nlocalIP = "127.0.0.1"\nlocalPort = 8123\n/u);
  assert.doesNotMatch(toml, /webServer|plugin|subdomain|customDomains|type = "http|type = "tcp"/u);
  assert.throws(() => serviceFrpcConfigToml(parseServiceGrant(grantValue()), 0), /Invalid local port/u);
  assert.throws(() => serviceFrpcConfigToml(parseServiceGrant(grantValue()), 70000), /Invalid local port/u);
});

test("service share arguments are validated", () => {
  assert.deepEqual(parseServiceShareArguments(["--type", "mcp", "--port", "8080"]), { type: "mcp", port: 8080, label: "local-mcp", background: false, json: false });
  assert.deepEqual(parseServiceShareArguments(["--type=a2a", "--port=9", "--label", " My agent ", "--background", "--json"]), { type: "a2a", port: 9, label: "My agent", background: true, json: true });
  for (const args of [[], ["--type", "mcp"], ["--port", "80"], ["--type", "http", "--port", "80"], ["--type", "mcp", "--port", "0"], ["--type", "mcp", "--port", "65536"], ["--type", "mcp", "--port", "8x"],
    ["--type", "mcp", "--port", "80", "--host", "10.0.0.5"], ["--type", "mcp", "--port", "80", "192.168.1.2:80"], ["--type", "mcp", "--port", "80", "--label", ""], ["--type", "mcp", "--port", "80", "--label", "x".repeat(61)], ["--type", "mcp", "--port"]])
    assert.throws(() => parseServiceShareArguments(args), Error, JSON.stringify(args));
});

function fixture() {
  const calls = { registered: [] as unknown[], revoked: [] as string[], configs: [] as string[], killed: 0, installed: 0, removed: [] as string[] };
  let finish: (v: { code: number | null; stderr: string }) => void = () => undefined;
  const control: ServiceControl = {
    async register(input) { calls.registered.push(input); return { id: SVC, deviceId: "dev", type: input.type, label: input.label, createdAt: "2026-10-28T00:00:00.000Z" }; },
    async list() { return [{ id: SVC, deviceId: "dev", type: "mcp", label: "m", createdAt: "" }]; },
    async remove(id) { calls.removed.push(id); },
    async session() { return parseServiceGrant(grantValue()); },
    async heartbeat() { return { active: true, remainingBytes: 1, expiresAt: "x" }; },
    async revoke(id) { calls.revoked.push(id); },
  };
  const controller = new AbortController();
  const out: string[] = [];
  const deps: ServiceCommandDeps = {
    control: async () => control, probe: async () => true, ensureFrpc: async () => "/fake/frpc", signal: controller.signal,
    spawnFrpc: (_b, path) => { calls.configs.push(path); void readFile(path, "utf8").then((t) => out.push(`CONFIG:${t}`)); return { done: new Promise((r) => { finish = r; }), kill: () => { calls.killed += 1; finish({ code: 0, stderr: "" }); } }; },
    installDaemon: async () => { calls.installed += 1; },
  };
  return { deps, calls, out, controller, io: { write: (t: string) => { out.push(t); } } };
}

async function withHome<T>(run: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "frely-svc-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try { return await run(); } finally { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; await rm(dir, { recursive: true, force: true }); }
}

test("service share registers only type and label, prints the allowance, and revokes on Ctrl+C", async () => {
  await withHome(async () => {
    const f = fixture();
    const run = runServiceCommand(["share", "--type", "mcp", "--port", "8123", "--label", "docs"], f.io, f.deps);
    await new Promise((r) => setTimeout(r, 100));
    f.controller.abort();
    assert.equal(await run, 0);
    assert.deepEqual(f.calls.registered, [{ type: "mcp", label: "docs" }]);
    assert.ok(!JSON.stringify(f.calls.registered).includes("8123"));
    const text = f.out.join("");
    assert.match(text, /5 MiB of relay allowance left this week/u);
    assert.match(text, /counts against your weekly relay allowance/u);
    assert.match(text, /localPort = 8123/u);
    assert.deepEqual(f.calls.revoked, [SID]);
    assert.equal(f.calls.killed, 1);
    const [saved] = await listLocalServices();
    assert.deepEqual([saved?.serviceShareId, saved?.port, saved?.background], [SVC, 8123, false]);
  });
});

test("--background saves the service for the daemon and starts nothing here; a nothing-listening port is refused", async () => {
  await withHome(async () => {
    const f = fixture();
    assert.equal(await runServiceCommand(["share", "--type", "a2a", "--port", "9000", "--background"], f.io, f.deps), 0);
    assert.equal(f.calls.installed, 1);
    assert.equal(f.calls.configs.length, 0);
    assert.equal((await listLocalServices())[0]?.background, true);
    await assert.rejects(runServiceCommand(["share", "--type", "mcp", "--port", "9000"], f.io, f.deps), /already kept connected/u);
    await assert.rejects(runServiceCommand(["share", "--type", "mcp", "--port", "9001"], f.io, { ...f.deps, probe: async () => false }), /Nothing is listening/u);
  });
});

test("stop keeps the registration, remove deletes it", async () => {
  await withHome(async () => {
    const f = fixture();
    await saveLocalService({ serviceShareId: SVC, type: "mcp", label: "docs", port: 1234, createdAt: "2026-10-28T00:00:00.000Z", background: true });
    await runServiceCommand(["stop", "docs"], f.io, f.deps);
    assert.equal((await listLocalServices())[0]?.background, false);
    await assert.rejects(runServiceCommand(["stop", "nope"], f.io, f.deps), /No service/u);
    await runServiceCommand(["remove", SVC], f.io, f.deps);
    assert.deepEqual(f.calls.removed, [SVC]);
    assert.equal((await listLocalServices()).length, 0);
  });
});

test("runServiceSession ends when Frely says the allowance is used up, and still revokes", async () => {
  const f = fixture();
  const control = await f.deps.control();
  const result = await runServiceSession({ serviceShareId: SVC, port: 8123 }, {
    control: { ...control, heartbeat: async () => ({ active: false, reason: "quota_exhausted", remainingBytes: 0, expiresAt: "x" }) }, ensureFrpc: f.deps.ensureFrpc, spawnFrpc: f.deps.spawnFrpc, write: f.io.write, signal: f.controller.signal, heartbeatMs: 10, configLifetimeMs: 10,
  });
  assert.match(result.reason, /allowance is used up/u);
  assert.equal(result.stopped, false);
  assert.deepEqual(f.calls.revoked, [SID]);
});
