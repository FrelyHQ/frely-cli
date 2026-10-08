import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { authConfigPath, inspectAuth, LOGIN_REFRESH_UNAVAILABLE, login, loginDevice, logout, normalizeRelayUrl, requireLogin } from "./auth.js";
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

test("login binds the session to the local device id when the Relay returns a session id", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frely-cli-session-bind-"));
  const oldFetch = globalThis.fetch;
  const previous = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FRELY_NO_BROWSER: process.env.FRELY_NO_BROWSER };
  const restore = useMemoryCredentialStore();
  process.env.XDG_CONFIG_HOME = directory;
  process.env.FRELY_NO_BROWSER = "1";
  t.after(async () => {
    restore(); globalThis.fetch = oldFetch;
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(directory, { recursive: true, force: true });
  });
  let tokenBody = "";
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/auth/device/code") {
      return Response.json({ device_code: "synthetic-code", user_code: "SYNTH", verification_uri: "https://test.invalid/device", verification_uri_complete: "https://test.invalid/device?user_code=SYNTH", expires_in: 300, interval: 1 });
    }
    if (path === "/api/auth/oauth2/token") {
      tokenBody = String(options?.body);
      return Response.json({ access_token: "synthetic-basic", refresh_token: "synthetic-refresh", token_type: "bearer", expires_in: 3600, frely_cli_session_id: "cli_sess_abc123" });
    }
    if (path === "/api/auth/me") return Response.json({ user: { id: "user_test", email: "user@example.com" } });
    throw new Error("Unexpected synthetic endpoint");
  };
  const result = await loginDevice("https://test.invalid");
  assert.equal(result.sessionBound, true);
  assert.match(tokenBody, /session_binding_device_id=frd_local_/);
  const stored = await basicCredentialStore.getPassword("frely-cli-basic-v1", "https://test.invalid");
  assert.equal(JSON.parse(stored!).sessionBindingId, "cli_sess_abc123");
  const config = JSON.parse(await readFile(authConfigPath(), "utf8"));
  assert.match(config.deviceId, /frd_local_/);
  await logout();
});

test("login without a session id from an older Relay stays backward compatible", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frely-cli-session-legacy-"));
  const oldFetch = globalThis.fetch;
  const previous = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FRELY_NO_BROWSER: process.env.FRELY_NO_BROWSER };
  const restore = useMemoryCredentialStore();
  process.env.XDG_CONFIG_HOME = directory;
  process.env.FRELY_NO_BROWSER = "1";
  t.after(async () => {
    restore(); globalThis.fetch = oldFetch;
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(directory, { recursive: true, force: true });
  });
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/auth/device/code") {
      return Response.json({ device_code: "synthetic-code", user_code: "SYNTH", verification_uri: "https://test.invalid/device", verification_uri_complete: "https://test.invalid/device?user_code=SYNTH", expires_in: 300, interval: 1 });
    }
    if (path === "/api/auth/oauth2/token") return Response.json({ access_token: "synthetic-basic", token_type: "bearer", expires_in: 3600 });
    if (path === "/api/auth/me") return Response.json({ user: { id: "user_test", email: "user@example.com" } });
    throw new Error("Unexpected synthetic endpoint");
  };
  const result = await loginDevice("https://test.invalid");
  assert.equal(result.sessionBound, false);
  const stored = await basicCredentialStore.getPassword("frely-cli-basic-v1", "https://test.invalid");
  assert.equal(JSON.parse(stored!).sessionBindingId, undefined);
  await logout();
});

test("defaults to frely.cloud and asks logins saved on app.frely.cloud to log in again", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frely-cli-retired-relay-"));
  const previous = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FRELY_RELAY_URL: process.env.FRELY_RELAY_URL };
  process.env.XDG_CONFIG_HOME = directory;
  delete process.env.FRELY_RELAY_URL;
  t.after(async () => {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(normalizeRelayUrl(), "https://frely.cloud");
  await mkdir(dirname(authConfigPath()), { recursive: true });
  await writeFile(authConfigPath(), JSON.stringify({ version: 3, relayUrl: "https://app.frely.cloud", user: { id: "user_test", email: "user@example.com" } }));
  await assert.rejects(requireLogin(), /Frely moved to https:\/\/frely\.cloud/);
});

async function withExpiredLogin(t: import("node:test").TestContext, refresh: () => Response | Promise<Response>): Promise<{ refreshCalls: () => number }> {
  const directory = await mkdtemp(join(tmpdir(), "frely-cli-refresh-"));
  const oldFetch = globalThis.fetch;
  const previous = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FRELY_NO_BROWSER: process.env.FRELY_NO_BROWSER };
  const restore = useMemoryCredentialStore();
  process.env.XDG_CONFIG_HOME = directory;
  process.env.FRELY_NO_BROWSER = "1";
  t.after(async () => {
    restore(); globalThis.fetch = oldFetch;
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(directory, { recursive: true, force: true });
  });
  let loggedIn = false;
  let refreshCalls = 0;
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/auth/device/code") {
      return Response.json({ device_code: "synthetic-code", user_code: "SYNTH", verification_uri: "https://test.invalid/device", verification_uri_complete: "https://test.invalid/device?user_code=SYNTH", expires_in: 300, interval: 1 });
    }
    if (path === "/api/auth/oauth2/token") {
      if (!loggedIn) return Response.json({ access_token: "synthetic-basic", refresh_token: "synthetic-refresh", token_type: "bearer", expires_in: 3600 });
      assert.equal(new URLSearchParams(String(options?.body)).get("grant_type"), "refresh_token");
      refreshCalls += 1;
      return refresh();
    }
    if (path === "/api/auth/me") return Response.json({ user: { id: "user_test", email: "user@example.com" } });
    throw new Error("Unexpected synthetic endpoint");
  };
  await loginDevice("https://test.invalid");
  loggedIn = true;
  const stored = JSON.parse((await basicCredentialStore.getPassword("frely-cli-basic-v1", "https://test.invalid"))!);
  await basicCredentialStore.setPassword("frely-cli-basic-v1", "https://test.invalid", JSON.stringify({ ...stored, expiresAt: Date.now() - 1_000 }));
  return { refreshCalls: () => refreshCalls };
}

test("a network failure while refreshing is retried and never reported as a missing login", async (t) => {
  const login = await withExpiredLogin(t, () => { throw new TypeError("fetch failed"); });
  await assert.rejects(requireLogin(), (error: Error) => {
    assert.equal(error.message, LOGIN_REFRESH_UNAVAILABLE);
    return true;
  });
  assert.equal(login.refreshCalls(), 3);
  assert.equal((await inspectAuth()).credentialStored, true);
});

test("a transient 5xx while refreshing recovers on a short retry", async (t) => {
  let calls = 0;
  const login = await withExpiredLogin(t, () => {
    calls += 1;
    return calls === 1 ? new Response("bad gateway", { status: 502 }) : Response.json({ access_token: "synthetic-next", refresh_token: "synthetic-refresh-2", token_type: "bearer", expires_in: 3600 });
  });
  const auth = await requireLogin();
  assert.equal(auth.credential.value, "synthetic-next");
  assert.equal(login.refreshCalls(), 2);
  const stored = JSON.parse((await basicCredentialStore.getPassword("frely-cli-basic-v1", "https://test.invalid"))!);
  assert.equal(stored.refreshToken, "synthetic-refresh-2");
});

test("a rejected refresh token reports an expired login without retrying", async (t) => {
  const login = await withExpiredLogin(t, () => Response.json({ error: "invalid_grant" }, { status: 400 }));
  await assert.rejects(requireLogin(), /Frely login expired\. Run `frely login`\./);
  assert.equal(login.refreshCalls(), 1);
});
