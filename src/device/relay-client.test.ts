import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { DEVICE_RELAY_PROTOCOL, encodeDeviceRelayEnvelope, decodeDeviceRelayEnvelope } from "./protocol.js";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayMcpSession } from "../runtime/relay-mcp.js";
import { McpLease } from "../runtime/mcp-lease.js";
import { serveConnection } from "./relay-client.js";
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
