import test from "node:test";
import assert from "node:assert/strict";

test("only a definitive answer from the web app counts as an authorization failure", async () => {
  const { isDefinitiveAuthorizationFailure } = await import("./mcp-authorization.js");
  assert.equal(isDefinitiveAuthorizationFailure(new Error("MCP_AUTHORIZATION_EXPIRED: run frely mcp start to renew.")), true);
  assert.equal(isDefinitiveAuthorizationFailure(new Error("MCP authorization changed. Run frely mcp start --days 90 to renew.")), true);
  assert.equal(isDefinitiveAuthorizationFailure(new Error("Frely login expired. Run `frely login`.")), true);
  assert.equal(isDefinitiveAuthorizationFailure(new Error("fetch failed")), false);
  assert.equal(isDefinitiveAuthorizationFailure(new Error("Frely Device Relay request timed out.")), false);
  assert.equal(isDefinitiveAuthorizationFailure(new Error("Server error (502)")), false);
});
