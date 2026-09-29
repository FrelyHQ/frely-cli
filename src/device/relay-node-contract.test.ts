import test from "node:test";
import assert from "node:assert/strict";
import WebSocket, { WebSocketServer, WebSocket as WsSocket } from "ws";
import { serveConnection } from "./relay-client.js";
import { RelayNodeSession, type NodeFrameHandler } from "../runtime/relay-session.js";
import { DEVICE_RELAY_PROTOCOL, decodeDeviceRelayEnvelope, encodeDeviceRelayEnvelope, type DeviceRelayEnvelope } from "./protocol.js";

/**
 * A [NodeFrameHandler] that uppercases frames, so the relay's base64 round-trip
 * is observable end to end.
 */
class UppercaseFrameHandler implements NodeFrameHandler {
  received: Buffer[] = [];
  async handleFrame(frame: Buffer, _signal: AbortSignal): Promise<Buffer> {
    this.received.push(frame);
    return Buffer.from(frame.toString("utf8").toUpperCase());
  }
  cancelFrame(_relayId: string): void {}
}

/**
 * A minimal bidirectional relay that forwards every frame between its two
 * connected peers, standing in for the Frely cloud relay during the contract
 * test. It accepts any subprotocol and ignores auth headers — the point is to
 * prove the relay透传s raw `node` frames, not to reproduce the cloud router.
 */
class RelaySimulator {
  private readonly peers = new Set<WsSocket>();
  readonly url: string;
  private readonly server: WebSocketServer;

  constructor() {
    this.server = new WebSocketServer({ port: 0 });
    const address = this.server.address();
    assert.ok(address && typeof address === "object");
    this.url = `ws://127.0.0.1:${address.port}`;
    this.server.on("connection", (socket) => {
      this.peers.add(socket);
      socket.on("message", (data) => {
        for (const peer of this.peers) if (peer !== socket && peer.readyState === WsSocket.OPEN) peer.send(data);
      });
      socket.on("close", () => this.peers.delete(socket));
    });
  }

  connect(): Promise<WsSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url, DEVICE_RELAY_PROTOCOL);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
  }

  /** Receive the next relay envelope on [socket]. */
  nextEnvelope(socket: WsSocket): Promise<DeviceRelayEnvelope> {
    return new Promise((resolve, reject) => {
      const onData = (data: Buffer) => { socket.off("message", onData); resolve(decodeDeviceRelayEnvelope(data)); };
      socket.once("message", onData);
      socket.once("error", reject);
    });
  }

  async close(): Promise<void> {
    for (const peer of this.peers) peer.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

test("relay透传 node 帧：client → relay → serveConnection(RelayNodeSession) → response", async () => {
  const relay = new RelaySimulator();
  try {
    const handler = new UppercaseFrameHandler();
    const session = new RelayNodeSession(handler);
    const deviceController = new AbortController();

    let deviceConnected = false;
    const deviceDone = serveConnection(relay.url, "fake-token", "device-1", session, null, deviceController.signal, () => {}, (event) => {
      if (event.type === "connected") deviceConnected = true;
    });

    // Wait for the device (serveConnection) to connect to the relay.
    for (let waited = 0; !deviceConnected && waited < 2000; waited += 20) await new Promise((r) => setTimeout(r, 20));
    assert.ok(deviceConnected, "device serveConnection must connect to the relay");

    // Client side: open a peer on the same relay and send a node request.
    const client = await relay.connect();
    const responsePromise = relay.nextEnvelope(client);
    const request = encodeDeviceRelayEnvelope({
      protocol: DEVICE_RELAY_PROTOCOL,
      type: "request",
      id: "node-request-0001",
      method: "node",
      payload: { frame: Buffer.from("hello-node").toString("base64") },
    });
    client.send(request);

    const response = await responsePromise;
    assert.equal(response.type, "response");
    assert.equal(response.id, "node-request-0001");
    assert.ok("ok" in response && response.ok === true, "node request should succeed");
    const payload = response as unknown as { payload?: { frame?: string } };
    assert.ok(payload.payload?.frame);
    const decoded = Buffer.from(payload.payload!.frame!, "base64");
    assert.equal(decoded.toString("utf8"), "HELLO-NODE");
    assert.equal(handler.received[0]!.toString("utf8"), "hello-node");

    deviceController.abort();
    await session.close();
    await Promise.race([deviceDone, new Promise((r) => setTimeout(r, 1000))]);
  } finally {
    await relay.close();
  }
});
