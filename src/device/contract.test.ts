import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeDeviceRelayEnvelope, encodeDeviceRelayEnvelope, DeviceRelayProtocolError } from "./protocol.js";

const root = join(process.cwd(), "contracts", "device-relay.v1");

function fixtures(dir: string): Array<{ name: string; data: Record<string, unknown> }> {
  return readdirSync(join(root, dir)).filter((file) => file.endsWith(".json")).sort()
    .map((file) => ({ name: file, data: JSON.parse(readFileSync(join(root, dir, file), "utf8")) as Record<string, unknown> }));
}

test("device relay contract has fixtures", () => {
  assert.ok(fixtures("valid").length >= 10);
  assert.ok(fixtures("invalid").length >= 10);
});

for (const { name, data } of fixtures("valid")) {
  test(`device relay contract: valid ${name}`, () => {
    assert.ok(data.direction === "server_to_device" || data.direction === "device_to_server");
    const text = JSON.stringify(data.frame);
    assert.deepEqual(decodeDeviceRelayEnvelope(text), data.frame);
    assert.deepEqual(JSON.parse(encodeDeviceRelayEnvelope(data.frame as never)), data.frame);
  });
}

for (const { name, data } of fixtures("invalid")) {
  test(`device relay contract: invalid ${name}`, () => {
    const input = typeof data.raw === "string" ? data.raw : JSON.stringify(data.frame);
    assert.throws(() => decodeDeviceRelayEnvelope(input), (error: unknown) => error instanceof DeviceRelayProtocolError && error.code === data.error);
  });
}
