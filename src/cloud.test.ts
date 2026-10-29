import assert from "node:assert/strict";
import test from "node:test";
import { formatApiList, isInteractiveTerminal, permissionHint, waitForApproval } from "./cloud.js";

const failure = (error: object) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] });

test("a permission_required failure becomes a one-line hint with the console link", () => {
  const hint = permissionHint(failure({ code: "permission_required", need: "write", group: "agents", url: "https://frely.cloud/user/account/connections?cloudClient=c1" }));
  assert.match(hint ?? "", /write access to agents/);
  assert.match(hint ?? "", /https:\/\/frely\.cloud\/user\/account\/connections\?cloudClient=c1/);
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
const waitOptions = (clock: { t: number }) => ({ intervalMs: 1000, now: () => clock.t, sleep: async (ms: number) => { clock.t += ms; } });

test("waitForApproval repeats a pending permission request until the owner approves", async () => {
  const clock = { t: 0 };
  const pending = refusal({ code: "permission_required", url: "https://frely.cloud/r/ab", expiresAt: 60_000 });
  const results = [pending, pending, { content: [{ type: "text", text: "{}" }] }];
  let calls = 0;
  const final = await waitForApproval(pending, async () => results[calls++]!, { a: 1 }, waitOptions(clock));
  assert.equal(calls, 3);
  assert.equal((final as { isError?: boolean }).isError, undefined);
});

test("waitForApproval stops when the request is denied (refusal without a link)", async () => {
  const clock = { t: 0 };
  const denied = refusal({ code: "permission_required", message: "The owner denied this a moment ago." });
  const final = await waitForApproval(refusal({ code: "permission_required", url: "https://frely.cloud/r/ab", expiresAt: 60_000 }), async () => denied, {}, waitOptions(clock));
  assert.equal(final, denied);
});

test("waitForApproval sends the confirmationId and gives up at expiry", async () => {
  const clock = { t: 0 };
  const inputs: Array<Record<string, unknown>> = [];
  const first = refusal({ code: "confirmation_required", confirmationId: "c_1", url: "https://frely.cloud/c/c_1", expiresAt: 5000 });
  const final = await waitForApproval(first, async input => { inputs.push(input); return refusal({ code: "confirmation_invalid" }); }, { a: 1 }, waitOptions(clock));
  assert.deepEqual(inputs[0], { a: 1, confirmationId: "c_1" });
  assert.ok(inputs.length >= 3 && inputs.length <= 5);
  assert.equal((final as { isError?: boolean }).isError, true);
});

test("waitForApproval returns a non-approval failure untouched", async () => {
  const other = refusal({ code: "operation_failed" });
  assert.equal(await waitForApproval(other, async () => { throw new Error("must not call"); }, {}), other);
});
