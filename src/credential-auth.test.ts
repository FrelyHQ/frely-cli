import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { authConfigPath, inspectAuth, loginDevice, logout, probeCredentialStore } from "./auth.js";
import { basicCredentialStore as credentialStore } from "./credential-basic.js";
import { useMemoryCredentialStore } from "./test-support.js";

async function setup(t: TestContext, configured = false) {
  const directory = await mkdtemp(join(tmpdir(), "frely-credential-auth-"));
  const oldRoot = process.env.XDG_CONFIG_HOME;
  const oldMode = process.env.FRELY_CREDENTIAL_STORE;
  const oldKey = process.env.FRELY_CREDENTIAL_KEY;
  const oldFetch = globalThis.fetch;
  const restore = useMemoryCredentialStore();
  process.env.XDG_CONFIG_HOME = directory;
  process.env.FRELY_CREDENTIAL_STORE = "system";
  delete process.env.FRELY_CREDENTIAL_KEY;
  t.after(async () => {
    restore();
    globalThis.fetch = oldFetch;
    for (const [name, value] of Object.entries({ XDG_CONFIG_HOME: oldRoot, FRELY_CREDENTIAL_STORE: oldMode, FRELY_CREDENTIAL_KEY: oldKey })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  if (configured) {
    const path = authConfigPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ version: 2, relayUrl: "https://test.invalid", user: { id: "synthetic-user", email: "user@example.com" } }), { mode: 0o600 });
  }
}

test("login rejects unavailable storage before starting device authorization", async (t) => {
  await setup(t);
  let requested = false;
  globalThis.fetch = async () => { requested = true; throw new Error("must not request"); };
  credentialStore.setPassword = async () => { throw new Error("credential service locked"); };
  await assert.rejects(loginDevice("https://test.invalid"), /credential service locked/);
  assert.equal(requested, false);
});

test("doctor probe treats an unsuccessful deletion as a failure", async (t) => {
  await setup(t);
  credentialStore.deletePassword = async () => false;
  await assert.rejects(probeCredentialStore(), /deletion failed/);
});

test("auth inspection reports store errors instead of crashing diagnostics", async (t) => {
  await setup(t, true);
  credentialStore.getPassword = async () => { throw new Error("credential service locked"); };
  const result = await inspectAuth();
  assert.equal(result.configured, true);
  assert.equal(result.credentialStored, false);
  assert.equal(result.credentialError, "credential service locked");
  assert.ok(result.credentialBackend);
});

test("logout retains configuration if credential deletion fails", async (t) => {
  await setup(t, true);
  await credentialStore.setPassword("frely-cli-basic-v1", "https://test.invalid", JSON.stringify({version:1,type:"basic-oauth",accessToken:"synthetic",expiresAt:Date.now()+3600000}));
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  credentialStore.deletePassword = async () => { throw new Error("credential deletion denied"); };
  await assert.rejects(logout(), /credential deletion denied/);
  assert.ok((await readFile(authConfigPath(), "utf8")).includes("synthetic-user"));
});
