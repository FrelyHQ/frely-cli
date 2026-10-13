import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { applyDataDir, resolveDataDir } from "./data-dir.js";
import { sensitiveReadPaths, protectedWriteDenials } from "./runtime/sandbox.js";
import { createSystemCredentialStore } from "./credential-system.js";
import type { CredentialStore } from "./credential-store.js";

const home = "/home/dev";

test("relative data dir names resolve below ~/.config/frely/accounts, absolute paths stay", () => {
  assert.equal(resolveDataDir("work", home), join(home, ".config", "frely", "accounts", "work"));
  assert.equal(resolveDataDir("/srv/second", home), "/srv/second");
  assert.throws(() => resolveDataDir("../x", home));
  assert.throws(() => resolveDataDir(" ", home));
});

test("applyDataDir strips the flag and points every XDG location at the directory", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.deepEqual(applyDataDir(["--data-dir", "/srv/a", "mcp", "status"], env, home), ["mcp", "status"]);
  assert.equal(env.FRELY_DATA_DIR, "/srv/a");
  assert.equal(env.XDG_CONFIG_HOME, "/srv/a");
  assert.equal(env.XDG_STATE_HOME, "/srv/a/state");
  assert.equal(env.XDG_RUNTIME_DIR, "/srv/a/run");
  const viaEnv: NodeJS.ProcessEnv = { FRELY_HOME: "b" };
  applyDataDir(["login"], viaEnv, home);
  assert.equal(viaEnv.FRELY_DATA_DIR, join(home, ".config", "frely", "accounts", "b"));
  assert.throws(() => applyDataDir(["--data-dir"], {}, home));
});

test("without a data dir nothing changes", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.deepEqual(applyDataDir(["login"], env, home), ["login"]);
  assert.equal(env.FRELY_DATA_DIR, undefined);
  assert.equal(env.XDG_CONFIG_HOME, undefined);
});

test("the sandbox denies reading and writing a custom data directory", () => {
  const previous = process.env.FRELY_DATA_DIR;
  process.env.FRELY_DATA_DIR = "/srv/second-account";
  try {
    assert.ok(sensitiveReadPaths().includes("/srv/second-account"));
    assert.ok(protectedWriteDenials([]).includes("/srv/second-account"));
  } finally { if (previous === undefined) delete process.env.FRELY_DATA_DIR; else process.env.FRELY_DATA_DIR = previous; }
});

test("a data dir never reads or deletes the shared OS vault entries", async () => {
  const calls: string[] = [];
  const native: CredentialStore = {
    async getPassword() { calls.push("get"); return "legacy"; },
    async setPassword() { calls.push("set"); },
    async deletePassword() { calls.push("delete"); return true; },
  };
  const previous = process.env.FRELY_DATA_DIR;
  process.env.FRELY_DATA_DIR = "/srv/second-account";
  try {
    const store = createSystemCredentialStore("/nonexistent-vault-root", native);
    assert.equal(await store.getPassword("svc", "acct").catch(() => null), null);
    assert.equal(calls.includes("delete"), false);
  } finally { if (previous === undefined) delete process.env.FRELY_DATA_DIR; else process.env.FRELY_DATA_DIR = previous; }
});
