import { resultData, resultText, type Controller } from "./client.js";

/** What an approval is known by: the six-letter code of a permission request, or the confirmationId of a one-time Cloud confirmation. */
export type ApprovalRef = { code: string } | { confirmationId: string };

export interface ApprovalOutcome {
  /** `pending` means the time ran out; `error` means the status could not be read (see `message`). */
  status: "approved" | "denied" | "expired" | "revoked" | "used" | "pending" | "error";
  data: Record<string, unknown> | null;
  message: string;
}

export interface ApprovalWaitOptions { intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }

const sleepFor = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const STATUSES = new Set(["approved", "denied", "expired", "revoked", "used"]);

/**
 * The one wait for every kind of approval: asks `permission_status` with wait=true, which holds each call until the owner answers (at most
 * about 50 s), until the owner decides or `timeoutMs` has passed. It only reads; what to do after "approved" is up to the caller.
 */
export async function waitForApproval(controller: Pick<Controller, "call">, ref: ApprovalRef, timeoutMs: number, options: ApprovalWaitOptions = {}): Promise<ApprovalOutcome> {
  const { intervalMs = 1000, now = Date.now, sleep = sleepFor } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    const began = now();
    const result = await controller.call("permission_status", { ...ref, wait: true });
    const data = resultData(result);
    if (result.isError === true || !data) return { status: "error", data: null, message: resultText(result) || "The approval could not be checked." };
    const status = String(data.status);
    if (STATUSES.has(status)) return { status: status as ApprovalOutcome["status"], data, message: resultText(result) };
    if (now() >= deadline) return { status: "pending", data, message: resultText(result) };
    // A relay that answers at once (no hold) must not be hammered.
    const spent = now() - began;
    if (spent < intervalMs) await sleep(intervalMs - spent);
  }
}
