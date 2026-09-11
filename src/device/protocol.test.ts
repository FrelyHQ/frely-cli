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

test("device relay rejects malformed request ids", () => {
  assert.throws(() => decodeDeviceRelayEnvelope(JSON.stringify({ protocol: DEVICE_RELAY_PROTOCOL, type: "cancel", id: "short" })));
});
