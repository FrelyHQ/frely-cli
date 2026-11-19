import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { DEVICE_RELAY_PROTOCOL, encodeDeviceRelayEnvelope, decodeDeviceRelayEnvelope } from "./protocol.js";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayMcpSession } from "../runtime/relay-mcp.js";
import { McpLease } from "../runtime/mcp-lease.js";
import { isTransportFallbackEligible, resumeAfterLogin, serveConnection } from "./relay-client.js";
import type { DeviceRelayEnvelope, DeviceRelayResponse } from "./protocol.js";

test("Device Relay websocket subprotocol can carry multiplexed envelopes", async () => {
  const server = new WebSocketServer({ port: 0, handleProtocols: (protocols) => protocols.has(DEVICE_RELAY_PROTOCOL) ? DEVICE_RELAY_PROTOCOL : false });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  const received = new Promise<void>((resolve, reject) => {
    server.once("connection", (socket) => {
      socket.once("message", (data) => {
        try {
          const envelope = decodeDeviceRelayEnvelope(Buffer.from(data as Buffer));
          assert.equal(envelope.type, "request");
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`, DEVICE_RELAY_PROTOCOL);
  await new Promise<void>((resolve, reject) => { client.once("open", () => resolve()); client.once("error", reject); });
  client.send(encodeDeviceRelayEnvelope({ protocol: DEVICE_RELAY_PROTOCOL, type: "request", id: "abcdefghijklmnop", method: "mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } }));
  await received;
  client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("real Relay frames isolate reused client IDs and cancel only the addressed command", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "frely-relay-wire-"));
  const lines: string[] = [];
  const log = (line: string) => { lines.push(line); };
  const lease = new McpLease(`mca_${"a".repeat(32)}`, Date.now() + 60_000);
  const session = await RelayMcpSession.create(workspace, { log, signal: lease.controller.signal, assertAuthorized: () => lease.assert() });
  const server = new WebSocketServer({ port: 0, handleProtocols: () => DEVICE_RELAY_PROTOCOL });
  const listening = new Promise<void>((resolve) => server.once("listening", resolve));
  const controller = new AbortController();
  let socket: WebSocket | undefined;
  let runtime: Promise<void> | undefined;
  const responses = new Map<string, DeviceRelayResponse>();
  const waiters = new Map<string, (response: DeviceRelayResponse) => void>();
  const response = (id: string) => new Promise<DeviceRelayResponse>((resolve) => {
    const received = responses.get(id);
    if (received) resolve(received); else waiters.set(id, resolve);
  });
  const send = (envelope: DeviceRelayEnvelope) => socket!.send(encodeDeviceRelayEnvelope(envelope));
  const call = (id: string, name: string, args: Record<string, unknown> = {}) => send({
    protocol: DEVICE_RELAY_PROTOCOL, type: "request", id, method: "mcp", authorizationId: lease.authorizationId,
    payload: { jsonrpc: "2.0", id: 0, method: "tools/call", params: { name, arguments: args } },
  });
  try {
    await writeFile(join(workspace, "a.txt"), "client A");
    await writeFile(join(workspace, "b.txt"), "client B");
    await writeFile(join(workspace, "hold.cjs"), 'require("node:fs").writeFileSync("ready", String(process.pid)); setInterval(() => {}, 1000);');
    await listening;
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const connected = new Promise<WebSocket>((resolve) => server.once("connection", (peer) => {
      peer.on("message", (data) => {
        const envelope = decodeDeviceRelayEnvelope(Buffer.from(data as Buffer));
        if (envelope.type !== "response") return;
        responses.set(envelope.id, envelope);
        waiters.get(envelope.id)?.(envelope);
        waiters.delete(envelope.id);
      });
      resolve(peer);
    }));
    runtime = serveConnection(`ws://127.0.0.1:${address.port}`, "synthetic-test-token", `drd_${"a".repeat(32)}`, session, lease, controller.signal, log);
    void runtime.catch(() => undefined);
    socket = await connected;
    call("relay-request-aaa", "read_file", { path: "a.txt" });
    call("relay-request-bbb", "read_file", { path: "b.txt" });
    for (const [id, text] of [["relay-request-aaa", "client A"], ["relay-request-bbb", "client B"]]) {
      const result = await response(id!);
      assert.equal(result.ok, true);
      assert.deepEqual(result.payload, { jsonrpc: "2.0", id: 0, result: { content: [{ type: "text", text }] } });
    }
    call("relay-request-ccc", "run_command", { command: "node hold.cjs", timeoutMs: 5000 });
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
      pid = await readFile(join(workspace, "ready"), "utf8").then(Number, () => 0);
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(pid > 0, "command must start before cancellation");
    send({ protocol: DEVICE_RELAY_PROTOCOL, type: "cancel", id: "relay-request-ccc" });
    call("relay-request-ddd", "workspace_info");
    const survivor = await response("relay-request-ddd");
    assert.equal(survivor.ok, true);
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try { process.kill(pid, 0); } catch { alive = false; }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(alive, false, "the cancelled command's process must exit");
    assert.equal(responses.has("relay-request-ccc"), false);
    send({ protocol: DEVICE_RELAY_PROTOCOL, type: "request", id: "relay-request-eee", method: "mcp", authorizationId: lease.authorizationId, payload: { jsonrpc: "wrong", id: 0, method: "tools/list" } });
    assert.equal((await response("relay-request-eee")).error?.code, "mcp_execution_failed");
    const failures = lines.map((line) => JSON.parse(line)).filter((event) => event.event === "relay.request_failed");
    assert.ok(failures.some((event) => event.requestId === "relay-request-eee" && event.error.stack.length > 0));
    assert.doesNotMatch(lines.join("\n"), /synthetic-test-token|hold\.cjs|client A|client B/);
  } finally {
    controller.abort();
    await runtime;
    lease.close();
    await session.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  }
});

test("transport fallback is reserved for transport failures", async () => {
  async function closeWith(code: number, reason: string) {
    const server = new WebSocketServer({ port: 0, handleProtocols: () => DEVICE_RELAY_PROTOCOL });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const connected = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
    const controller = new AbortController();
    const runtime = serveConnection(
      `ws://127.0.0.1:${address.port}`,
      "synthetic-test-token",
      `drd_${"a".repeat(32)}`,
      null,
      null,
      controller.signal,
      () => undefined,
    );
    const socket = await connected;
    socket.close(code, reason);
    const error = await runtime.then(() => null, (value: unknown) => value);
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.ok(error instanceof Error);
    return error;
  }

  const lifecycle = await closeWith(4412, "hard_lifetime");
  assert.equal(isTransportFallbackEligible(lifecycle), false);

  const unavailable = await closeWith(4500, "edge_unavailable");
  assert.equal(isTransportFallbackEligible(unavailable), true);
});

test("device reports capabilities once per connection", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "frely-relay-caps-"));
  const lease = new McpLease(`mca_${"a".repeat(32)}`, Date.now() + 60_000);
  const session = await RelayMcpSession.create(workspace, {
    log: () => undefined,
    signal: lease.controller.signal,
    assertAuthorized: () => lease.assert(),
  });
  const server = new WebSocketServer({ port: 0, handleProtocols: () => DEVICE_RELAY_PROTOCOL });
  const listening = new Promise<void>((resolve) => server.once("listening", resolve));
  const controller = new AbortController();
  const frames: DeviceRelayEnvelope[] = [];
  try {
    await listening;
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const connected = new Promise<WebSocket>((resolve) => server.once("connection", (peer) => {
      peer.on("message", (data) => {
        const envelope = decodeDeviceRelayEnvelope(Buffer.from(data as Buffer));
        frames.push(envelope);
        if (envelope.type !== "response") return;
        peer.send(encodeDeviceRelayEnvelope(envelope));
      });
      resolve(peer);
    }));
    const runtime = serveConnection(`ws://127.0.0.1:${address.port}`, "synthetic-test-token", `drd_${"a".repeat(32)}`, session, lease, controller.signal, () => undefined, () => undefined, undefined, () => ({ app: { installed: true, version: "0.4.0" }, sandbox: "none" }));
    void runtime.catch(() => undefined);
    await connected;

    // The capability report must arrive without any request from the relay.
    const reported = await new Promise<DeviceRelayEnvelope>((resolve) => {
      const poll = () => {
        const found = frames.find((frame) => frame.type === "device_capabilities");
        if (found) resolve(found); else setTimeout(poll, 10);
      };
      poll();
    });
    assert.equal(reported.type, "device_capabilities");
    // The lease this connection serves under rides along, so the web can tell a lease that ended on the computer.
    assert.deepEqual((reported as { capabilities: Record<string, unknown> }).capabilities, { app: { installed: true, version: "0.4.0" }, sandbox: "none",
      mcpLease: { id: `mca_${"a".repeat(32)}`, expiresAt: new Date(lease.expiresAt).toISOString(), active: true } });

  } finally {
    controller.abort();
    lease.close();
    await session.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  }
});

test("relay restart close codes retry about every 2 seconds for ten minutes, then back off", async () => {
  const { nextReconnectDelay, RELAY_RESTART_RETRY_WINDOW_MS } = await import("./relay-client.js");
  const closed = (code: number) => new Promise<unknown>((resolve) => {
    const server = new WebSocketServer({ port: 0, handleProtocols: () => DEVICE_RELAY_PROTOCOL });
    server.once("connection", (peer) => peer.close(code, "restart"));
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test address");
      const abort = new AbortController();
      serveConnection(`ws://127.0.0.1:${address.port}`, "t", `drd_${"a".repeat(32)}`, null, null, abort.signal, () => undefined)
        .catch((error: unknown) => { server.close(); resolve(error); });
    });
  });
  const restart = await closed(1012);
  assert.equal(isTransportFallbackEligible(restart), false);
  const first = nextReconnectDelay({ backoffMs: 8000 }, restart, 1_000, () => 0.5);
  assert.equal(first.delayMs, 2000);
  assert.equal(first.backoffMs, 8000);
  // Plain connection failures inside the window keep the fast cadence.
  const during = nextReconnectDelay({ backoffMs: 8000, restartSince: first.restartSince }, new Error("refused"), 1_000 + 5 * 60_000, () => 0);
  assert.equal(during.delayMs, 1600);
  // After the window the exponential backoff resumes.
  const after = nextReconnectDelay({ backoffMs: 8000, restartSince: first.restartSince }, new Error("refused"), 1_000 + RELAY_RESTART_RETRY_WINDOW_MS, () => 0);
  assert.equal(after.delayMs, 6400); // 8000 minus 20% jitter at random()=0
  assert.equal(after.backoffMs, 15_000);
  assert.equal(after.restartSince, undefined);
  // 1001 counts as restart too; other codes do not.
  assert.equal(nextReconnectDelay({ backoffMs: 4000 }, await closed(1001), 0, () => 0).delayMs, 1600);
  assert.equal(nextReconnectDelay({ backoffMs: 4000 }, await closed(1011), 0, () => 0).delayMs, 3200);
  // Backoff delays are spread by +-20%: 0.8x..1.2x of the nominal step.
  const plain = new Error("refused");
  assert.equal(nextReconnectDelay({ backoffMs: 4000 }, plain, 0, () => 0.5).delayMs, 4000);
  assert.equal(nextReconnectDelay({ backoffMs: 4000 }, plain, 0, () => 1).delayMs, 4800);
  assert.equal(nextReconnectDelay({ backoffMs: 4000 }, plain, 0, () => 0.5).backoffMs, 8000);
});

test("a relay that goes silent is detected without waiting for the OS", async () => {
  const server = new WebSocketServer({ port: 0, handleProtocols: () => DEVICE_RELAY_PROTOCOL });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  const connected = new Promise<void>((resolve) => server.once("connection", () => resolve()));
  const abort = new AbortController();
  const lines: string[] = [];
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  try {
    const runtime = serveConnection(`ws://127.0.0.1:${address.port}`, "t", `drd_${"a".repeat(32)}`, null, null, abort.signal, (line) => lines.push(line));
    const failed = runtime.then(() => undefined, (error: unknown) => error);
    await connected;
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(30_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lines.some((line) => line.includes("relay.socket_closed")), false);
    mock.timers.tick(20_000);
    const error = await failed;
    assert.match(String((error as Error).message), /heartbeat timed out/);
    assert.ok(isTransportFallbackEligible(error));
    assert.ok(lines.some((line) => line.includes("relay.socket_closed")));
  } finally {
    mock.timers.reset();
    abort.abort();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("retry-now cuts the reconnect delay short and is removed on abort", async () => {
  const { createRetryNow, RETRY_NOW_SIGNAL } = await import("./relay-client.js");
  // A stand-in emitter: emitting SIGUSR2 on the real process would also fire a runner's --report-signal handler and drop a report file.
  const { EventEmitter } = await import("node:events");
  const fake = new EventEmitter();
  const controller = new AbortController();
  const retry = createRetryNow(controller.signal, "linux", fake as unknown as NodeJS.Process);
  let fired = false;
  retry.arm(() => { fired = true; });
  fake.emit(RETRY_NOW_SIGNAL);
  assert.equal(fired, true);
  controller.abort();
  assert.equal(fake.listenerCount(RETRY_NOW_SIGNAL), 0);
  // Windows has no signals: nothing is registered.
  const win = new EventEmitter();
  createRetryNow(new AbortController().signal, "win32", win as unknown as NodeJS.Process);
  assert.equal(win.listenerCount(RETRY_NOW_SIGNAL), 0);
});

test("a connection replaced by another process (4409) waits a minute instead of taking the device back at once", async () => {
  const { nextReconnectDelay, isConnectionReplacedClose, RELAY_REPLACED_RETRY_MS } = await import("./relay-client.js");
  const error = await new Promise<unknown>((resolve) => {
    const server = new WebSocketServer({ port: 0, handleProtocols: () => DEVICE_RELAY_PROTOCOL });
    server.once("connection", (peer) => peer.close(4409, "connection_replaced"));
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test address");
      serveConnection(`ws://127.0.0.1:${address.port}`, "t", `drd_${"a".repeat(32)}`, null, null, new AbortController().signal, () => undefined)
        .catch((failure: unknown) => { server.close(); resolve(failure); });
    });
  });
  assert.equal(isConnectionReplacedClose(error), true);
  assert.equal(isTransportFallbackEligible(error), false);
  const next = nextReconnectDelay({ backoffMs: 1000 }, error, 0, () => 0);
  assert.equal(next.delayMs, RELAY_REPLACED_RETRY_MS);
  assert.equal(isConnectionReplacedClose(new Error("refused")), false);
});

test("after the login expired, the relay waits for a new login, verifies it once and reconnects; the dead login is never sent again", async () => {
  const abort = new AbortController();
  let stored: string | null = "dead";
  let checks = 0, reconnects = 0, rounds = 0;
  const done = resumeAfterLogin({
    failed: "dead", signal: abort.signal, intervalMs: 5, log: () => undefined,
    fingerprint: async () => { rounds += 1; if (rounds === 4) stored = "rejected"; if (rounds === 7) stored = "fresh"; return stored; },
    check: async () => { checks += 1; if (stored === "rejected") throw new Error("Frely login expired. Run `frely login`."); },
    reconnect: () => { reconnects += 1; },
  });
  await done;
  // Unchanged login: no check. A new login the server refuses: one check, then wait for the next change.
  assert.equal(checks, 2);
  assert.equal(reconnects, 1);
  abort.abort();
});

test("waiting for a new login ends with the connection, and stops when the authorization itself is gone", async () => {
  const abort = new AbortController();
  let checks = 0;
  const waiting = resumeAfterLogin({ failed: "dead", signal: abort.signal, intervalMs: 5, log: () => undefined,
    fingerprint: async () => "dead", check: async () => { checks += 1; }, reconnect: () => assert.fail("must not reconnect") });
  setTimeout(() => abort.abort(), 30);
  await waiting;
  assert.equal(checks, 0);
  let reconnects = 0;
  await resumeAfterLogin({ failed: "dead", signal: new AbortController().signal, intervalMs: 5, log: () => undefined,
    fingerprint: async () => "fresh", check: async () => { throw new Error("MCP authorization changed. Run frely link on --days 90 to renew."); }, reconnect: () => { reconnects += 1; } });
  assert.equal(reconnects, 0);
});
