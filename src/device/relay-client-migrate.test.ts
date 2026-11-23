import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import { DEVICE_RELAY_PROTOCOL, decodeDeviceRelayEnvelope, encodeDeviceRelayEnvelope } from "./protocol.js";
import type { DeviceRelayEnvelope, DeviceRelayResponse } from "./protocol.js";
import type { ConnectionEvent } from "./connection-status.js";
import { McpLease } from "../runtime/mcp-lease.js";
import type { RelaySession } from "../runtime/relay-session.js";
import { serveConnection } from "./relay-client.js";

const deviceId = `drd_${"a".repeat(32)}`;
const authorizationId = `mca_${"a".repeat(32)}`;
const migrate: DeviceRelayEnvelope = { protocol: DEVICE_RELAY_PROTOCOL, type: "migrate", id: "mig_0123456789abcdef" };

function fakeSession() {
  const pending = new Map<string, (value: unknown) => void>();
  const session: RelaySession = {
    execute: (_payload, relayId) => new Promise((resolve) => pending.set(relayId, resolve)),
    cancel: () => undefined,
    close: async () => undefined,
  };
  return { session, finish: (id: string) => pending.get(id)?.({ done: id }) };
}

type Peer = { peer: WebSocket; frames: DeviceRelayEnvelope[]; closed?: { code: number; reason: string } };

/** A relay whose connections are numbered; `refuse` makes it reject the next handshakes. */
async function relay() {
  let refuse = false;
  const server = new WebSocketServer({ port: 0, handleProtocols: () => DEVICE_RELAY_PROTOCOL, verifyClient: () => !refuse });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  const peers: Peer[] = [];
  server.on("connection", (peer) => {
    const entry: Peer = { peer, frames: [] };
    peer.on("message", (data) => entry.frames.push(decodeDeviceRelayEnvelope(Buffer.from(data as Buffer))));
    peer.on("close", (code, reason) => { entry.closed = { code, reason: reason.toString() }; });
    peers.push(entry);
  });
  return {
    url: `ws://127.0.0.1:${address.port}`, peers,
    refuse: (value: boolean) => { refuse = value; },
    close: async () => { for (const client of server.clients) client.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

const request = (id: string): DeviceRelayEnvelope => ({
  protocol: DEVICE_RELAY_PROTOCOL, type: "request", id, method: "mcp", authorizationId, payload: { jsonrpc: "2.0", id: 0, method: "tools/list" },
});
const until = async (condition: () => boolean) => { for (let i = 0; i < 300 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); assert.ok(condition(), "condition not reached"); };
const responseIds = (peer: Peer) => peer.frames.filter((frame): frame is DeviceRelayResponse => frame.type === "response").map((frame) => frame.id);

async function scenario(run: (ctx: { server: Awaited<ReturnType<typeof relay>>; fake: ReturnType<typeof fakeSession>; events: ConnectionEvent[]; lines: string[]; done: Promise<void>; state: { ended: boolean } }) => Promise<void>) {
  const server = await relay();
  const fake = fakeSession();
  const lease = new McpLease(authorizationId, Date.now() + 60_000);
  const abort = new AbortController();
  const events: ConnectionEvent[] = [];
  const lines: string[] = [];
  const state = { ended: false };
  const done = serveConnection(server.url, "synthetic-test-token", deviceId, fake.session, lease, abort.signal, (line) => lines.push(line), (event) => events.push(event))
    .then(() => { state.ended = true; }, () => { state.ended = true; });
  try {
    await until(() => server.peers.length === 1);
    await run({ server, fake, events, lines, done, state });
  } finally {
    abort.abort();
    lease.close();
    await done;
    await server.close();
  }
}

test("migrate: the new connection takes new requests, the old one drains and is closed, the device never looks offline", async () => {
  await scenario(async ({ server, fake, events, lines, state }) => {
    const [oldPeer] = server.peers as [Peer];
    await until(() => oldPeer.frames.some((frame) => frame.type === "device_capabilities"));
    const caps = oldPeer.frames.find((frame) => frame.type === "device_capabilities") as { capabilities: Record<string, unknown> };
    assert.equal(caps.capabilities.relayMigrate, true);

    oldPeer.peer.send(encodeDeviceRelayEnvelope(request("req_old_0123456789")));
    await new Promise((resolve) => setTimeout(resolve, 50));
    oldPeer.peer.send(encodeDeviceRelayEnvelope(migrate));
    oldPeer.peer.send(encodeDeviceRelayEnvelope({ ...migrate, id: "mig_second_0123456" })); // ignored while one is in progress
    await until(() => server.peers.length === 2);
    const newPeer = server.peers[1]!;
    await until(() => newPeer.frames.some((frame) => frame.type === "device_capabilities"));
    assert.equal((newPeer.frames.find((frame) => frame.type === "device_capabilities") as { capabilities: Record<string, unknown> }).capabilities.relayMigrate, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(server.peers.length, 2);
    assert.equal(oldPeer.closed, undefined, "the old socket stays open while its request is in flight");

    newPeer.peer.send(encodeDeviceRelayEnvelope(request("req_new_0123456789")));
    await new Promise((resolve) => setTimeout(resolve, 50));
    fake.finish("req_new_0123456789");
    await until(() => responseIds(newPeer).includes("req_new_0123456789"));
    assert.deepEqual(responseIds(oldPeer), []);

    fake.finish("req_old_0123456789");
    await until(() => responseIds(oldPeer).includes("req_old_0123456789"));
    assert.deepEqual(responseIds(newPeer), ["req_new_0123456789"]);
    await until(() => oldPeer.closed !== undefined);
    assert.deepEqual(oldPeer.closed, { code: 1000, reason: "migrated" });
    assert.equal(newPeer.closed, undefined);
    assert.ok(lines.some((line) => line.includes("relay.migrated")));
    assert.equal(events.some((event) => event.type === "disconnected"), false);
    assert.equal(state.ended, false, "the connection outcome is now the new socket's");
  });
});

test("migrate: a failed new connection keeps serving on the old socket", async () => {
  await scenario(async ({ server, fake, events, lines }) => {
    const [oldPeer] = server.peers as [Peer];
    server.refuse(true);
    oldPeer.peer.send(encodeDeviceRelayEnvelope(migrate));
    await until(() => lines.some((line) => line.includes("relay.migrate_failed")));
    assert.equal(server.peers.length, 1);
    oldPeer.peer.send(encodeDeviceRelayEnvelope(request("req_a_0123456789abc")));
    await new Promise((resolve) => setTimeout(resolve, 50));
    fake.finish("req_a_0123456789abc");
    await until(() => responseIds(oldPeer).includes("req_a_0123456789abc"));
    assert.equal(oldPeer.closed, undefined);
    assert.equal(events.some((event) => event.type === "disconnected"), false);
    // A later migrate may try again.
    server.refuse(false);
    oldPeer.peer.send(encodeDeviceRelayEnvelope({ ...migrate, id: "mig_retry_01234567" }));
    await until(() => server.peers.length === 2);
  });
});

test("migrate: when the old socket dies first, its response is delivered on the new socket", async () => {
  await scenario(async ({ server, fake, events, state }) => {
    const [oldPeer] = server.peers as [Peer];
    oldPeer.peer.send(encodeDeviceRelayEnvelope(request("req_old_0123456789")));
    await new Promise((resolve) => setTimeout(resolve, 50));
    oldPeer.peer.send(encodeDeviceRelayEnvelope(migrate));
    await until(() => server.peers.length === 2);
    const newPeer = server.peers[1]!;
    await until(() => newPeer.frames.some((frame) => frame.type === "device_capabilities"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    oldPeer.peer.terminate();
    await until(() => oldPeer.closed !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    fake.finish("req_old_0123456789");
    await until(() => responseIds(newPeer).includes("req_old_0123456789"));
    assert.equal(events.some((event) => event.type === "disconnected"), false);
    assert.equal(state.ended, false);
  });
});
