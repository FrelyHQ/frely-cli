import type { DiagnosticLog } from "../runtime/diagnostics.js";
import { readTrust, verifyApproval, type SignedApproval } from "./record.js";
import { TrustError } from "./webauthn.js";

/** Request `_meta` key that will carry the user's signed approvals (plan §2.3). */
export const APPROVALS_META_KEY = "frely/approvals";
const MAX_APPROVALS = 8;

export interface ObserveResult { seen: number; valid: number; failures: string[] }
let identity: { device: string; deviceKey: string } | undefined;
/** The device this process serves; set once the binding is known. */
export function setObserveIdentity(value: { device: string; deviceKey: string }): void { identity = value; }

export const observed = { seen: 0, valid: 0, failed: 0 };

/**
 * Observation mode (P1): verify whatever approvals a request carries and count the outcome. Nothing is blocked and
 * nothing depends on the result yet; P2 starts enforcing once the failure rate is known to be low.
 */
export async function observeApprovals(payload: unknown, log?: DiagnosticLog): Promise<ObserveResult> {
  const result: ObserveResult = { seen: 0, valid: 0, failures: [] };
  try {
    if (!identity) return result;
    const params = (payload as { params?: { _meta?: Record<string, unknown> } } | null)?.params;
    const list = params?._meta?.[APPROVALS_META_KEY];
    if (!Array.isArray(list) || list.length === 0) return result;
    const trust = await readTrust();
    for (const entry of list.slice(0, MAX_APPROVALS)) {
      result.seen++;
      try {
        if (!trust) throw new TrustError("no_trust_record");
        verifyApproval(entry as SignedApproval, { record: trust.record, ...identity! });
        result.valid++;
      } catch (error) { result.failures.push(error instanceof TrustError ? error.code : "error"); }
    }
    observed.seen += result.seen; observed.valid += result.valid; observed.failed += result.seen - result.valid;
    if (log && result.failures.length) log(JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, event: "trust.approval_unverified", failures: result.failures.slice(0, MAX_APPROVALS) }));
  } catch { /* Observation must never affect a request. */ }
  return result;
}
