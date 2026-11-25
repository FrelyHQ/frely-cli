import test from "node:test";
import { join } from "node:path";
import assert from "node:assert/strict";
import { safeEnv } from "../runtime/workspace.js";
import { defaultPasswordPipe, bitwardenDataDir, bwEnv, createVault, INSTALL_HINT, LOCKED_HINT, LOGIN_HINT, SYNC_MIN_INTERVAL_MS, VAULT_TTL_MS, VaultLockedError, type BwResult } from "./bitwarden.js";

const MASTER = "master-password-for-tests";
const SESSION = "session-key-for-tests";
interface Call { args: string[]; env: Record<string, string> }

function fake(handler: (args: string[], env: Record<string, string>) => Partial<BwResult>, extra: { env?: NodeJS.ProcessEnv } = {}) {
  const calls: Call[] = [];
  let clock = 1_000_000;
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const fed: string[] = [];
  let pipeClosed = 0;
  const vault = createVault({
    pipe: async () => ({ path: "/tmp/fake-pw-fifo", feed: async (master) => { fed.push(Buffer.from(master).toString("utf8")); }, close: async () => { pipeClosed += 1; } }),
    run: async (args, env) => { calls.push({ args, env }); return { code: 0, stdout: "", stderr: "", ...handler(args, env) }; },
    now: () => clock,
    schedule: (fn, ms) => { const timer = { fn, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    env: { PATH: "/usr/bin", HOME: "/home/test", XDG_CONFIG_HOME: "/home/test/.config", SECRET_TOKEN: "do-not-pass", ...extra.env },
  });
  return { vault, calls, timers, fed, pipe: { get closed() { return pipeClosed; } }, advance: (ms: number) => { clock += ms; } };
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

test("unlock runs bw non-interactively with a minimal environment; the master password goes only through the password pipe", async () => {
  const { vault, calls, fed, pipe } = fake(unlocked([]), { env: { NODE_EXTRA_CA_CERTS: "/etc/ca.pem" } });
  const receipt = await vault.unlock(Buffer.from(MASTER));
  assert.equal(receipt.locksAt, new Date(1_000_000 + VAULT_TTL_MS).toISOString());
  assert.equal(VAULT_TTL_MS, 8 * 3600_000);
  for (const call of calls) assert.ok(call.args.includes("--nointeraction"), call.args.join(" "));
  const unlock = calls.find((call) => call.args[0] === "unlock")!;
  assert.deepEqual(unlock.args, ["unlock", "--passwordfile", "/tmp/fake-pw-fifo", "--raw", "--nointeraction"]);
  assert.deepEqual(Object.keys(unlock.env).sort(), ["BITWARDENCLI_APPDATA_DIR", "HOME", "NODE_EXTRA_CA_CERTS", "PATH"]);
  assert.equal(unlock.env.BITWARDENCLI_APPDATA_DIR, join("/home/test", ".config", "frely", "bitwarden"));
  assert.deepEqual(fed, [MASTER]);
  assert.equal(pipe.closed, 1);
  assert.equal(JSON.stringify(calls).includes(MASTER), false);
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

test("the real password pipe is a 0700-folder FIFO that a reader gets the first line from, and it is removed on close", { skip: process.platform === "win32" && "FIFOs are POSIX-only; the vault runs on macOS." }, async () => {
  const { existsSync, statSync } = await import("node:fs");
  const { readFile } = await import("node:fs/promises");
  const pipe = await defaultPasswordPipe();
  const reader = readFile(pipe.path, "utf8");
  await pipe.feed(Buffer.from(MASTER), new AbortController().signal);
  assert.equal(await reader, `${MASTER}\n`);
  assert.equal(statSync(pipe.path).isFIFO(), true);
  await pipe.close();
  assert.equal(existsSync(pipe.path), false);
});

test("a bw that never opens the pipe does not hang the unlock, and the password is not left anywhere", { skip: process.platform === "win32" && "FIFOs are POSIX-only; the vault runs on macOS." }, async () => {
  const { existsSync } = await import("node:fs");
  const real = await defaultPasswordPipe();
  let path = "";
  const vault = createVault({
    pipe: async () => { path = real.path; return real; },
    run: async (args) => args[0] === "status" ? { code: 0, stdout: JSON.stringify({ status: "locked" }), stderr: "" } : { code: 1, stdout: "", stderr: "failed" },
    schedule: () => () => undefined,
    env: { PATH: "/usr/bin", HOME: "/home/test" },
  });
  await assert.rejects(vault.unlock(Buffer.from(MASTER)), /did not unlock/u);
  assert.equal(existsSync(path), false);
});

test("with a bw stand-in on PATH the real runner and pipe unlock without the password in the environment or arguments", { skip: process.platform === "win32" && "FIFOs are POSIX-only; the vault runs on macOS." }, async () => {
  const { chmodSync, mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "fake-bw-"));
  const seen = join(dir, "seen");
  // Like bw: `status` answers locked, `unlock --passwordfile F --raw` reads the first line of F, checks it, prints a session key; env and argv are logged.
  writeFileSync(join(dir, "bw"), `#!/bin/sh
echo "$@" >> "${seen}.args"; env >> "${seen}.env"
case "$1" in
  status) echo '{"status":"locked"}';;
  unlock) read line < "$3"; if [ "$line" = "${MASTER}" ]; then echo ${SESSION}; else echo bad >&2; exit 1; fi;;
  *) exit 0;;
esac
`);
  chmodSync(join(dir, "bw"), 0o755);
  const vault = createVault({ schedule: () => () => undefined, env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, XDG_CONFIG_HOME: join(dir, "cfg") } });
  const master = Buffer.from(MASTER);
  const receipt = await vault.unlock(master);
  assert.equal(vault.status().status, "unlocked");
  assert.ok(receipt.locksAt);
  const logged = readFileSync(`${seen}.args`, "utf8") + readFileSync(`${seen}.env`, "utf8");
  assert.equal(logged.includes(MASTER), false);
  assert.match(logged, /unlock --passwordfile .*\/pw --raw --nointeraction/u);
});

const syncs = (calls: Call[]) => calls.filter((call) => call.args[0] === "sync").length;

test("unlock syncs once; a miss syncs again only after the throttle and then looks again", async () => {
  const { vault, calls, advance } = fake(unlocked([]));
  await vault.unlock(Buffer.from(MASTER));
  assert.equal(syncs(calls), 1);
  assert.equal((await vault.findLogin("https://example.com")).status, "no_login_found");
  assert.equal(syncs(calls), 1);
  advance(SYNC_MIN_INTERVAL_MS + 1);
  assert.equal((await vault.findLogin("https://example.com")).status, "no_login_found");
  assert.equal(syncs(calls), 2);
  assert.equal(calls.filter((call) => call.args[0] === "list").length, 3);
});

test("a login added elsewhere is found after the miss syncs", async () => {
  let synced = false;
  const { vault, advance } = fake((args) => args[0] === "sync" ? ((synced = true), {}) : unlocked(synced ? [item("1", ["https://example.com/login"])] : [])(args));
  await vault.unlock(Buffer.from(MASTER));
  synced = false;
  advance(SYNC_MIN_INTERVAL_MS + 1);
  assert.equal((await vault.findLogin("https://example.com")).status, "found");
});

test("saveLogin sends base64 JSON on stdin only, then zeroes it; no argument or variable carries the values", async () => {
  const stdins: Buffer[] = [];
  const seen: string[] = [];
  const calls: Call[] = [];
  const vault = createVault({
    pipe: async () => ({ path: "/tmp/p", feed: async () => undefined, close: async () => undefined }),
    run: async (args, env, _t, stdin) => { calls.push({ args, env }); if (stdin) { stdins.push(stdin); seen.push(Buffer.from(stdin.toString("utf8"), "base64").toString("utf8")); }
      return { code: 0, stderr: "", stdout: args[0] === "status" ? JSON.stringify({ status: "locked" }) : args[0] === "unlock" ? `${SESSION}\n` : args[0] === "list" ? "[]" : "" }; },
    env: { PATH: "/usr/bin", HOME: "/home/test" }, schedule: () => () => undefined,
  });
  await assert.rejects(vault.saveLogin("https://example.com", { name: "Example", username: "u@example.com", password: "pw-SECRET" }), VaultLockedError);
  await vault.unlock(Buffer.from(MASTER));
  assert.deepEqual(await vault.saveLogin("https://example.com", { name: "Example", username: "u@example.com", password: "pw-SECRET", totp: "JBSWY3DP" }), { status: "saved", hasTotp: true });
  const create = calls.find((call) => call.args[0] === "create")!;
  assert.deepEqual(create.args, ["create", "item", "--nointeraction"]);
  assert.equal(create.env.BW_SESSION, SESSION);
  assert.equal(JSON.stringify(calls.map((call) => [call.args, { ...call.env, BW_SESSION: "" }])).includes("pw-SECRET"), false);
  assert.deepEqual(JSON.parse(seen[0]!), { type: 1, name: "Example", notes: null, favorite: false, login: { username: "u@example.com", password: "pw-SECRET", totp: "JBSWY3DP", uris: [{ uri: "https://example.com", match: null }] } });
  assert.equal(stdins[0]!.every((byte) => byte === 0), true);
});

test("saveLogin refuses an origin that already has a login, a non-https origin, and hides the values in a bw error", async () => {
  const dup = fake(unlocked([item("1", ["https://example.com/login"])]));
  await dup.vault.unlock(Buffer.from(MASTER));
  assert.deepEqual(await dup.vault.saveLogin("https://example.com", { name: "E", username: "u", password: "p" }), { status: "exists" });
  assert.equal(dup.calls.some((call) => call.args[0] === "create"), false);
  await assert.rejects(dup.vault.saveLogin("http://example.com", { name: "E", username: "u", password: "p" }), /https/u);
  // a subdomain item does not count as the same site
  const sub = fake((args) => args[0] === "create" ? { code: 1, stderr: "bad pw-SECRET for wyatt" } : unlocked([item("2", ["https://app.example.com"])])(args));
  await sub.vault.unlock(Buffer.from(MASTER));
  await assert.rejects(sub.vault.saveLogin("https://example.com", { name: "E", username: "wyatt", password: "pw-SECRET" }), (error: Error) => !error.message.includes("pw-SECRET") && !error.message.includes("wyatt") && /\[hidden\]/u.test(error.message));
});
