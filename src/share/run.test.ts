import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { parseShareArguments, runShare, type FrpcProcess, type ShareDeps } from "./run.js";
import type { ShareGrant } from "./frpc-config.js";
import type { ShareControl, ShareHeartbeat } from "./control.js";

const grant = (expiresAt = new Date(Date.now() + 3600_000).toISOString()): ShareGrant => ({
  id: "frps_" + "ab".repeat(12), url: "https://s" + "0a".repeat(7) + ".share.example.test/?t=abc", expiresAt, node: "dmit-la", bandwidthBytesPerSecond: 1048576, remainingBytes: 100 * 1048576,
  frpc: { serverAddr: "203.0.113.7", serverPort: 7000, user: "frps_" + "ab".repeat(12), token: "frs_" + "T".repeat(43), proxyName: "share", subdomain: "s" + "0a".repeat(7) },
});

function fixture(options: { heartbeat?: () => Promise<ShareHeartbeat>; expiresAt?: string; probe?: boolean } = {}) {
  const log: string[] = [];
  const calls = { create: 0, revoke: [] as string[], killed: 0, configs: [] as string[], configAtStart: "" };
  const controller = new AbortController();
  let finishFrpc: (value: { code: number | null; stderr: string }) => void = () => undefined;
  const control: ShareControl = {
    async create() { calls.create += 1; return grant(options.expiresAt); },
    heartbeat: options.heartbeat ?? (async () => ({ active: true, remainingBytes: 1, expiresAt: "x" })),
    async revoke(id) { calls.revoke.push(id); },
  };
  const deps: ShareDeps = {
    control: async () => control,
    ensureFrpc: async () => "/fake/frpc",
    startGateway: async (gatewayOptions) => ({ server: undefined as never, port: 45678, close: async () => { log.push(`gateway closed for ${gatewayOptions.targetPort}`); } }),
    spawnFrpc: (_binary, configPath) => {
      calls.configs.push(configPath);
      void readFile(configPath, "utf8").then((text) => { calls.configAtStart = text; });
      const done = new Promise<{ code: number | null; stderr: string }>((resolve) => { finishFrpc = resolve; });
      return { done, kill: () => { calls.killed += 1; finishFrpc({ code: 0, stderr: "" }); } } satisfies FrpcProcess;
    },
    probe: async () => options.probe ?? true,
    write: (text) => { log.push(text); },
    signal: controller.signal,
    heartbeatMs: 20,
    configLifetimeMs: 30,
  };
  return { deps, calls, log, controller, finish: (value: { code: number | null; stderr: string }) => finishFrpc(value) };
}

test("arguments: a port, hours up to 24, and the flags", () => {
  assert.deepEqual(parseShareArguments(["3000"]), { port: 3000, rewriteHost: false, json: false });
  assert.deepEqual(parseShareArguments(["8080", "--ttl", "2", "--rewrite-host", "--json"]), { port: 8080, ttlHours: 2, rewriteHost: true, json: true });
  for (const bad of [[], ["0"], ["70000"], ["abc"], ["3000", "4000"], ["3000", "--ttl", "25"], ["3000", "--unknown"], ["3000", "--yes"]]) assert.throws(() => parseShareArguments(bad));
});

test("nothing listening is an error before anything is created", async () => {
  const closed = fixture({ probe: false });
  await assert.rejects(runShare({ port: 3000 }, closed.deps), /Nothing is listening on 127\.0\.0\.1:3000/u);
  assert.equal(closed.calls.create, 0);
});

test("a share prints its link, gives frpc a short-lived 0600 config, and on Ctrl+C stops frpc, closes the gateway and revokes the session", async () => {
  const f = fixture();
  const running = runShare({ port: 3000 }, f.deps);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(f.log.join(""), /Sharing http:\/\/127\.0\.0\.1:3000\n  https:\/\/s[0-9a-f]{14}\.share\.example\.test\/\?t=abc/u);
  assert.match(f.calls.configAtStart, /localPort = 45678/u);
  await assert.rejects(access(f.calls.configs[0]!), "the config with the token is removed shortly after frpc started");
  f.controller.abort();
  assert.equal(await running, 0);
  assert.equal(f.calls.killed, 1);
  assert.deepEqual(f.calls.revoke, [grant().id]);
  assert.ok(f.log.some((line) => line.includes("gateway closed for 3000")));
});

test("Frely ending the share (allowance used up) stops it with a message and a non-zero exit", async () => {
  const f = fixture({ heartbeat: async () => ({ active: false, reason: "quota_exhausted", remainingBytes: 0, expiresAt: "x" }) });
  assert.equal(await runShare({ port: 3000 }, f.deps), 1);
  assert.match(f.log.join(""), /allowance is used up; it renews on Monday \(UTC\)/u);
  assert.equal(f.calls.killed, 1);
});

test("frpc exiting, the link expiring and Frely being unreachable all end the share", async () => {
  const exited = fixture();
  const run = runShare({ port: 3000 }, exited.deps);
  await new Promise((resolve) => setTimeout(resolve, 50));
  exited.finish({ code: 1, stderr: "login to server failed: invalid session token" });
  assert.equal(await run, 1);
  assert.match(exited.log.join(""), /frpc exited with code 1: login to server failed/u);
  const expired = fixture({ expiresAt: new Date(Date.now() + 40).toISOString() });
  assert.equal(await runShare({ port: 3000 }, expired.deps), 1);
  assert.match(expired.log.join(""), /expired/u);
  const offline = fixture({ heartbeat: async () => { throw new Error("offline"); } });
  assert.equal(await runShare({ port: 3000 }, offline.deps), 1);
  assert.match(offline.log.join(""), /could not be reached/u);
});

test("--json prints one line with the link and no token", async () => {
  const f = fixture();
  const run = runShare({ port: 3000, json: true }, f.deps);
  await new Promise((resolve) => setTimeout(resolve, 60));
  f.controller.abort();
  await run;
  const line = JSON.parse(f.log.find((entry) => entry.startsWith("{"))!.trim());
  assert.equal(line.id, grant().id);
  assert.match(line.url, /^https:\/\//u);
  assert.ok(!JSON.stringify(line).includes("frs_"));
});
