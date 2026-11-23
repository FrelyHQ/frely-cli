import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Script } from "node:vm";
import { LOCKED_HINT, VaultLockedError, type FindLoginResult } from "./bitwarden.js";
import { buildLoginScript, parseLoginUrl, readFifo, siteLogin, siteLoginAvailable, writeFifo, type EgoRun } from "./site-login.js";

const USER = "wyatt@example.com";
const PASS = "correct horse battery staple";
const found: FindLoginResult = { status: "found", username: USER, password: PASS, totp: "424242" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stand-in for ego lite that speaks the same FIFO protocol as the real script, over real FIFOs. */
function fakeEgo(pageOrigin: string, seen: { cred?: Record<string, unknown>; dir?: string; modes?: number[]; script?: string } = {}) {
  return async (run: EgoRun) => {
    seen.script = run.script;
    seen.dir = dirname(run.originFifo);
    seen.modes = [(await stat(seen.dir)).mode & 0o777, (await stat(run.originFifo)).mode & 0o777, (await stat(run.credFifo)).mode & 0o777];
    await sleep(10);
    await writeFifo(run.originFifo, Buffer.from(pageOrigin), run.signal);
    seen.cred = JSON.parse(await readFifo(run.credFifo, run.signal)) as Record<string, unknown>;
    const status = seen.cred.ok ? "submitted" : String(seen.cred.status);
    return { code: 0, stdout: `noise\n${JSON.stringify({ status, origin: pageOrigin, usedTotp: Boolean(seen.cred.totp) })}\n` };
  };
}
const unlocked = () => true;

test("only https URLs without credentials are accepted", () => {
  assert.equal(parseLoginUrl("https://example.com/login?next=/a").hostname, "example.com");
  for (const bad of ["http://example.com", "ftp://example.com", "javascript:alert(1)", "https://u:p@example.com", "https://user@example.com", "", "example.com", 5, "https://" + "a".repeat(2100)]) assert.throws(() => parseLoginUrl(bad), /https URL/u);
});

test("the script embeds the URL and FIFO paths only as JSON strings, and compiles whatever they hold", () => {
  const hostile = `https://example.com/";process.exit(1);//\n </script>\`\${x}`;
  const fifo = `/tmp/a b/"q"\\origin`;
  const script = buildLoginScript({ url: hostile, originFifo: fifo, credFifo: "/tmp/cred" });
  new Script(script);
  assert.ok(script.includes(`const URL_TO_OPEN = ${JSON.stringify(hostile)};`));
  assert.ok(script.includes(`const ORIGIN_FIFO = ${JSON.stringify(fifo)};`));
  assert.equal(script.replace(JSON.stringify(hostile), "").includes("process.exit"), false);
  assert.match(script, /task\.finish\(\{ keep: \[\] \}\)/u);
  assert.match(script, /frely-site-login/u);
});

test("a login is handed over through the FIFO and the receipt carries no credential, URL path or page text", async () => {
  const seen: Parameters<typeof fakeEgo>[1] = {};
  const lookups: string[] = [];
  const receipt = await siteLogin("https://example.com/account/login?token=abc", { isUnlocked: unlocked, findLogin: async (origin) => { lookups.push(origin); return found; }, runEgo: fakeEgo("https://example.com", seen) });
  assert.deepEqual(receipt, { status: "submitted", site: "https://example.com", usedTotp: true });
  assert.deepEqual(Object.keys(receipt).sort(), ["site", "status", "usedTotp"]);
  assert.deepEqual(lookups, ["https://example.com"]);
  assert.deepEqual(seen.cred, { ok: true, username: USER, password: PASS, totp: "424242" });
  const text = JSON.stringify(receipt);
  for (const secret of [USER, PASS, "424242", "account", "token"]) assert.equal(text.includes(secret), false);
  assert.equal(seen.script!.includes(PASS) || seen.script!.includes(USER), false);
  assert.deepEqual(seen.modes, [0o700, 0o600, 0o600]);
  assert.equal(existsSync(seen.dir!), false, "the temporary folder is removed");
});

test("a page that ended up on another host or on http gets no credentials", async () => {
  for (const landed of ["https://evil.example.net", "http://example.com", "https://example.com.evil.test", "not a url"]) {
    const seen: Parameters<typeof fakeEgo>[1] = {};
    let looked = 0;
    const receipt = await siteLogin("https://example.com/login", { isUnlocked: unlocked, findLogin: async () => { looked += 1; return found; }, runEgo: fakeEgo(landed, seen) });
    assert.equal(receipt.status, "redirected", landed);
    assert.equal(receipt.usedTotp, false);
    assert.equal(looked, 0);
    assert.deepEqual(seen.cred, { ok: false, status: "redirected" });
  }
});

test("no saved login and several saved logins are reported, never guessed", async () => {
  for (const status of ["no_login_found", "ambiguous"] as const) {
    const seen: Parameters<typeof fakeEgo>[1] = {};
    const receipt = await siteLogin("https://example.com", { isUnlocked: unlocked, findLogin: async () => ({ status }), runEgo: fakeEgo("https://example.com", seen) });
    assert.deepEqual(receipt, { status, site: "https://example.com", usedTotp: false });
    assert.deepEqual(seen.cred, { ok: false, status });
  }
});

test("an unknown answer from the script becomes no_form and a TOTP is only claimed with a submitted form", async () => {
  const odd = async (run: EgoRun) => { await sleep(10); await writeFifo(run.originFifo, Buffer.from("https://example.com"), run.signal); await readFifo(run.credFifo, run.signal); return { code: 0, stdout: JSON.stringify({ status: "<script>", usedTotp: true }) }; };
  assert.deepEqual(await siteLogin("https://example.com", { isUnlocked: unlocked, findLogin: async () => found, runEgo: odd }), { status: "no_form", site: "https://example.com", usedTotp: false });
});

test("a locked vault answers with the unlock instructions and never starts the browser", async () => {
  let started = 0;
  const runEgo = async () => { started += 1; return { code: 0, stdout: "" }; };
  await assert.rejects(siteLogin("https://example.com", { isUnlocked: () => false, runEgo }), (error: Error) => error.message === LOCKED_HINT && /vault_unlock/u.test(error.message));
  assert.equal(started, 0);
  await assert.rejects(siteLogin("https://example.com", { isUnlocked: unlocked, findLogin: async () => { throw new VaultLockedError(); }, runEgo: fakeEgo("https://example.com") }), (error: Error) => error.message === LOCKED_HINT);
});

test("a script that hangs is stopped at the timeout and a script that dies early ends the call; the folder is removed both times", async () => {
  let dir = "";
  let aborted = false;
  const hang = async (run: EgoRun) => { dir = dirname(run.originFifo); await new Promise<void>((resolve) => run.signal.addEventListener("abort", () => { aborted = true; resolve(); })); return { code: null, stdout: "" }; };
  await assert.rejects(siteLogin("https://example.com", { isUnlocked: unlocked, findLogin: async () => found, runEgo: hang, timeoutMs: 150 }), /90 seconds/u);
  assert.equal(aborted, true);
  assert.equal(existsSync(dir), false);
  const died = async (run: EgoRun) => { dir = dirname(run.originFifo); return { code: 1, stdout: "" }; };
  await assert.rejects(siteLogin("https://example.com", { isUnlocked: unlocked, findLogin: async () => found, runEgo: died, timeoutMs: 10_000 }), /stopped before the login finished/u);
  assert.equal(existsSync(dir), false);
  const broken = async (): Promise<never> => { throw new Error("spawn ego-browser ENOENT"); };
  await assert.rejects(siteLogin("https://example.com", { isUnlocked: unlocked, findLogin: async () => found, runEgo: broken }), /ENOENT|stopped before/u);
});

test("the tool is offered on macOS with ego-browser on PATH and nowhere else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frely-ego-"));
  try {
    assert.equal(siteLoginAvailable("darwin", dir), false);
    await writeFile(join(dir, "ego-browser"), "#!/bin/sh\n");
    await chmod(join(dir, "ego-browser"), 0o755);
    assert.equal(siteLoginAvailable("darwin", `/nonexistent:${dir}`), true);
    assert.equal(siteLoginAvailable("linux", dir), false);
    assert.equal(siteLoginAvailable("win32", dir), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
