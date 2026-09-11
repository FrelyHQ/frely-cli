import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import keytar from "keytar";
import { inspectAuth, login, logout } from "./auth.js";

test("login extracts the session cookie from a combined Set-Cookie header", async () => {
  const configRoot = await mkdtemp(join(tmpdir(), "frely-cli-auth-"));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const previousFetch = globalThis.fetch;
  process.env.XDG_CONFIG_HOME = configRoot;
  const relayUrl = "http://127.0.0.1:43127";
  const account = new URL(relayUrl).origin;
  const response = new Response(JSON.stringify({ user: { id: "user_test", email: "user@example.com" } }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": "landing_registration=; Path=/, friday_session_token=test-session; Path=/; HttpOnly",
    },
  });
  globalThis.fetch = async () => response;
  try {
    const user = await login("user@example.com", "password", relayUrl);
    assert.deepEqual(user, { id: "user_test", email: "user@example.com" });
    const auth = await inspectAuth();
    assert.equal(auth.configured, true);
    assert.equal(auth.credentialStored, true);
  } finally {
    await keytar.deletePassword("frely-cli", account).catch(() => false);
    await logout().catch(() => undefined);
    globalThis.fetch = previousFetch;
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    await rm(configRoot, { recursive: true, force: true });
  }
});
