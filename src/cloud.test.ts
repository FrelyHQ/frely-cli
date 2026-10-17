import assert from "node:assert/strict";
import test from "node:test";
import { cloudClientMetadata, cloudClientName, failureCause, formatApiList, isInteractiveTerminal, permissionHint } from "./cloud.js";

test("the Cloud client name carries a sanitized host so devices are told apart", () => {
  assert.equal(cloudClientName("mac-mini.local"), "Frely CLI Cloud (mac-mini.local)");
  assert.equal(cloudClientName("we<ird>\nhost"), "Frely CLI Cloud (weirdhost)");
  assert.equal(cloudClientName("   "), "Frely CLI Cloud");
  assert.ok(cloudClientName("x".repeat(100)).length <= "Frely CLI Cloud ()".length + 40);
});

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

test("the Cloud client registers as a native app so its http loopback callback is accepted", () => {
  const metadata = cloudClientMetadata("http://127.0.0.1:43125/callback", "mac-mini.local");
  assert.equal(metadata.application_type, "native");
  assert.deepEqual(metadata.redirect_uris, ["http://127.0.0.1:43125/callback"]);
  assert.equal(metadata.client_name, "Frely CLI Cloud (mac-mini.local)");
  assert.equal(metadata.token_endpoint_auth_method, "none");
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

test("a connection failure keeps its real cause on one line of at most 200 characters", () => {
  assert.equal(failureCause(new Error("web clients require\nhttps   redirect URIs")), ": web clients require https redirect URIs");
  assert.equal(failureCause(new Error("x".repeat(500))).length, 2 + 200);
  assert.equal(failureCause(undefined), "");
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
