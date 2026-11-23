import { execFile, spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { findLogin, LOCKED_HINT, vaultStatus, VaultLockedError, type FindLoginResult } from "./bitwarden.js";

/**
 * `site_login`: the AI gives an https URL; this device opens it in ego lite with one fixed script, takes the page's real origin, fetches
 * the one matching login from the Bitwarden vault and hands it to the script through a FIFO (the script inherits no environment).
 * The AI gets a receipt only: whether the form was submitted, never a username, password, page text or URL path.
 */
export const SITE_LOGIN_TOOL = "site_login";
export const SITE_LOGIN_TIMEOUT_MS = 90_000;
const EGO = "ego-browser";
export const TASK_SPACE = "frely-site-login";

export const SITE_LOGIN_STATUSES = ["submitted", "no_login_found", "ambiguous", "no_form", "redirected"] as const;
export type SiteLoginStatus = (typeof SITE_LOGIN_STATUSES)[number];
export interface SiteLoginReceipt { status: SiteLoginStatus; site: string; usedTotp: boolean }

export interface EgoRun { script: string; originFifo: string; credFifo: string; signal: AbortSignal }
export interface EgoResult { code: number | null; stdout: string }
export interface SiteLoginDeps {
  runEgo?: (run: EgoRun) => Promise<EgoResult>;
  findLogin?: (origin: string) => Promise<FindLoginResult>;
  isUnlocked?: () => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The tool is offered on macOS when ego-browser is on PATH; elsewhere there is nothing to drive. */
export function siteLoginAvailable(platform = process.platform, path = process.env.PATH ?? ""): boolean {
  if (platform !== "darwin") return false;
  return path.split(delimiter).some((dir) => { try { accessSync(join(dir, EGO), fsConstants.X_OK); return true; } catch { return false; } });
}

/** The https URL the AI may ask for: no credentials in it, no other scheme. */
export function parseLoginUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) throw new Error("url must be an https URL.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("url must be an https URL."); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("url must be an https URL without a user name or password.");
  return url;
}

/**
 * The fixed ego lite script. Only the URL and the two FIFO paths are embedded, each as a JSON string; nothing from a page is ever spliced
 * into code. The page is inspected with evaluate calls that return booleans, and fields are marked with data attributes instead of
 * returning selectors or values. Credentials are read from the credential FIFO and typed straight into the page.
 */
export function buildLoginScript(input: { url: string; originFifo: string; credFifo: string }): string {
  return `const fs = require("node:fs");
const URL_TO_OPEN = ${JSON.stringify(input.url)};
const ORIGIN_FIFO = ${JSON.stringify(input.originFifo)};
const CRED_FIFO = ${JSON.stringify(input.credFifo)};
const FIND_FIELDS = ${JSON.stringify(FIND_FIELDS)};
const FIND_CODE = ${JSON.stringify(FIND_CODE)};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (status, origin, usedTotp) => console.log(JSON.stringify({ status, origin, usedTotp }));

async function waitFor(page, expression, tries) {
  for (let i = 0; i < tries; i++) { const found = await page.evaluate(expression); if (found && (found.pw || found.user)) return found; await sleep(500); }
  return await page.evaluate(expression);
}

(async () => {
  const task = await TaskSpace.open(${JSON.stringify(TASK_SPACE)});
  let origin = "";
  let usedTotp = false;
  try {
    const page = await task.newPage();
    await page.goto(URL_TO_OPEN);
    await page.waitForLoadState();
    origin = new URL(await page.url()).origin;
    fs.writeFileSync(ORIGIN_FIFO, origin);
    const cred = JSON.parse(fs.readFileSync(CRED_FIFO, "utf8"));
    if (!cred.ok) { report(cred.status || "no_login_found", origin, false); return; }
    let found = await waitFor(page, FIND_FIELDS, 6);
    if (found.pw > 1) { report("no_form", origin, false); return; }
    if (!found.pw && found.user) {
      await page.fill("[data-frely-user]", cred.username);
      await page.press("[data-frely-user]", "Enter");
      await sleep(1500);
      found = await waitFor(page, FIND_FIELDS, 10);
    }
    if (found.pw !== 1) { report("no_form", origin, false); return; }
    if (found.user && !(await page.evaluate("document.querySelector('[data-frely-user]') !== null && document.querySelector('[data-frely-user]').value !== ''"))) await page.fill("[data-frely-user]", cred.username);
    await page.fill("[data-frely-pw]", cred.password);
    await page.press("[data-frely-pw]", "Enter");
    await sleep(2500);
    if (cred.totp) {
      const code = await page.evaluate(FIND_CODE);
      if (code) { await page.fill("[data-frely-code]", cred.totp); await page.press("[data-frely-code]", "Enter"); usedTotp = true; await sleep(2000); }
    }
    report("submitted", origin, usedTotp);
  } finally {
    await task.finish({ keep: [] });
  }
})().catch(() => { report("no_form", "", false); });
`;
}

/** Marks the one visible password box and its user name box on the page and says how many there are; returns counts, never values. */
const FIND_FIELDS = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.disabled && !el.readOnly; };
  for (const el of document.querySelectorAll("[data-frely-pw],[data-frely-user]")) { el.removeAttribute("data-frely-pw"); el.removeAttribute("data-frely-user"); }
  const passwords = [...document.querySelectorAll("input[type=password]")].filter(visible);
  const pw = passwords[0] || null;
  const scope = pw ? (pw.form || document) : document;
  const texts = [...scope.querySelectorAll("input[type=email],input[type=text],input[autocomplete~=username],input:not([type])")].filter(visible);
  let user = texts.find((el) => /(^|\\s)username(\\s|$)/.test(el.getAttribute("autocomplete") || "")) || null;
  if (!user && pw) for (const el of texts) if (el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) user = el;
  if (!user && !pw) user = texts[0] || null;
  if (pw) pw.setAttribute("data-frely-pw", "1");
  if (user) user.setAttribute("data-frely-user", "1");
  return { pw: passwords.length, user: user ? 1 : 0 };
})()`;

const FIND_CODE = `(() => {
  const el = [...document.querySelectorAll("input[autocomplete=one-time-code],input[inputmode=numeric]")].find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.disabled; });
  if (el) el.setAttribute("data-frely-code", "1");
  return !!el;
})()`;

const run = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Reads a FIFO to its end without blocking a thread: opens non-blocking and polls until a writer came, wrote and closed. */
export async function readFifo(path: string, signal: AbortSignal): Promise<string> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      signal.throwIfAborted();
      const buffer = Buffer.alloc(4096);
      let read = 0;
      try { read = (await handle.read(buffer, 0, buffer.length, null)).bytesRead; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error; }
      if (read > 0) { chunks.push(buffer.subarray(0, read)); continue; }
      if (chunks.length > 0) return Buffer.concat(chunks).toString("utf8");
      await sleep(50);
    }
  } finally { await handle.close(); }
}

/** Writes the bytes into a FIFO once a reader has it open, then zeroes them. Gives up when `signal` aborts (the script died). */
export async function writeFifo(path: string, data: Buffer, signal: AbortSignal): Promise<void> {
  try {
    for (;;) {
      signal.throwIfAborted();
      try {
        const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
        try { await handle.write(data, 0, data.length, null); } finally { await handle.close(); }
        return;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error; }
      await sleep(50);
    }
  } finally { data.fill(0); }
}

const defaultRunEgo = ({ script, signal }: EgoRun): Promise<EgoResult> => new Promise((resolve, reject) => {
  // The script gets no environment of ours: credentials come through the FIFO only.
  const child = spawn(EGO, ["nodejs"], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" } });
  let stdout = "";
  const kill = () => { child.kill("SIGKILL"); };
  signal.addEventListener("abort", kill, { once: true });
  child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 65_536) stdout += chunk.toString("utf8"); });
  child.on("error", (error) => { signal.removeEventListener("abort", kill); reject(error); });
  child.on("close", (code) => { signal.removeEventListener("abort", kill); resolve({ code, stdout }); });
  child.stdin.on("error", () => undefined);
  child.stdin.end(script);
});

const guidance = (): Error => new Error(LOCKED_HINT);
const parseOutput = (stdout: string): { status: unknown; usedTotp: boolean } | null => {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  try { const value = JSON.parse(line) as { status?: unknown; usedTotp?: unknown }; return { status: value.status, usedTotp: value.usedTotp === true }; } catch { return null; }
};

export async function siteLogin(urlValue: unknown, deps: SiteLoginDeps = {}): Promise<SiteLoginReceipt> {
  const url = parseLoginUrl(urlValue);
  if (!(deps.isUnlocked ?? (() => vaultStatus().status === "unlocked"))()) throw guidance();
  const lookup = deps.findLogin ?? findLogin;
  const ego = deps.runEgo ?? defaultRunEgo;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("The login took longer than 90 seconds and was stopped.")), deps.timeoutMs ?? SITE_LOGIN_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([timeout.signal, deps.signal]) : timeout.signal;
  const dir = await mkdtemp(join(tmpdir(), "frely-site-login-"));
  try {
    const originFifo = join(dir, "origin"), credFifo = join(dir, "cred");
    for (const fifo of [originFifo, credFifo]) await run("mkfifo", ["-m", "600", fifo]);
    const script = buildLoginScript({ url: url.href, originFifo, credFifo });
    const running = ego({ script, originFifo, credFifo, signal });
    // A script that dies before it writes must not leave our FIFO calls waiting: its end also stops them.
    const guarded = new AbortController();
    const stopGuard = () => guarded.abort(signal.aborted ? signal.reason : new Error("ego-browser stopped before the login finished."));
    signal.addEventListener("abort", stopGuard, { once: true });
    void running.then(() => undefined, () => undefined).then(() => { setTimeout(stopGuard, 2000).unref(); });
    let verdict: { status: SiteLoginStatus; ok: false } | { ok: true; login: Extract<FindLoginResult, { status: "found" }> };
    let origin = "";
    try {
      origin = (await readFifo(originFifo, guarded.signal)).trim();
      const page = parseOrigin(origin);
      if (!page || page.hostname !== url.hostname) verdict = { ok: false, status: "redirected" };
      else {
        const found = await lookup(page.origin);
        verdict = found.status === "found" ? { ok: true, login: found } : { ok: false, status: found.status };
      }
      const message = Buffer.from(JSON.stringify(verdict.ok ? { ok: true, username: verdict.login.username, password: verdict.login.password, ...(verdict.login.totp ? { totp: verdict.login.totp } : {}) } : { ok: false, status: verdict.status }));
      await writeFifo(credFifo, message, guarded.signal);
    } catch (error) {
      if (error instanceof VaultLockedError) throw guidance();
      throw guarded.signal.aborted && guarded.signal.reason instanceof Error ? guarded.signal.reason : error;
    }
    const result = await running;
    signal.removeEventListener("abort", stopGuard);
    if (!verdict.ok) return { status: verdict.status, site: origin, usedTotp: false };
    const out = parseOutput(result.stdout);
    const status = (SITE_LOGIN_STATUSES as readonly unknown[]).includes(out?.status) ? out!.status as SiteLoginStatus : "no_form";
    return { status, site: origin, usedTotp: status === "submitted" && out?.usedTotp === true };
  } catch (error) {
    if (signal.aborted && signal.reason instanceof Error) throw signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    timeout.abort(new Error("done"));
    await rm(dir, { recursive: true, force: true });
  }
}

function parseOrigin(origin: string): URL | null {
  try { const url = new URL(origin); return url.protocol === "https:" && url.origin === origin ? url : null; } catch { return null; }
}
