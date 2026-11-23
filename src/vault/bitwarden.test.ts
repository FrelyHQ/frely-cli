import test from "node:test";
import { join } from "node:path";
import assert from "node:assert/strict";
import { safeEnv } from "../runtime/workspace.js";
import { bitwardenDataDir, bwEnv, createVault, fileSessionStore, type SessionRecord, type SessionStore, INSTALL_HINT, LOCKED_HINT, LOGIN_HINT, VAULT_TTL_MS, VaultLockedError, type BwResult } from "./bitwarden.js";

const MASTER = "master-password-for-tests";
const SESSION = "session-key-for-tests";
interface Call { args: string[]; env: Record<string, string> }

function fake(handler: (args: string[], env: Record<string, string>) => Partial<BwResult>, extra: { env?: NodeJS.ProcessEnv } = {}) {
  const calls: Call[] = [];
  let clock = 1_000_000;
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  let saved: SessionRecord | null = null;
  const store: SessionStore = { load: () => saved, save: (record) => { saved = record; }, clear: () => { saved = null; } };
  const vault = createVault({
    store,
    run: async (args, env) => { calls.push({ args, env }); return { code: 0, stdout: "", stderr: "", ...handler(args, env) }; },
    now: () => clock,
    schedule: (fn, ms) => { const timer = { fn, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    env: { PATH: "/usr/bin", HOME: "/home/test", XDG_CONFIG_HOME: "/home/test/.config", SECRET_TOKEN: "do-not-pass", ...extra.env },
  });
  return { vault, calls, timers, store, advance: (ms: number) => { clock += ms; } };
}

const item = (id: string, uris: string[], over: Record<string, unknown> = {}) => ({ id, type: 1, login: { username: `user-${id}`, password: `pass-${id}`, totp: null, uris: uris.map((uri) => ({ uri })), ...over } });
const unlocked = (list: unknown[], totp = "123456") => (args: string[]): Partial<BwResult> => {
  if (args[0] === "status") return { stdout: JSON.stringify({ status: "locked" }) };
  if (args[0] === "unlock") return { stdout: `${SESSION}\n` };
  if (args[0] === "list") return { stdout: JSON.stringify(list) };
  if (args[0] === "get") return { stdout: `${totp}\n` };
  return {};
};

test("bw missing and bw logged out give the owner a next step", async () => {
  const missing = fake(() => ({ code: null, missing: true }));
  await assert.rejects(missing.vault.unlock(Buffer.from(MASTER)), (error: Error) => error.message === INSTALL_HINT && /brew install bitwarden-cli/u.test(error.message));
  const loggedOut = fake((args) => args[0] === "status" ? { stdout: JSON.stringify({ status: "unauthenticated" }) } : {});
  await assert.rejects(loggedOut.vault.unlock(Buffer.from(MASTER)), (error: Error) => error.message === LOGIN_HINT && /frely vault login/u.test(error.message));
  assert.equal(loggedOut.calls.some((call) => call.args[0] === "unlock"), false);
  assert.equal(loggedOut.vault.status().status, "locked");
});

test("unlock runs bw non-interactively with a minimal environment; the master password is only in the unlock call's environment", async () => {
  const { vault, calls } = fake(unlocked([]), { env: { NODE_EXTRA_CA_CERTS: "/etc/ca.pem" } });
  const receipt = await vault.unlock(Buffer.from(MASTER));
  assert.equal(receipt.locksAt, new Date(1_000_000 + VAULT_TTL_MS).toISOString());
  assert.equal(VAULT_TTL_MS, 8 * 3600_000);
  for (const call of calls) assert.ok(call.args.includes("--nointeraction"), call.args.join(" "));
  const unlock = calls.find((call) => call.args[0] === "unlock")!;
  assert.deepEqual(unlock.args, ["unlock", "--passwordenv", "BW_PASSWORD", "--raw", "--nointeraction"]);
  assert.deepEqual(Object.keys(unlock.env).sort(), ["BITWARDENCLI_APPDATA_DIR", "BW_PASSWORD", "HOME", "NODE_EXTRA_CA_CERTS", "PATH"]);
  assert.equal(unlock.env.BITWARDENCLI_APPDATA_DIR, join("/home/test", ".config", "frely", "bitwarden"));
  assert.equal(unlock.env.BW_PASSWORD, MASTER);
  assert.equal(calls.filter((call) => "BW_PASSWORD" in call.env).length, 1);
  assert.equal(JSON.stringify(calls.map((call) => call.args)).includes(MASTER), false);
  assert.equal(vault.status().status, "unlocked");
});

test("a wrong master password leaves the vault locked and the message has no secret", async () => {
  const { vault } = fake((args) => args[0] === "status" ? { stdout: JSON.stringify({ status: "locked" }) } : { code: 1, stderr: `Invalid master password ${MASTER}` });
  await assert.rejects(vault.unlock(Buffer.from(MASTER)), (error: Error) => !error.message.includes(MASTER) && /did not unlock/u.test(error.message));
  assert.equal(vault.status().status, "locked");
});

test("the session key is cleared when the 8 hour timer fires, and also when time has passed without it", async () => {
  const a = fake(unlocked([]));
  await a.vault.unlock(Buffer.from(MASTER));
  assert.equal(a.timers.at(-1)!.ms, VAULT_TTL_MS);
  a.timers.at(-1)!.fn();
  assert.equal(a.vault.status().status, "locked");
  assert.equal(a.calls.at(-1)!.args[0], "lock");
  await assert.rejects(a.vault.findLogin("https://example.com"), VaultLockedError);

  const b = fake(unlocked([item("1", ["https://example.com"])]));
  await b.vault.unlock(Buffer.from(MASTER));
  b.advance(VAULT_TTL_MS - 1);
  assert.equal(b.vault.status().status, "unlocked");
  b.advance(1);
  assert.equal(b.vault.status().status, "locked");
  assert.equal(b.timers[0]!.cancelled, true);
  await assert.rejects(b.vault.findLogin("https://example.com"), (error: Error) => error.message === LOCKED_HINT);
});

test("findLogin matches the exact https origin only: http pages, look-alike hosts and http entries never match", async () => {
  const list = [
    item("sub", ["https://login.example.com/path"]),
    item("evil", ["https://example.com.evil.test", "https://notexample.com"]),
    item("plain", ["http://example.com"]),
    item("port", ["https://example.com:8443"]),
    item("note", [], { uris: undefined }),
  ];
  const { vault, calls } = fake(unlocked(list));
  await vault.unlock(Buffer.from(MASTER));
  assert.deepEqual(await vault.findLogin("https://example.com"), { status: "no_login_found" });
  assert.deepEqual(await vault.findLogin("http://example.com"), { status: "no_login_found" });
  assert.equal(calls.filter((call) => call.args[0] === "list").length, 1, "an http origin is not even looked up");
  const found = await vault.findLogin("https://login.example.com");
  assert.deepEqual(found, { status: "found", username: "user-sub", password: "pass-sub" });
});

test("several entries for one origin are ambiguous; the session key goes in the environment, never in argv", async () => {
  const { vault, calls } = fake(unlocked([item("a", ["https://example.com/a"]), item("b", ["https://example.com/b"])]));
  await vault.unlock(Buffer.from(MASTER));
  assert.deepEqual(await vault.findLogin("https://example.com"), { status: "ambiguous" });
  const list = calls.find((call) => call.args[0] === "list")!;
  assert.deepEqual(list.args, ["list", "items", "--url", "https://example.com", "--nointeraction"]);
  assert.equal(list.env.BW_SESSION, SESSION);
  assert.equal(JSON.stringify(calls.map((call) => call.args)).includes(SESSION), false);
  assert.equal("BW_PASSWORD" in list.env, false);
  assert.equal("SECRET_TOKEN" in list.env, false);
});

test("a login with a TOTP seed asks bw for the current code; a failing code lookup still returns the login", async () => {
  const withTotp = item("t", ["https://example.com"], { totp: "otpauth://totp/x?secret=ABC" });
  const ok = fake(unlocked([withTotp], "654321"));
  await ok.vault.unlock(Buffer.from(MASTER));
  assert.deepEqual(await ok.vault.findLogin("https://example.com"), { status: "found", username: "user-t", password: "pass-t", totp: "654321" });
  assert.deepEqual(ok.calls.find((call) => call.args[0] === "get")!.args, ["get", "totp", "t", "--nointeraction"]);
  const bad = fake((args) => args[0] === "get" ? { code: 1, stderr: "nope" } : unlocked([withTotp])(args));
  await bad.vault.unlock(Buffer.from(MASTER));
  assert.deepEqual(await bad.vault.findLogin("https://example.com"), { status: "found", username: "user-t", password: "pass-t" });
});

test("a session bw no longer accepts clears the in-memory state and reports locked", async () => {
  let expired = false;
  const { vault } = fake((args) => expired && args[0] === "list" ? { code: 1, stderr: "Vault is locked." } : unlocked([])(args));
  await vault.unlock(Buffer.from(MASTER));
  expired = true;
  await assert.rejects(vault.findLogin("https://example.com"), VaultLockedError);
  assert.equal(vault.status().status, "locked");
});

test("neither the master password nor the session key is in the environment commands the AI runs", async () => {
  const { vault } = fake(unlocked([item("1", ["https://example.com"])]));
  await vault.unlock(Buffer.from(MASTER));
  await vault.findLogin("https://example.com");
  for (const env of [process.env, safeEnv()]) assert.equal(Object.keys(env).some((key) => /^BW_|BITWARDEN/iu.test(key)), false);
  assert.equal(JSON.stringify(process.env).includes(SESSION) || JSON.stringify(process.env).includes(MASTER), false);
});

test("the data directory follows the config home, which is inside the folders the sandbox hides", () => {
  assert.equal(bitwardenDataDir({ XDG_CONFIG_HOME: "/data/acct" }, "/h"), join("/data/acct", "frely", "bitwarden"));
  assert.equal(bitwardenDataDir({}, "/h"), join("/h", ".config", "frely", "bitwarden"));
  assert.deepEqual(Object.keys(bwEnv({}, { PATH: "/p", HOME: "/h", FOO: "x" })).sort(), ["BITWARDENCLI_APPDATA_DIR", "HOME", "PATH"]);
});

test("the unlocked session survives a restart until the TTL, and a lock anywhere locks everyone", async () => {
  const first = fake(unlocked([]));
  await first.vault.unlock(Buffer.from(MASTER));
  assert.equal(first.store.load()!.session, SESSION);
  const calls: string[][] = [];
  const second = createVault({ store: first.store, now: () => 1_000_000 + 60_000, schedule: () => () => undefined, run: async (args) => { calls.push(args); return { code: 0, stdout: JSON.stringify([item("1", ["https://a.example"])]), stderr: "" }; } });
  assert.equal(second.status().status, "unlocked");
  assert.equal((await second.findLogin("https://a.example")).status, "found");
  assert.equal(calls.some((args) => args[0] === "unlock"), false);
  first.store.clear();
  assert.equal(second.status().status, "locked");
});

test("an expired session file is ignored and removed", () => {
  let r: SessionRecord | null = { session: SESSION, lockAt: 500 };
  const store: SessionStore = { load: () => r, save: (x) => { r = x; }, clear: () => { r = null; } };
  const vault = createVault({ store, now: () => 1_000, schedule: () => () => undefined, run: async () => ({ code: 0, stdout: "", stderr: "" }) });
  assert.equal(vault.status().status, "locked");
  assert.equal(store.load(), null);
});

test("the session file is 0600 and gone after clear", async () => {
  const { mkdtempSync, statSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = join(mkdtempSync(join(tmpdir(), "vault-")), "bitwarden");
  const store = fileSessionStore(dir);
  store.save({ session: SESSION, lockAt: 42 });
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "session.json")).mode & 0o777, 0o600);
  assert.deepEqual(store.load(), { session: SESSION, lockAt: 42 });
  store.clear();
  assert.equal(existsSync(join(dir, "session.json")), false);
  assert.equal(store.load(), null);
});
