import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import keytar from "keytar";

const SERVICE = "frely-cli-device";

export interface DeviceIdentity {
  publicKeySpki: string;
  keyThumbprint: string;
  signMessage(message: string): string;
}

function account(relayUrl: string, userId: string): string {
  return `${new URL(relayUrl).origin}|${userId}`;
}

export async function loadOrCreateDeviceIdentity(relayUrl: string, userId: string): Promise<DeviceIdentity> {
  const key = account(relayUrl, userId);
  let privateKeyPem = await keytar.getPassword(SERVICE, key);
  if (!privateKeyPem) {
    const pair = generateKeyPairSync("ed25519");
    privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await keytar.setPassword(SERVICE, key, privateKeyPem);
  }
  return identityFromPrivateKey(privateKeyPem);
}

export async function deleteDeviceIdentity(relayUrl: string, userId: string): Promise<void> {
  await keytar.deletePassword(SERVICE, account(relayUrl, userId)).catch(() => false);
}

export function connectionProofMessage(deviceId: string, issuedAt: string, nonce: string): string {
  return `frely.device-relay.connect.v1\n${deviceId}\n${issuedAt}\n${nonce}`;
}

export function createConnectionProof(identity: DeviceIdentity, deviceId: string): {
  deviceId: string;
  publicKeySpki: string;
  keyThumbprint: string;
  issuedAt: string;
  nonce: string;
  signature: string;
} {
  const issuedAt = new Date().toISOString();
  const nonce = randomBytes(24).toString("base64url");
  const message = connectionProofMessage(deviceId, issuedAt, nonce);
  return {
    deviceId,
    publicKeySpki: identity.publicKeySpki,
    keyThumbprint: identity.keyThumbprint,
    issuedAt,
    nonce,
    signature: identity.signMessage(message),
  };
}

function identityFromPrivateKey(privateKeyPem: string): DeviceIdentity {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const publicKeySpki = Buffer.from(publicDer).toString("base64url");
  const keyThumbprint = createHash("sha256").update(publicDer).digest("base64url");
  return {
    publicKeySpki,
    keyThumbprint,
    signMessage(message: string): string {
      return sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url");
    },
  };
}
