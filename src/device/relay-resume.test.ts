import test from "node:test";
import assert from "node:assert/strict";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { DEVICE_RELAY_PROTOCOL, decodeDeviceRelayEnvelope, encodeDeviceRelayEnvelope, type DeviceRelayEnvelope } from "./protocol.js";
import { McpLease } from "../runtime/mcp-lease.js";
import type { RelaySession } from "../runtime/relay-session.js";
import { RELAY_PONG_TIMEOUT_MS, RELAY_SILENCE_LIMIT_MS, heartbeatExpired, serveConnection } from "./relay-client.js";
import { RelayResume } from "./relay-resume.js";

const AUTHORIZATION = `mca_${"a".repeat(32)}`;
const DEVICE = `drd_${"a".repeat(32)}`;
const REQUEST = "relay-request-resume-1";

class FakeSession implements RelaySession {
  cancelled: string[] = [];
  closed = false;
  private release: (value: unknown) => void = () => undefined;
  private startedResolve: () => void = () => undefined;
  readonly started = new Promise<void>((resolve) => { this.startedResolve = resolve; });
  execute(): Promise<unknown> {
    this.startedResolve();
    return new Promise((resolve) => { this.release = resolve; });
  }
  finish(): void { this.release({ jsonrpc: "2.0", id: 0, result: { content: [{ type: "text", text: "done after reconnect" }] } }); }
  cancel(id: string): void { this.cancelled.push(id); }
  async close(): Promise<void> { this.closed = true; }
}

async function relay() {
  const server = new WebSocketServer({ port: 0, handleProtocols: () => DEVICE_RELAY_PROTOCOL });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}`;
  const next = () => new Promise<{ peer: WebSocket; frames: DeviceRelayEnvelope[] }>((resolve) => server.once("connection", (peer) => {
    const frames: DeviceRelayEnvelope[] = [];
    peer.on("message", (data: RawData) => { frames.push(decodeDeviceRelayEnvelope(Buffer.from(data as Buffer))); });
    resolve({ peer, frames });
  }));
  const close = async () => { for (const client of server.clients) client.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); };
  return { url, next, close };
}

const waitFor = async (predicate: () => boolean, ms = 3_000) => {
  const until = Date.now() + ms;
  while (!predicate() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), "condition not reached in time");
};

const requestFrame = (): DeviceRelayEnvelope => ({ protocol: DEVICE_RELAY_PROTOCOL, type: "request", id: REQUEST, method: "mcp", authorizationId: AUTHORIZATION,
  payload: { jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "run_command", arguments: {} } } });

test("a command that was running when the connection dropped answers on the next connection, before anything else", async () => {
  const { url, next, close } = await relay();
  const resume = new RelayResume(true);
  const lease = new McpLease(AUTHORIZATION, Date.now() + 60_000);
  const session = new FakeSession();
  const controller = new AbortController();
  try {
    const first = next();
    const one = serveConnection(url, "t", DEVICE, session, lease, controller.signal, () => undefined, () => undefined, undefined, undefined, resume);
    one.catch(() => undefined);
    const firstPeer = await first;
    firstPeer.peer.send(encodeDeviceRelayEnvelope(requestFrame()));
    await session.started;
    firstPeer.peer.terminate();
    await assert.rejects(one);
    assert.equal(session.cancelled.length, 0, "the command keeps running");
    assert.equal(resume.retire(session, lease), true, "its session is kept for it");

    session.finish();
    await waitFor(() => resume.inflight.size === 0);
    const second = next();
    const two = serveConnection(url, "t", DEVICE, null, null, controller.signal, () => undefined, () => undefined, undefined, () => ({ resumable: true }), resume);
    two.catch(() => undefined);
    const secondPeer = await second;
    await waitFor(() => secondPeer.frames.length >= 2);
    assert.deepEqual(secondPeer.frames[0], { protocol: DEVICE_RELAY_PROTOCOL, type: "response", id: REQUEST, ok: true,
      payload: { jsonrpc: "2.0", id: 0, result: { content: [{ type: "text", text: "done after reconnect" }] } } });
    assert.equal(secondPeer.frames[1]?.type, "device_capabilities");
    assert.equal(session.closed, true, "the parked session is closed once its command has finished");
    controller.abort();
    await two;
  } finally { lease.close(); await close(); }
});

test("a queued result that the relay cancelled is never sent", async () => {
  const { url, next, close } = await relay();
  const resume = new RelayResume(true);
  const lease = new McpLease(AUTHORIZATION, Date.now() + 60_000);
  const session = new FakeSession();
  const controller = new AbortController();
  try {
    const first = next();
    const one = serveConnection(url, "t", DEVICE, session, lease, controller.signal, () => undefined, () => undefined, undefined, undefined, resume);
    one.catch(() => undefined);
    const firstPeer = await first;
    firstPeer.peer.send(encodeDeviceRelayEnvelope(requestFrame()));
    await session.started;
    firstPeer.peer.terminate();
    await assert.rejects(one);
    session.finish();
    await waitFor(() => resume.inflight.size === 0);
    resume.dropQueued(REQUEST);
    const second = next();
    const two = serveConnection(url, "t", DEVICE, null, null, controller.signal, () => undefined, () => undefined, undefined, undefined, resume);
    two.catch(() => undefined);
    const secondPeer = await second;
    await waitFor(() => secondPeer.frames.some((frame) => frame.type === "device_capabilities"));
    assert.equal(secondPeer.frames.some((frame) => frame.type === "response"), false);
    controller.abort();
    await two;
  } finally { lease.close(); await close(); }
});

test("a relay restart (1012) cancels running commands instead of keeping them", async () => {
  const { url, next, close } = await relay();
  const resume = new RelayResume(true);
  const lease = new McpLease(AUTHORIZATION, Date.now() + 60_000);
  const session = new FakeSession();
  const controller = new AbortController();
  try {
    const first = next();
    const one = serveConnection(url, "t", DEVICE, session, lease, controller.signal, () => undefined, () => undefined, undefined, undefined, resume);
    one.catch(() => undefined);
    const firstPeer = await first;
    firstPeer.peer.send(encodeDeviceRelayEnvelope(requestFrame()));
    await session.started;
    firstPeer.peer.close(1012, "service_restart");
    await assert.rejects(one);
    assert.deepEqual(session.cancelled, [REQUEST]);
  } finally { lease.close(); controller.abort(); await close(); }
});

test("without a resume object a drop cancels running commands as before", async () => {
  const { url, next, close } = await relay();
  const lease = new McpLease(AUTHORIZATION, Date.now() + 60_000);
  const session = new FakeSession();
  const controller = new AbortController();
  try {
    const first = next();
    const one = serveConnection(url, "t", DEVICE, session, lease, controller.signal, () => undefined);
    one.catch(() => undefined);
    const firstPeer = await first;
    firstPeer.peer.send(encodeDeviceRelayEnvelope(requestFrame()));
    await session.started;
    firstPeer.peer.terminate();
    await assert.rejects(one);
    assert.deepEqual(session.cancelled, [REQUEST]);
  } finally { lease.close(); controller.abort(); await close(); }
});

test("commands that nobody collects are cancelled after the retain period", async () => {
  const { url, next, close } = await relay();
  const resume = new RelayResume(true, undefined, 150);
  const lease = new McpLease(AUTHORIZATION, Date.now() + 60_000);
  const session = new FakeSession();
  const controller = new AbortController();
  try {
    const first = next();
    const one = serveConnection(url, "t", DEVICE, session, lease, controller.signal, () => undefined, () => undefined, undefined, undefined, resume);
    one.catch(() => undefined);
    const firstPeer = await first;
    firstPeer.peer.send(encodeDeviceRelayEnvelope(requestFrame()));
    await session.started;
    firstPeer.peer.terminate();
    await assert.rejects(one);
    assert.equal(session.cancelled.length, 0);
    await waitFor(() => session.cancelled.length === 1);
    assert.deepEqual(session.cancelled, [REQUEST]);
  } finally { lease.close(); controller.abort(); await close(); }
});

test("a replaced or revoked connection (4409) cancels running commands instead of keeping them", async () => {
  const { url, next, close } = await relay();
  const resume = new RelayResume(true);
  const lease = new McpLease(AUTHORIZATION, Date.now() + 60_000);
  const session = new FakeSession();
  const controller = new AbortController();
  try {
    const first = next();
    const one = serveConnection(url, "t", DEVICE, session, lease, controller.signal, () => undefined, () => undefined, undefined, undefined, resume);
    one.catch(() => undefined);
    const firstPeer = await first;
    firstPeer.peer.send(encodeDeviceRelayEnvelope(requestFrame()));
    await session.started;
    firstPeer.peer.close(4409, "connection_replaced");
    await assert.rejects(one);
    assert.deepEqual(session.cancelled, [REQUEST]);
  } finally { lease.close(); controller.abort(); await close(); }
});

test("an unanswered ping marks the socket dead after the pong timeout, even while the relay's own pings keep arriving", () => {
  const now = 1_000_000;
  assert.equal(heartbeatExpired(now, now - 1_000, undefined), false);
  assert.equal(heartbeatExpired(now, now - 1_000, now - RELAY_PONG_TIMEOUT_MS + 1), false);
  assert.equal(heartbeatExpired(now, now - 1_000, now - RELAY_PONG_TIMEOUT_MS - 1), true);
  assert.equal(heartbeatExpired(now, now - RELAY_SILENCE_LIMIT_MS - 1, undefined), true);
});
