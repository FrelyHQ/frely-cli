import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { jcs } from "./jcs.js";
import { challengeFor, TrustError, verifyAssertion, type Signer, type WebAuthnSignature } from "./webauthn.js";

export const TRUST_DOMAIN = "frely.trust.v1";
export const APPROVAL_DOMAIN = "frely.approval.v1";
/**
 * The only relying party and signing origin a device accepts for an instance, whatever a record says (`trustAnchor(instance)`, from
 * instance.ts). Without this a first version served by a compromised cloud could list another site as an approval origin, and signatures
 * made there would count. The anchor comes from the instance the account is logged in to, never from the record itself.
 */
export interface TrustAnchor { rpId: string; approvalOrigins: readonly string[] }

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

function shape(record: TrustRecord, anchor: TrustAnchor): void {
  if (record?.typ !== TRUST_DOMAIN || typeof record.user !== "string" || !Number.isSafeInteger(record.seq) || record.seq < 1) throw new TrustError("record_invalid");
  if (record.seq === 1 ? record.prev !== null : typeof record.prev !== "string") throw new TrustError("record_invalid");
  if (record.rpId !== anchor.rpId) throw new TrustError("rp_id_not_allowed");
  if (!Array.isArray(record.approvalOrigins) || record.approvalOrigins.length !== anchor.approvalOrigins.length || !record.approvalOrigins.every((origin, index) => origin === anchor.approvalOrigins[index])) throw new TrustError("origin_not_allowed");
  if (!Array.isArray(record.signers) || record.signers.length < 1 || record.signers.length > 32) throw new TrustError("record_invalid");
}

/**
 * Check a new trust record version. The first version signs itself; every later one is signed by a signer of the previous
 * version and must chain to it. `pin` is what this device already holds (none on first bind); `anchor` is the instance's.
 */
export function verifyTrustRecord(next: SignedTrustRecord, previous: TrustRecord | undefined, pin: TrustPin | undefined, anchor: TrustAnchor): TrustPin {
  shape(next.record, anchor);
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

/** One pin per relay and account: a device that is rebound to another account must not be stuck with the first account's pin. */
export function trustDirectory(scope?: { relayUrl: string; userId: string }): string {
  const base = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "trust");
  return scope ? join(base, createHash("sha256").update(`${scope.relayUrl}\0${scope.userId}`).digest("base64url").slice(0, 24)) : base;
}

export async function readTrust(directory = trustDirectory()): Promise<{ pin: TrustPin; record: TrustRecord } | undefined> {
  try {
    const stored = JSON.parse(await readFile(join(directory, "record.json"), "utf8")) as { pin: TrustPin; record: TrustRecord };
    if (stored.pin.hash !== trustRecordHash(stored.record) || stored.pin.seq !== stored.record.seq) return undefined;
    return stored;
  } catch { return undefined; }
}

/** Pin a verified record. Rollbacks and forks throw before anything is written. */
export async function pinTrustRecord(next: SignedTrustRecord, directory: string, anchor: TrustAnchor): Promise<TrustPin> {
  const held = await readTrust(directory);
  const pin = verifyTrustRecord(next, held?.record, held?.pin, anchor);
  if (!held || pin.seq > held.pin.seq) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "record.json"), JSON.stringify({ pin, record: next.record }), { mode: 0o600 });
    await chmod(join(directory, "record.json"), 0o600);
  }
  return pin;
}

/**
 * Pin the newest version of a user's chain. The chain is walked from what the device already holds (or from version 1), so
 * every version is checked against its predecessor, never only the newest. A first pin must belong to `userId` (the bound account).
 */
export async function pinTrustChain(chain: readonly SignedTrustRecord[], userId: string, directory: string, anchor: TrustAnchor): Promise<TrustPin | undefined> {
  const held = await readTrust(directory);
  if (held && held.pin.user !== userId) throw new TrustError("user_mismatch");
  let pin = held?.pin, previous = held?.record, newest: SignedTrustRecord | undefined;
  const ordered = [...chain].sort((a, b) => a.record.seq - b.record.seq);
  if (!held && ordered[0]?.record.seq !== 1) throw new TrustError("chain_broken");
  for (const version of ordered) {
    if (version.record.user !== userId) throw new TrustError("user_mismatch");
    if (pin && version.record.seq < pin.seq) continue;
    pin = verifyTrustRecord(version, previous, pin, anchor);
    previous = version.record;
    newest = version;
  }
  if (newest && (!held || pin!.seq > held.pin.seq)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "record.json"), JSON.stringify({ pin, record: newest.record }), { mode: 0o600 });
    await chmod(join(directory, "record.json"), 0o600);
  }
  return pin;
}

/** A `script` step the owner signed: the sha256 of the command text and of each file it names (paths relative to the step folder). */
export interface TodoStepScript { command: string; files: { path: string; sha256: string }[] }

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
  /** `todo_scope` approvals: what the owner read and signed (see todo-scope.ts). */
  scope?: { todo: string; deviceName: string; workspace: string; sites: string[]; executors?: string[]; scriptHashes?: string[]; stepScripts?: TodoStepScript[]; credentials?: string[]; maxSteps: number };
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
