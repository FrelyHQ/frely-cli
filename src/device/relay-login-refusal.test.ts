import assert from "node:assert/strict";
import test from "node:test";
import { relayLoginRefusal } from "./relay-client.js";

test("a refused OAuth login stops the relay loop instead of retrying the dead refresh token", () => {
  // This is exactly what refreshOAuthCredential() throws for a 400/401 with an OAuth error code.
  assert.match(relayLoginRefusal(new Error("Frely login expired. Run `frely login`.")) ?? "", /frely login/i);
  assert.match(relayLoginRefusal(new Error("MCP_AUTHORIZATION_EXPIRED: run frely link on to renew.")) ?? "", /frely login/i);
  assert.match(relayLoginRefusal(new Error("No Frely login is stored. Run `frely login`.")) ?? "", /frely login/i);
});

test("network, timeout and server errors stay retryable", () => {
  for (const error of [
    new Error("fetch failed"),
    new Error("Frely Device Relay request timed out."),
    new Error("Server error (502)"),
    new Error("WebSocket closed (1006)"),
    new TypeError("boom"),
  ]) {
    assert.equal(relayLoginRefusal(error), null, error.message);
  }
  assert.equal(relayLoginRefusal(null), null);
});
