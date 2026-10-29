import assert from "node:assert/strict";
import test from "node:test";
import { formatApiList, isInteractiveTerminal, permissionHint, rerunAfterApproval } from "./cloud.js";
import type { ApprovalOutcome, ApprovalRef } from "./controller/approval-wait.js";

const failure = (error: object) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] });

test("a permission_required failure becomes a one-line hint with the console link", () => {
  const hint = permissionHint(failure({ code: "permission_required", need: "write", group: "agents", url: "https://frely.cloud/user/account/connections?cloudClient=c1" }));
  assert.match(hint ?? "", /write access to agents/);
  assert.match(hint ?? "", /https:\/\/frely\.cloud\/user\/account\/connections\?cloudClient=c1/);
});

test("a permission_required hint with a short code says how to wait in the background", () => {
  const hint = permissionHint(failure({ code: "permission_required", need: "write", group: "agents", shortCode: "ABCDEF", url: "https://frely.cloud/device?g=ABCDEF" }));
  assert.match(hint ?? "", /frely permission wait ABCDEF/);
});

test("other failures, successes and non-https links give no hint", () => {
  assert.equal(permissionHint(failure({ code: "operation_failed" })), null);
  assert.equal(permissionHint({ isError: false, content: [] }), null);
  assert.equal(permissionHint(failure({ code: "permission_required", need: "read", group: "x", url: "http://evil.example/x" })), null);
  assert.equal(permissionHint(failure({ code: "permission_required", need: "read", group: "x", url: "javascript:alert(1)" })), null);
});

test("a confirmation_required failure shows the summary, the approval link and how to retry", () => {
  const hint = permissionHint(failure({ code: "confirmation_required", confirmationId: "cloud_confirm_0123456789abcdef01234567", summary: 'Revoke API key "ci".',
    url: "https://frely.cloud/user/account/connections?confirmation=cloud_confirm_0123456789abcdef01234567" }));
  assert.match(hint ?? "", /Revoke API key "ci"\./);
  assert.match(hint ?? "", /confirmation=cloud_confirm_0123456789abcdef01234567/);
  assert.match(hint ?? "", /"confirmationId":"cloud_confirm_0123456789abcdef01234567"/);
  assert.equal(permissionHint(failure({ code: "confirmation_required", confirmationId: "bad id\n", url: "https://frely.cloud/x" })), null);
  assert.equal(permissionHint(failure({ code: "confirmation_required", confirmationId: "ok_1", url: "http://evil.example/x" })), null);
});

test("the tool list is grouped by name prefix with the server's group summary and a one-line entry per tool", () => {
  const text = formatApiList([
    { name: "keys.revoke", description: "Revoke an API key. It stops working at once.", annotations: { destructiveHint: true }, _meta: { "frely/groupSummary": "Your API keys." } },
    { name: "keys.list", description: "List your API keys.\nPaged.", annotations: { readOnlyHint: true }, _meta: { "frely/groupSummary": "Your API keys." } },
    { name: "usage.summary", description: "Usage totals", annotations: { readOnlyHint: true } },
    { name: "keys.create", description: "Create an API key." },
  ]);
  assert.equal(text, [
    "keys — Your API keys.",
    "  keys.revoke [destructive] Revoke an API key.",
    "  keys.list [read] List your API keys.",
    "  keys.create [write] Create an API key.",
    "",
    "usage",
    "  usage.summary [read] Usage totals",
    "",
    "Details: frely api describe <tool>   Full JSON: frely api list --json",
    "",
  ].join("\n"));
});

test("browser authorization is only attempted from an interactive terminal", () => {
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), stderr = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  try {
    for (const [inTty, errTty, expected] of [[true, true, true], [false, true, false], [true, false, false], [undefined, undefined, false]] as const) {
      Object.defineProperty(process.stdin, "isTTY", { value: inTty, configurable: true });
      Object.defineProperty(process.stderr, "isTTY", { value: errTty, configurable: true });
      assert.equal(isInteractiveTerminal(), expected);
    }
  } finally {
    for (const [stream, original] of [[process.stdin, stdin], [process.stderr, stderr]] as const) {
      if (original) Object.defineProperty(stream, "isTTY", original); else delete (stream as { isTTY?: boolean }).isTTY;
    }
  }
});

const refusal = (error: object) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] });
const outcome = (status: ApprovalOutcome["status"]): ApprovalOutcome => ({ status, data: {}, message: "" });
const waiter = (status: ApprovalOutcome["status"]) => { const refs: Array<{ ref: ApprovalRef; timeoutMs: number }> = []; return { refs, wait: async (ref: ApprovalRef, timeoutMs: number) => { refs.push({ ref, timeoutMs }); return outcome(status); } }; };
const ok = { content: [{ type: "text", text: "{}" }] };

test("an approved permission_required is waited for by its short code, then the call runs exactly once", async () => {
  const first = refusal({ code: "permission_required", shortCode: "ABCDEF", url: "https://frely.cloud/r/ab", expiresAt: 60_000 });
  const { refs, wait } = waiter("approved");
  const inputs: Array<Record<string, unknown>> = [];
  const final = await rerunAfterApproval(first, async input => { inputs.push(input); return ok; }, { a: 1 }, wait, () => 0);
  assert.deepEqual(refs, [{ ref: { code: "ABCDEF" }, timeoutMs: 60_000 }]);
  assert.deepEqual(inputs, [{ a: 1 }]);
  assert.equal(final, ok);
});

test("an approved confirmation is repeated once with the same confirmationId, within the 10 minute cap", async () => {
  const first = refusal({ code: "confirmation_required", confirmationId: "c_1", url: "https://frely.cloud/c/c_1", expiresAt: 3_600_000 });
  const { refs, wait } = waiter("approved");
  const inputs: Array<Record<string, unknown>> = [];
  await rerunAfterApproval(first, async input => { inputs.push(input); return ok; }, { a: 1 }, wait, () => 0);
  assert.deepEqual(refs, [{ ref: { confirmationId: "c_1" }, timeoutMs: 600_000 }]);
  assert.deepEqual(inputs, [{ a: 1, confirmationId: "c_1" }]);
});

test("nothing runs when the approval is denied, expired, used, still pending or unreadable", async () => {
  const first = refusal({ code: "confirmation_required", confirmationId: "c_1", url: "https://frely.cloud/c/c_1", expiresAt: 5000 });
  for (const status of ["denied", "expired", "revoked", "used", "pending", "error"] as const) {
    const final = await rerunAfterApproval(first, async () => { throw new Error("must not call"); }, {}, waiter(status).wait, () => 0);
    assert.equal(final, first, status);
  }
});

test("a repeat that fails is returned as it came back and not tried again", async () => {
  const first = refusal({ code: "permission_required", shortCode: "ABCDEF", url: "https://frely.cloud/r/ab", expiresAt: 60_000 });
  const lost = refusal({ code: "operation_cancelled_outcome_unknown" });
  let calls = 0;
  assert.equal(await rerunAfterApproval(first, async () => { calls++; return lost; }, {}, waiter("approved").wait, () => 0), lost);
  assert.equal(calls, 1);
});

test("a failure that is not an approval, or has no reference to wait on, is returned untouched", async () => {
  const never = async () => { throw new Error("must not wait"); };
  const other = refusal({ code: "operation_failed" });
  assert.equal(await rerunAfterApproval(other, never, {}, never), other);
  const noCode = refusal({ code: "permission_required", message: "The owner denied this a moment ago." });
  assert.equal(await rerunAfterApproval(noCode, never, {}, never), noCode);
});
