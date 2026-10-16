import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import { connectionReporter, connectionStatusPath, readConnectionStatus, connectionIsLive, type ConnectionStatus } from "./connection-status.js";
import { serveConnection } from "./relay-client.js";
import { DEVICE_RELAY_PROTOCOL } from "./protocol.js";
import type { DeviceBinding } from "./state.js";
import { McpLease } from "../runtime/mcp-lease.js";

test("real relay pong updates private status; lease disable and disconnect cannot remain ready", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "frely-relay-status-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  const binding: DeviceBinding = { version: 2, relayUrl: "https://test.invalid", userId: "test",
    deviceId: "drd_" + "a".repeat(32), publicKeySpki: "public", keyThumbprint: "public", updatedAt: new Date().toISOString() };
  const reporter = connectionReporter(binding, root);
  const lease = new McpLease("mca_" + "b".repeat(32), Date.now() + 60_000);
  const server = new WebSocketServer({ port: 0, handleProtocols: () => DEVICE_RELAY_PROTOCOL });
  const controller = new AbortController();
  let runtime: Promise<void> | undefined;
  t.after(async () => {
    controller.abort();
    await runtime;
    lease.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await reporter.flush();
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  reporter.report({ type: "connecting", authorizationId: lease.authorizationId, mcpEnabled: true, transport: "cloudflare_do" });
  let heartbeat!: () => void;
  const received = new Promise<void>((resolve) => { heartbeat = resolve; });
  runtime = serveConnection("ws://127.0.0.1:" + address.port, "synthetic-secret-token", binding.deviceId, null, lease,
    controller.signal, () => undefined, (event) => { reporter.report(event); if (event.type === "heartbeat") heartbeat(); });
  await received;
  await reporter.flush();
  const connected = await readConnectionStatus(binding); assert.ok(connected);
  assert.equal(connectionIsLive(connected), true);
  assert.equal(connected.mcpEnabled, true);
  assert.equal(connected.transport, "cloudflare_do");
  assert.equal(await readConnectionStatus({ ...binding, userId: "other" }), null);
  lease.close(); await reporter.flush();
  assert.equal((await readConnectionStatus(binding))?.mcpEnabled, false);
  reporter.report({ type: "disconnected", error: new Error("token=synthetic-secret-token") });
  await reporter.flush();
  const disconnected = await readConnectionStatus(binding); assert.ok(disconnected);
  assert.equal(connectionIsLive(disconnected), false);
  assert.doesNotMatch(await readFile(connectionStatusPath(), "utf8"), /synthetic-secret-token/);
  if (process.platform !== "win32") assert.equal((await stat(connectionStatusPath())).mode & 0o777, 0o600);
});

test("a terminal stop never erases a fresher record owned by a live transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-relay-status-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  const binding: DeviceBinding = { version: 2, relayUrl: "https://test.invalid", userId: "test",
    deviceId: "drd_" + "a".repeat(32), publicKeySpki: "public", keyThumbprint: "public", updatedAt: new Date().toISOString() };
  const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  const reporter = connectionReporter(binding, "/test/workspace");
  try {
    const foreign: ConnectionStatus = { version: 1, pid: live.pid!, relayUrl: binding.relayUrl, userId: binding.userId,
      deviceId: binding.deviceId, mcpEnabled: true, state: "connected", updatedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString() };
    await mkdir(dirname(connectionStatusPath()), { recursive: true, mode: 0o700 });
    await writeFile(connectionStatusPath(), `${JSON.stringify(foreign)}\n`, { mode: 0o600 });
    reporter.report({ type: "stopped" });
    await reporter.flush();
    assert.equal(JSON.parse(await readFile(connectionStatusPath(), "utf8")).pid, live.pid);
    live.kill();
    await new Promise<void>((resolve) => live.once("exit", resolve));
    reporter.report({ type: "stopped" });
    await reporter.flush();
    const stopped = await readConnectionStatus(binding);
    assert.equal(stopped?.state, "stopped");
    assert.equal(stopped?.pid, process.pid);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    live.kill();
    await rm(root, { recursive: true, force: true });
  }
});
