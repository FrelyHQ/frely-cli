import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import { DEVICE_RELAY_DEFAULT_MAX_INFLIGHT, DEVICE_RELAY_PROTOCOL, decodeDeviceRelayEnvelope, encodeDeviceRelayEnvelope } from "./protocol.js";
import type { DeviceRelayEnvelope, DeviceRelayResponse } from "./protocol.js";
import { McpLease } from "../runtime/mcp-lease.js";
import type { RelaySession } from "../runtime/relay-session.js";
import { RELAY_OUTBOX_TTL_MS, createRelayCarry, deliverResponse, resumeOrRelease, serveConnection } from "./relay-client.js";

const deviceId = `drd_${"a".repeat(32)}`;
const authorizationId = `mca_${"a".repeat(32)}`;

/** A session whose commands finish when the test says so. */
function fakeSession() {
  const pending = new Map<string, (value: unknown) => void>();
  const executed: string[] = [];
  const cancelled: string[] = [];
  let closed = false;
  const session: RelaySession = {
    execute: (_payload, relayId) => { executed.push(relayId); return new Promise((resolve) => pending.set(relayId, resolve)); },
    cancel: (relayId) => { cancelled.push(relayId); },
    close: async () => { closed = true; },
  };
  return { session, executed, cancelled, finish: (id: string, value: unknown = { done: id }) => pending.get(id)?.(value), isClosed: () => closed };
}

async function relay() {
  const server = new WebSocketServer({ port: 0, handleProtocols: () => DEVICE_RELAY_PROTOCOL });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    /** Resolves with the next device connection and everything it sends. */
    next: () => new Promise<{ peer: WebSocket; frames: DeviceRelayEnvelope[] }>((resolve) => server.once("connection", (peer) => {
      const frames: DeviceRelayEnvelope[] = [];
      peer.on("message", (data) => frames.push(decodeDeviceRelayEnvelope(Buffer.from(data as Buffer))));
      resolve({ peer, frames });
    })),
    close: async () => { for (const client of server.clients) client.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

const request = (id: string, method: "mcp" | "provider" = "mcp"): DeviceRelayEnvelope => ({
  protocol: DEVICE_RELAY_PROTOCOL, type: "request", id, method, authorizationId, payload: { jsonrpc: "2.0", id: 0, method: "tools/list" },
});
const until = async (condition: () => boolean) => { for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); assert.ok(condition(), "condition not reached"); };
const responses = (frames: DeviceRelayEnvelope[]) => frames.filter((frame): frame is DeviceRelayResponse => frame.type === "response");
const settled = (promise: Promise<void>) => promise.then(() => undefined, () => undefined);

test("an MCP command survives a dropped connection and its result is sent on the next one with the same id", async () => {
  const relayServer = await relay();
  const fake = fakeSession();
  const lease = new McpLease(authorizationId, Date.now() + 60_000);
  const carry = createRelayCarry();
  const abort = new AbortController();
  const lines: string[] = [];
  const log = (line: string) => { lines.push(line); };
  try {
    const first = relayServer.next();
    const run1 = settled(serveConnection(relayServer.url, "t", deviceId, fake.session, lease, abort.signal, log, undefined, undefined, undefined, carry));
    const one = await first;
    await until(() => carry.socket !== undefined);
    one.peer.send(encodeDeviceRelayEnvelope(request("relay-request-0001")));
    await until(() => fake.executed.includes("relay-request-0001"));
    one.peer.terminate();
    await run1;
    assert.deepEqual(fake.cancelled, []);
    assert.equal(carry.inflight.get("relay-request-0001")?.controller.signal.aborted, false);
    assert.ok(lines.some((line) => line.includes("relay.inflight_carried")));
    assert.ok(!lines.some((line) => line.includes("relay.inflight_cancelled")));

    // Finishes while nothing is connected: parked in the outbox.
    fake.finish("relay-request-0001");
    await until(() => carry.outbox.has("relay-request-0001"));

    const second = relayServer.next();
    const run2 = settled(serveConnection(relayServer.url, "t", deviceId, fake.session, lease, abort.signal, log, undefined, undefined, undefined, carry));
    const two = await second;
    await until(() => responses(two.frames).length === 1);
    const [sent] = responses(two.frames);
    assert.equal(sent?.id, "relay-request-0001");
    assert.equal(sent?.ok, true);
    assert.deepEqual(sent?.payload, { done: "relay-request-0001" });
    assert.deepEqual(fake.executed, ["relay-request-0001"], "nothing may run twice");
    assert.equal(carry.outbox.size, 0);
    abort.abort();
    await run2;
  } finally {
    abort.abort();
    lease.close();
    await relayServer.close();
  }
});

test("a command still running when the next connection opens answers on that connection", async () => {
  const relayServer = await relay();
  const fake = fakeSession();
  const lease = new McpLease(authorizationId, Date.now() + 60_000);
  const carry = createRelayCarry();
  const abort = new AbortController();
  try {
    const first = relayServer.next();
    const run1 = settled(serveConnection(relayServer.url, "t", deviceId, fake.session, lease, abort.signal, () => undefined, undefined, undefined, undefined, carry));
    const one = await first;
    await until(() => carry.socket !== undefined);
    one.peer.send(encodeDeviceRelayEnvelope(request("relay-request-0002")));
    await until(() => fake.executed.length === 1);
    one.peer.terminate();
    await run1;

    const second = relayServer.next();
    const run2 = settled(serveConnection(relayServer.url, "t", deviceId, fake.session, lease, abort.signal, () => undefined, undefined, undefined, undefined, carry));
    const two = await second;
    // The carried id still counts as in flight.
    two.peer.send(encodeDeviceRelayEnvelope(request("relay-request-0002")));
    await until(() => responses(two.frames).some((frame) => frame.error?.code === "duplicate_request"));
    fake.finish("relay-request-0002");
    await until(() => responses(two.frames).some((frame) => frame.id === "relay-request-0002" && frame.ok));
    assert.equal(fake.executed.length, 1);
    abort.abort();
    await run2;
  } finally {
    abort.abort();
    lease.close();
    await relayServer.close();
  }
});

test("a cancel for an old id on the new connection aborts the carried request", async () => {
  const relayServer = await relay();
  const fake = fakeSession();
  const lease = new McpLease(authorizationId, Date.now() + 60_000);
  const carry = createRelayCarry();
  const abort = new AbortController();
  try {
    const first = relayServer.next();
    const run1 = settled(serveConnection(relayServer.url, "t", deviceId, fake.session, lease, abort.signal, () => undefined, undefined, undefined, undefined, carry));
    const one = await first;
    await until(() => carry.socket !== undefined);
    one.peer.send(encodeDeviceRelayEnvelope(request("relay-request-0003")));
    await until(() => fake.executed.length === 1);
    one.peer.terminate();
    await run1;

    const second = relayServer.next();
    const run2 = settled(serveConnection(relayServer.url, "t", deviceId, fake.session, lease, abort.signal, () => undefined, undefined, undefined, undefined, carry));
    const two = await second;
    const controller = carry.inflight.get("relay-request-0003")!.controller;
    two.peer.send(encodeDeviceRelayEnvelope({ protocol: DEVICE_RELAY_PROTOCOL, type: "cancel", id: "relay-request-0003" }));
    await until(() => fake.cancelled.includes("relay-request-0003"));
    assert.equal(controller.signal.aborted, true);
    fake.finish("relay-request-0003");
    await until(() => carry.inflight.size === 0);
    assert.equal(responses(two.frames).length, 0, "a cancelled request sends no result");
    abort.abort();
    await run2;
  } finally {
    abort.abort();
    lease.close();
    await relayServer.close();
  }
});

test("provider requests are still aborted when the connection drops; stopping aborts MCP commands", async () => {
  for (const stop of [false, true]) {
    const relayServer = await relay();
    const fake = fakeSession();
    const lease = new McpLease(authorizationId, Date.now() + 60_000);
    const carry = createRelayCarry();
    const abort = new AbortController();
    const provider = new AbortController();
    const mcp = new AbortController();
    const base = { protocol: DEVICE_RELAY_PROTOCOL, type: "request", payload: {} } as const;
    carry.inflight.set("relay-provider-0001", { request: { ...base, id: "relay-provider-0001", method: "provider" }, controller: provider });
    carry.inflight.set("relay-request-0004", { request: { ...base, id: "relay-request-0004", method: "mcp", authorizationId }, controller: mcp });
    try {
      const connected = relayServer.next();
      const run = settled(serveConnection(relayServer.url, "t", deviceId, fake.session, lease, abort.signal, () => undefined, undefined, undefined, undefined, carry));
      const { peer } = await connected;
      await until(() => carry.socket !== undefined);
      if (stop) abort.abort(); else peer.terminate();
      await run;
      assert.equal(provider.signal.aborted, true);
      assert.equal(mcp.signal.aborted, stop);
      assert.deepEqual(fake.cancelled, stop ? ["relay-request-0004"] : []);
    } finally {
      abort.abort();
      lease.close();
      await relayServer.close();
    }
  }
});

test("a closed lease aborts carried commands instead of keeping them", async () => {
  const relayServer = await relay();
  const fake = fakeSession();
  const lease = new McpLease(authorizationId, Date.now() + 60_000);
  const carry = createRelayCarry();
  const mcp = new AbortController();
  carry.inflight.set("relay-request-0005", { request: { protocol: DEVICE_RELAY_PROTOCOL, type: "request", id: "relay-request-0005", method: "mcp", authorizationId, payload: {} }, controller: mcp });
  const abort = new AbortController();
  try {
    const connected = relayServer.next();
    const run = settled(serveConnection(relayServer.url, "t", deviceId, fake.session, lease, abort.signal, () => undefined, undefined, undefined, undefined, carry));
    const { peer } = await connected;
    await until(() => carry.socket !== undefined);
    lease.close();
    peer.terminate();
    await run;
    assert.equal(mcp.signal.aborted, true);
  } finally {
    abort.abort();
    await relayServer.close();
  }
});

test("a different MCP authorization aborts carried commands and drops their results; the same one keeps them", async () => {
  for (const sameAuthorization of [true, false]) {
    const fake = fakeSession();
    const lease = new McpLease(authorizationId, Date.now() + 60_000);
    const carry = createRelayCarry();
    const mcp = new AbortController();
    carry.inflight.set("relay-request-0006", { request: { protocol: DEVICE_RELAY_PROTOCOL, type: "request", id: "relay-request-0006", method: "mcp", authorizationId, payload: {} }, controller: mcp });
    carry.outbox.set("relay-request-0007", { envelope: { protocol: DEVICE_RELAY_PROTOCOL, type: "response", id: "relay-request-0007", ok: true }, at: Date.now() });
    const held = { session: fake.session, lease };
    const next = sameAuthorization ? authorizationId : `mca_${"b".repeat(32)}`;
    const resumed = await resumeOrRelease(carry, held, next, () => undefined, "authorization_changed");
    if (sameAuthorization) {
      assert.equal(resumed, held);
      assert.equal(mcp.signal.aborted, false);
      assert.equal(carry.outbox.size, 1);
      assert.equal(fake.isClosed(), false);
    } else {
      assert.equal(resumed, undefined);
      assert.equal(mcp.signal.aborted, true);
      assert.deepEqual(fake.cancelled, ["relay-request-0006"]);
      assert.equal(carry.outbox.size, 0);
      assert.equal(fake.isClosed(), true);
      assert.equal(lease.controller.signal.aborted, true);
    }
    lease.close();
  }
});

test("the outbox is bounded by count and age, and keeps oversized results small", () => {
  const lines: string[] = [];
  const log = (line: string) => { lines.push(line); };
  const carry = createRelayCarry();
  const response = (id: string, payload?: unknown): DeviceRelayResponse => ({ protocol: DEVICE_RELAY_PROTOCOL, type: "response", id, ok: true, ...(payload !== undefined ? { payload } : {}) });
  for (let i = 0; i < DEVICE_RELAY_DEFAULT_MAX_INFLIGHT + 6; i++) deliverResponse(carry, response(`relay-request-${String(i).padStart(4, "0")}`), log);
  assert.equal(carry.outbox.size, DEVICE_RELAY_DEFAULT_MAX_INFLIGHT);
  assert.equal(carry.outbox.has("relay-request-0000"), false);
  assert.equal(lines.filter((line) => line.includes("relay.outbox_dropped.limit")).length, 6);

  const big = createRelayCarry();
  deliverResponse(big, response("relay-request-big0", "x".repeat(9 * 1024 * 1024)), log);
  assert.equal(big.outbox.get("relay-request-big0")?.envelope.error?.code, "response_too_large");

  mock.timers.enable({ apis: ["Date"] });
  try {
    const aged = createRelayCarry();
    deliverResponse(aged, response("relay-request-old0"), log);
    mock.timers.tick(RELAY_OUTBOX_TTL_MS + 1);
    deliverResponse(aged, response("relay-request-new0"), log);
    assert.deepEqual([...aged.outbox.keys()], ["relay-request-new0"]);
    assert.ok(lines.some((line) => line.includes("relay.outbox_dropped.expired")));
  } finally {
    mock.timers.reset();
  }
});

test("an expired outbox entry is not sent on the next connection", async () => {
  const relayServer = await relay();
  const carry = createRelayCarry();
  const abort = new AbortController();
  const lines: string[] = [];
  carry.outbox.set("relay-request-0008", { envelope: { protocol: DEVICE_RELAY_PROTOCOL, type: "response", id: "relay-request-0008", ok: true }, at: Date.now() - RELAY_OUTBOX_TTL_MS - 1 });
  carry.outbox.set("relay-request-0009", { envelope: { protocol: DEVICE_RELAY_PROTOCOL, type: "response", id: "relay-request-0009", ok: true }, at: Date.now() });
  try {
    const connected = relayServer.next();
    const run = settled(serveConnection(relayServer.url, "t", deviceId, null, null, abort.signal, (line) => lines.push(line), undefined, undefined, undefined, carry));
    const { frames } = await connected;
    await until(() => responses(frames).length >= 1);
    assert.deepEqual(responses(frames).map((frame) => frame.id), ["relay-request-0009"]);
    assert.ok(lines.some((line) => line.includes("relay.outbox_dropped.expired")));
    abort.abort();
    await run;
  } finally {
    abort.abort();
    await relayServer.close();
  }
});

test("a silent connection is terminated with relay.heartbeat_timeout so the loop can reconnect", async () => {
  const relayServer = await relay();
  const abort = new AbortController();
  const lines: string[] = [];
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  try {
    const connected = relayServer.next();
    const carry = createRelayCarry();
    const run = serveConnection(relayServer.url, "t", deviceId, null, null, abort.signal, (line) => lines.push(line), undefined, undefined, undefined, carry);
    const failed = run.then(() => undefined, (error: unknown) => error);
    await connected;
    await until(() => carry.socket !== undefined);
    // Time passes without the relay saying anything (the clock jumps in one step, so no pong can arrive).
    mock.timers.tick(60_000);
    const error = await failed;
    assert.match(String((error as Error).message), /heartbeat timed out/);
    assert.ok(lines.some((line) => line.includes("relay.heartbeat_timeout")));
    assert.ok(lines.some((line) => line.includes("relay.socket_closed")));
  } finally {
    mock.timers.reset();
    abort.abort();
    await relayServer.close();
  }
});
