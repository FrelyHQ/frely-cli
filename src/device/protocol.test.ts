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

test("device relay request toolsets round trip and validate", () => {
  const good = {
    protocol: DEVICE_RELAY_PROTOCOL,
    type: "request" as const,
    id: "abcdefghijklmnop",
    method: "mcp" as const,
    authorizationId: "mca_" + "a".repeat(32),
    toolsets: ["workspace", "frely-app"],
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  };
  assert.deepEqual(decodeDeviceRelayEnvelope(encodeDeviceRelayEnvelope(good)), good);
  for (const toolsets of [[], ["workspace", "workspace"], ["UPPER"], "workspace", ["a".repeat(33)]]) {
    assert.throws(() => decodeDeviceRelayEnvelope(JSON.stringify({ ...good, toolsets })), /frame_invalid/);
  }
  assert.throws(() => decodeDeviceRelayEnvelope(JSON.stringify({ ...good, method: "provider", authorizationId: undefined, toolsets: ["workspace"] })));
});

test("device relay request localMcps round trip, validate and stay mcp-only", () => {
  const good = {
    protocol: DEVICE_RELAY_PROTOCOL,
    type: "request" as const,
    id: "abcdefghijklmnop",
    method: "mcp" as const,
    authorizationId: "mca_" + "a".repeat(32),
    localMcps: ["browser-bridge", "notes"],
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  };
  assert.deepEqual(decodeDeviceRelayEnvelope(encodeDeviceRelayEnvelope(good)), good);
  for (const localMcps of [[], ["a", "a"], ["Upper"], ["-lead"], ["x".repeat(33)], "notes", [1]]) {
    assert.throws(() => decodeDeviceRelayEnvelope(JSON.stringify({ ...good, localMcps })), /frame_invalid/);
  }
  assert.throws(() => decodeDeviceRelayEnvelope(JSON.stringify({ ...good, method: "provider", authorizationId: undefined })));
});

test("device relay capabilities envelope round trips within 4KB", () => {
  const report = {
    protocol: DEVICE_RELAY_PROTOCOL,
    type: "device_capabilities" as const,
    id: "caps_1234567890ab",
    capabilities: { app: { installed: true, version: "0.4.0" }, sandbox: "none" },
  };
  assert.deepEqual(decodeDeviceRelayEnvelope(encodeDeviceRelayEnvelope(report)), report);
  assert.throws(() => decodeDeviceRelayEnvelope(JSON.stringify({ ...report, capabilities: ["not", "an", "object"] })));
  assert.throws(() => decodeDeviceRelayEnvelope(JSON.stringify({ ...report, capabilities: { blob: "x".repeat(8_192) } })));
});
