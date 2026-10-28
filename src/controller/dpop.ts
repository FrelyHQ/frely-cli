import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";

/**
 * Sender-constrained tokens (RFC 9449). The controller's access and refresh tokens only work together with a short proof signed by
 * this key, so a copied token file does nothing on another computer. Ed25519, kept in the same record as the tokens.
 */
export interface DpopKey {
  privateKeyPem: string;
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string };
  /** RFC 7638 thumbprint of the public key; the server binds the tokens to it. */
  jkt: string;
}

export function dpopKeyFromPem(privateKeyPem: string): DpopKey {
  const jwk = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") throw new Error("The controller key is not an Ed25519 key.");
  const pub = { kty: "OKP" as const, crv: "Ed25519" as const, x: jwk.x };
  const jkt = createHash("sha256").update(JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x })).digest("base64url");
  return { privateKeyPem, jwk: pub, jkt };
}

export function generateDpopKey(): DpopKey {
  return dpopKeyFromPem(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString());
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A one-use proof for one request. `url` loses its query and fragment; `accessToken` adds the hash the resource checks it against. */
export function createDpopProof(key: DpopKey, input: { method: string; url: string; accessToken?: string; nonce?: string; now?: number }): string {
  const url = new URL(input.url);
  const header = { typ: "dpop+jwt", alg: "EdDSA", jwk: key.jwk };
  const payload = {
    jti: randomUUID(), htm: input.method.toUpperCase(), htu: `${url.protocol}//${url.host}${url.pathname}`, iat: Math.floor((input.now ?? Date.now()) / 1000),
    ...(input.accessToken ? { ath: createHash("sha256").update(input.accessToken, "utf8").digest("base64url") } : {}),
    ...(input.nonce ? { nonce: input.nonce } : {}),
  };
  const signingInput = `${b64(header)}.${b64(payload)}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput), createPrivateKey(key.privateKeyPem)).toString("base64url")}`;
}
