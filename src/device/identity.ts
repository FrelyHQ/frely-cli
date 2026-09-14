import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { basicCredentialStore as credentialStore } from "../credential-basic.js";

const SERVICE = "frely-cli-provider-device-v1";

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
  let privateKeyPem = await credentialStore.getPassword(SERVICE, key);
  if (!privateKeyPem) {
    const pair = generateKeyPairSync("ed25519");
    privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await credentialStore.setPassword(SERVICE, key, privateKeyPem);
  }
  return identityFromPrivateKey(privateKeyPem);
}

export async function deleteDeviceIdentity(relayUrl: string, userId: string): Promise<void> {
  await credentialStore.deletePassword(SERVICE, account(relayUrl, userId));
}

export function connectionProofMessage(deviceId: string, issuedAt: string, nonce: string): string {
  return `frely.device-relay.connect.v1\n${deviceId}\n${issuedAt}\n${nonce}`;
}

export function localProviderTokenMessage(deviceId: string, userId: string, providerId: string): string {
  return `frely.device-relay.provider.v1\n${deviceId}\n${userId}\n${providerId}`;
}

export function createLocalProviderToken(identity: DeviceIdentity, deviceId: string, userId: string, providerId: string): string {
  if (!/^drd_[a-f0-9]{32}$/u.test(deviceId) || !/^[A-Za-z0-9_-]{1,128}$/u.test(userId) || !/^prv_[0-9a-f]{24}$/u.test(providerId)) throw new Error("Local Provider token target is invalid.");
  return `flp_v1.${deviceId}.${userId}.${providerId}.${identity.signMessage(localProviderTokenMessage(deviceId, userId, providerId))}`;
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

export function identityFromPrivateKey(privateKeyPem: string): DeviceIdentity {
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
