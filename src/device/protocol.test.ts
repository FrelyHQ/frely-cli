import test from "node:test";
import assert from "node:assert/strict";
import { DEVICE_RELAY_PROTOCOL, decodeDeviceRelayEnvelope, encodeDeviceRelayEnvelope } from "./protocol.js";

test("device relay request envelope round trips", () => {
  const encoded = encodeDeviceRelayEnvelope({
    protocol: DEVICE_RELAY_PROTOCOL,
    type: "request",
    id: "abcdefghijklmnop",
    method: "mcp",
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  const decoded = decodeDeviceRelayEnvelope(encoded);
  assert.equal(decoded.type, "request");
});

test("device relay Provider stream envelopes round trip", () => {
  const id = "abcdefghijklmnop";
  const envelopes = [
    { protocol: DEVICE_RELAY_PROTOCOL, type: "stream_start" as const, id, status: 200, contentType: "text/event-stream" },
    { protocol: DEVICE_RELAY_PROTOCOL, type: "stream_chunk" as const, id, data: Buffer.from("data: [DONE]\n\n").toString("base64url") },
    { protocol: DEVICE_RELAY_PROTOCOL, type: "stream_end" as const, id },
  ];
  for (const envelope of envelopes) assert.deepEqual(decodeDeviceRelayEnvelope(encodeDeviceRelayEnvelope(envelope)), envelope);
});

test("device relay rejects malformed request ids", () => {
  assert.throws(() => decodeDeviceRelayEnvelope(JSON.stringify({ protocol: DEVICE_RELAY_PROTOCOL, type: "cancel", id: "short" })));
});
