import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { DEVICE_RELAY_PROTOCOL, encodeDeviceRelayEnvelope, decodeDeviceRelayEnvelope } from "./protocol.js";

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
