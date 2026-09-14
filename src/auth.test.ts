import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authConfigPath, inspectAuth, login, logout } from "./auth.js";
import { credentialStore } from "./credential-store.js";
import { basicCredentialStore } from "./credential-basic.js";
import { useMemoryCredentialStore } from "./test-support.js";

test("basic OAuth login and refresh do not require the MCP secure store", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frely-cli-basic-auth-"));
  const oldFetch = globalThis.fetch;
  const previous = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FRELY_NO_BROWSER: process.env.FRELY_NO_BROWSER };
  const restore = useMemoryCredentialStore();
  process.env.XDG_CONFIG_HOME = directory;
  process.env.FRELY_NO_BROWSER = "1";
  for (const name of ["getPassword", "setPassword", "deletePassword"] as const) credentialStore[name] = async () => { throw new Error("MCP keychain locked"); };
  t.after(async () => {
    restore(); globalThis.fetch = oldFetch;
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(directory, { recursive: true, force: true });
  });
  let requestedScope = "";
  let requestedClient = "";
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/auth/device/code") {
      const form = new URLSearchParams(String(options?.body));
      requestedScope = form.get("scope") ?? ""; requestedClient = form.get("client_id") ?? "";
      return Response.json({ device_code: "synthetic-code", user_code: "SYNTH", verification_uri: "https://test.invalid/device", verification_uri_complete: "https://test.invalid/device?user_code=SYNTH", expires_in: 300, interval: 1 });
    }
    if (path === "/api/auth/oauth2/token") return Response.json({ access_token: "synthetic-basic", refresh_token: "synthetic-refresh", token_type: "bearer", expires_in: 3600 });
    if (path === "/api/auth/me") return Response.json({ user: { id: "user_test", email: "user@example.com" } });
    if (path === "/api/auth/oauth2/revoke") return Response.json({});
    throw new Error("Unexpected synthetic endpoint");
  };
  assert.deepEqual(await login("https://test.invalid"), { id: "user_test", email: "user@example.com" });
  assert.equal(requestedClient, "frely-cli-basic");
  assert.equal(requestedScope.includes("device-relay:enroll"), false);
  assert.equal(requestedScope.includes("device-relay:connect"), false);
  assert.equal((await inspectAuth()).credentialStored, true);
  const stored = await basicCredentialStore.getPassword("frely-cli-basic-v1", "https://test.invalid");
  assert.equal(JSON.parse(stored!).type, "basic-oauth");
  assert.equal((await readFile(authConfigPath(), "utf8")).includes("synthetic-basic"), false);
  await logout();
  assert.equal(await basicCredentialStore.getPassword("frely-cli-basic-v1", "https://test.invalid"), null);
});

test("legacy password login cannot copy an account cookie into basic storage", async () => {
  await assert.rejects(login("user@example.com", "synthetic-password", "https://test.invalid"), /Password\/cookie login is not supported/);
});
