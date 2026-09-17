import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { connectionReporter, connectionStatusPath, readConnectionStatus, connectionIsLive } from "./connection-status.js";
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
  reporter.report({ type: "connecting", authorizationId: lease.authorizationId, mcpEnabled: true });
  let heartbeat!: () => void;
  const received = new Promise<void>((resolve) => { heartbeat = resolve; });
  runtime = serveConnection("ws://127.0.0.1:" + address.port, "synthetic-secret-token", binding.deviceId, null, lease,
    controller.signal, () => undefined, (event) => { reporter.report(event); if (event.type === "heartbeat") heartbeat(); });
  await received;
  await reporter.flush();
  const connected = await readConnectionStatus(binding); assert.ok(connected);
  assert.equal(connectionIsLive(connected), true);
  assert.equal(connected.mcpEnabled, true);
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
