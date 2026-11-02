import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { jcs } from "./jcs.js";
import { challengeFor, TrustError, verifyAssertion, type Signer, type WebAuthnSignature } from "./webauthn.js";

export const TRUST_DOMAIN = "frely.trust.v1";
export const APPROVAL_DOMAIN = "frely.approval.v1";

export interface TrustRecord {
  typ: "frely.trust.v1";
  user: string;
  seq: number;
  prev: string | null;
  rpId: string;
  approvalOrigins: string[];
  signers: Signer[];
  policy?: { minSigners?: number; maxApprovalTtl?: Record<string, string> };
}
export interface SignedTrustRecord { record: TrustRecord; sig: WebAuthnSignature }
export interface TrustPin { seq: number; hash: string; user: string }

export const trustRecordHash = (record: TrustRecord): string => createHash("sha256").update(jcs(record)).digest("base64url");

function shape(record: TrustRecord): void {
  if (record?.typ !== TRUST_DOMAIN || typeof record.user !== "string" || !Number.isSafeInteger(record.seq) || record.seq < 1) throw new TrustError("record_invalid");
  if (record.seq === 1 ? record.prev !== null : typeof record.prev !== "string") throw new TrustError("record_invalid");
  if (typeof record.rpId !== "string" || !Array.isArray(record.approvalOrigins) || record.approvalOrigins.length < 1 || !record.approvalOrigins.every((origin) => /^https:\/\/[a-z0-9.-]+$/u.test(origin))) throw new TrustError("record_invalid");
  if (!Array.isArray(record.signers) || record.signers.length < 1 || record.signers.length > 32) throw new TrustError("record_invalid");
}

/**
 * Check a new trust record version. The first version signs itself; every later one is signed by a signer of the previous
 * version and must chain to it. `pin` is what this device already holds (none on first bind).
 */
export function verifyTrustRecord(next: SignedTrustRecord, previous: TrustRecord | undefined, pin?: TrustPin): TrustPin {
  shape(next.record);
  if (pin && next.record.user !== pin.user) throw new TrustError("user_mismatch");
  const hash = trustRecordHash(next.record);
  if (pin) {
    if (next.record.seq < pin.seq) throw new TrustError("rollback");
    if (next.record.seq === pin.seq) { if (hash !== pin.hash) throw new TrustError("fork"); return pin; }
    if (!previous || trustRecordHash(previous) !== next.record.prev || previous.seq !== next.record.seq - 1) throw new TrustError("chain_broken");
  }
  const authority = next.record.seq === 1 ? next.record : previous;
  if (!authority) throw new TrustError("chain_broken");
  verifyAssertion(next.record, next.sig, { rpId: authority.rpId, origins: authority.approvalOrigins, domain: TRUST_DOMAIN, signers: authority.signers });
  return { seq: next.record.seq, hash, user: next.record.user };
}

export function trustDirectory(): string { return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "trust"); }

export async function readTrust(directory = trustDirectory()): Promise<{ pin: TrustPin; record: TrustRecord } | undefined> {
  try {
    const stored = JSON.parse(await readFile(join(directory, "record.json"), "utf8")) as { pin: TrustPin; record: TrustRecord };
    if (stored.pin.hash !== trustRecordHash(stored.record) || stored.pin.seq !== stored.record.seq) return undefined;
    return stored;
  } catch { return undefined; }
}

/** Pin a verified record. Rollbacks and forks throw before anything is written. */
export async function pinTrustRecord(next: SignedTrustRecord, directory = trustDirectory()): Promise<TrustPin> {
  const held = await readTrust(directory);
  const pin = verifyTrustRecord(next, held?.record, held?.pin);
  if (!held || pin.seq > held.pin.seq) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "record.json"), JSON.stringify({ pin, record: next.record }), { mode: 0o600 });
    await chmod(join(directory, "record.json"), 0o600);
  }
  return pin;
}

export interface ApprovalPayload {
  typ: "frely.approval.v1";
  id: string;
  user: string;
  trust: string;
  trustSeq: number;
  device: string;
  deviceKey: string;
  authz: string | null;
  ctl?: { kind: "oauth" | "key"; id: string; name?: string };
  grant: { kind: string; resource?: string; mode: "once" | "window" | "authorization" };
  bind?: { tool?: string; cmdHash?: string };
  iat: string; nbf: string; exp: string;
}
export interface SignedApproval { payload: ApprovalPayload; sig: WebAuthnSignature }

export interface ApprovalContext { record: TrustRecord; device: string; deviceKey: string; now?: number }

/** Verify one approval offline against the pinned trust record. Throws TrustError; the caller decides what a failure means. */
export function verifyApproval(approval: SignedApproval, context: ApprovalContext): ApprovalPayload {
  const { payload } = approval, { record } = context, now = context.now ?? Date.now();
  if (payload?.typ !== APPROVAL_DOMAIN || typeof payload.id !== "string") throw new TrustError("approval_invalid");
  verifyAssertion(payload, approval.sig, { rpId: record.rpId, origins: record.approvalOrigins, domain: APPROVAL_DOMAIN, signers: record.signers });
  if (payload.user !== record.user) throw new TrustError("user_mismatch");
  if (payload.trust !== trustRecordHash(record)) throw new TrustError("trust_mismatch");
  if (payload.device !== context.device || payload.deviceKey !== context.deviceKey) throw new TrustError("device_mismatch");
  const nbf = Date.parse(payload.nbf), exp = Date.parse(payload.exp), iat = Date.parse(payload.iat);
  if (![nbf, exp, iat].every(Number.isFinite)) throw new TrustError("approval_invalid");
  if (now < nbf - 5 * 60_000) throw new TrustError("not_yet_valid");
  if (now > exp) throw new TrustError("expired");
  if (payload.grant?.mode === "once" && exp - iat > 15 * 60_000) throw new TrustError("ttl_too_long");
  return payload;
}

export { challengeFor };
