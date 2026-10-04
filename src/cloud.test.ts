import assert from "node:assert/strict";
import test from "node:test";
import { cloudClientName, permissionHint } from "./cloud.js";

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
