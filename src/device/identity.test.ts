import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { deleteDeviceIdentity, loadOrCreateDeviceIdentity } from "./identity.js";
import { useMemoryCredentialStore } from "../test-support.js";

test("device identity is stable and signs with enrolled public key", async () => {
  const relay = "https://test.invalid";
  const userId = `test-${process.pid}-${Date.now()}`;
  const restoreCredentialStore = useMemoryCredentialStore();
  try {
    const first = await loadOrCreateDeviceIdentity(relay, userId);
    const second = await loadOrCreateDeviceIdentity(relay, userId);
    assert.equal(second.publicKeySpki, first.publicKeySpki);
    assert.equal(second.keyThumbprint, first.keyThumbprint);
    const message = "frely-device-proof";
    const publicKey = createPublicKey({ key: Buffer.from(first.publicKeySpki, "base64url"), type: "spki", format: "der" });
    assert.equal(verify(null, Buffer.from(message), publicKey, Buffer.from(first.signMessage(message), "base64url")), true);
  } finally {
    await deleteDeviceIdentity(relay, userId);
    restoreCredentialStore();
  }
});
