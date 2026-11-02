import { createHash, createPublicKey, verify } from "node:crypto";
import { jcs } from "./jcs.js";

/** COSE algorithm numbers of the passkeys we accept: ES256, EdDSA, RS256. The device never parses CBOR; the SPKI comes from the trust record. */
export type CoseAlg = -7 | -8 | -257;
export interface Signer { id: string; kind: "webauthn"; credId: string; alg: CoseAlg; spki: string; label?: string; added?: string }
export interface WebAuthnSignature { kind: "webauthn"; credId: string; authData: string; clientData: string; signature: string }

export class TrustError extends Error {
  constructor(readonly code: string, message?: string) { super(message ?? code); this.name = "TrustError"; }
}

const sha256 = (data: Buffer | string): Buffer => createHash("sha256").update(data).digest();
const b64 = (value: string): Buffer => Buffer.from(value, "base64url");

/** The WebAuthn challenge for `payload`: SHA-256 over a domain tag and the canonical JSON, base64url. */
export function challengeFor(domain: string, payload: unknown): string {
  return sha256(Buffer.concat([Buffer.from(`${domain}\0`), Buffer.from(jcs(payload))])).toString("base64url");
}

export interface AssertionRules {
  rpId: string;
  /** Only these origins may have produced the assertion; the main site is deliberately not among them. */
  origins: readonly string[];
  domain: string;
  signers: readonly Signer[];
}

/** Verify one WebAuthn assertion over `payload` offline. Returns the signer; throws TrustError otherwise. */
export function verifyAssertion(payload: unknown, signature: WebAuthnSignature, rules: AssertionRules): Signer {
  if (signature?.kind !== "webauthn") throw new TrustError("signature_kind");
  const signer = rules.signers.find((candidate) => candidate.credId === signature.credId);
  if (!signer) throw new TrustError("signer_unknown");
  let client: Record<string, unknown>;
  try { client = JSON.parse(b64(signature.clientData).toString("utf8")) as Record<string, unknown>; } catch { throw new TrustError("client_data_invalid"); }
  if (client.type !== "webauthn.get") throw new TrustError("client_data_type");
  if (client.challenge !== challengeFor(rules.domain, payload)) throw new TrustError("challenge_mismatch");
  if (typeof client.origin !== "string" || !rules.origins.includes(client.origin)) throw new TrustError("origin_not_allowed");
  if (client.crossOrigin === true || client.topOrigin !== undefined) throw new TrustError("cross_origin");
  const authData = b64(signature.authData);
  if (authData.length < 37) throw new TrustError("auth_data_short");
  if (!authData.subarray(0, 32).equals(sha256(rules.rpId))) throw new TrustError("rp_id_mismatch");
  const flags = authData[32]!;
  if (!(flags & 0x01)) throw new TrustError("user_presence_missing");
  if (!(flags & 0x04)) throw new TrustError("user_verification_missing");
  const signed = Buffer.concat([authData, sha256(b64(signature.clientData))]);
  let ok = false;
  try {
    const key = createPublicKey({ key: b64(signer.spki), format: "der", type: "spki" });
    ok = signer.alg === -8 ? verify(null, signed, key, b64(signature.signature)) : verify("sha256", signed, key, b64(signature.signature));
  } catch { throw new TrustError("signature_invalid"); }
  if (!ok) throw new TrustError("signature_invalid");
  return signer;
}
