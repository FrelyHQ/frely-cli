import test from "node:test";
import assert from "node:assert/strict";
import {
  nextDeviceTransportKind,
  selectDeviceTransport,
  type DeviceTransportGrant,
} from "./transport.js";

const transports: readonly DeviceTransportGrant[] = [
  {
    kind: "cloudflare_do",
    websocketUrl: "wss://edge.example.invalid/device",
    accessToken: "edge",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  {
    kind: "relay",
    websocketUrl: "wss://relay.example.invalid/device",
    accessToken: "relay",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
];

test("Device transport selection prefers the control-plane order and supports relay fallback", () => {
  assert.equal(selectDeviceTransport(transports).kind, "cloudflare_do");
  assert.equal(selectDeviceTransport(transports, "relay").kind, "relay");
  assert.equal(nextDeviceTransportKind(transports, "cloudflare_do"), "relay");
  assert.equal(nextDeviceTransportKind(transports, "relay"), undefined);
});

test("Device transport selection keeps legacy relay-only grants usable", () => {
  const relayOnly = [transports[1]!] as const;
  assert.equal(selectDeviceTransport(relayOnly).kind, "relay");
  assert.equal(selectDeviceTransport(relayOnly, "cloudflare_do").kind, "relay");
  assert.equal(nextDeviceTransportKind(relayOnly, "relay"), undefined);
});
