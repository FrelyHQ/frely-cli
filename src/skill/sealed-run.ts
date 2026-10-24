import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { sandboxCommand } from "../runtime/sandbox.js";
import { CloudItemError, CloudToolError, SEALED_DIR, SEALED_LEASE_FILE, sealedFilePath, writeLease, type CloudToolCaller, type SealedLeaseRecord } from "./cloud-item.js";
import { interpreterFor, loadOrCreateDeviceSealKey, openSealedFile, parseLease, unwrapLease, type DeviceSealKey } from "./sealed.js";

/** A lease with less than this left is renewed before the run, when the server can be reached. */
const RENEW_BELOW_MS = 3 * 24 * 3600 * 1000;
const RENEW_WAIT_MS = 8000;
const MAX_ROOT_SEARCH = 8;

export interface RunSealedScriptInput {
  /** The script as the agent names it: the placeholder file, or `<item folder>/<script path>`. */
  readonly target: string;
  readonly args: readonly string[];
  readonly call: CloudToolCaller;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly now?: () => Date;
  /** Wraps the command for the Frely command sandbox; defaults to the same sandbox `run_command` uses. */
  readonly sandbox?: (command: string, workspaceRoot: string) => Promise<string>;
}

const quote = (value: string): string => /^[\w./:@%+=,-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;

/**
 * Runs one sealed script of an installed item inside the Frely command sandbox and returns its exit code.
 * The item's files are copied to a private temporary folder with every sealed script decrypted, so scripts that import
 * or read their neighbours work; the folder is removed when the script ends. A script that cannot be run in the sandbox
 * (no sandbox on this device) is refused, never run without it.
 */
export async function runSealedScript(input: RunSealedScriptInput): Promise<number> {
  const cwd = input.cwd ?? process.cwd();
  const now = input.now ?? (() => new Date());
  const { root, relativePath, marker } = await locateItem(resolve(cwd, input.target));
  const interpreter = interpreterFor(relativePath);
  if (!interpreter) throw new CloudItemError("input_invalid", `Frely cannot run ${relativePath}: its script type has no known interpreter.`);
  const sealedPaths = Object.keys(marker.files).filter((path) => path.startsWith(`${SEALED_DIR}/files/`) && path.endsWith(".sealed"));
  if (!sealedPaths.includes(sealedFilePath(relativePath))) throw new CloudItemError("input_invalid", `${relativePath} is not a sealed script of this item.`);

  const device = await loadOrCreateDeviceSealKey(input.env, input.home);
  const record = await currentLease({ root, marker, device, call: input.call, now });
  const versionKey = unwrapLease(device, record.lease, record.skillId, record.version);

  const workDir = await mkdtemp(join(tmpdir(), "frely-item-run-"));
  try {
    await chmod(workDir, 0o700);
    for (const path of Object.keys(marker.files)) {
      if (path.startsWith(`${SEALED_DIR}/`)) continue;
      await put(workDir, path, await readFile(join(root, ...path.split("/"))));
    }
    for (const sealedPath of sealedPaths) {
      const path = sealedPath.slice(`${SEALED_DIR}/files/`.length, -".sealed".length);
      await put(workDir, path, openSealedFile(versionKey, record.skillId, record.version, path, Buffer.from(await readFile(join(root, ...sealedPath.split("/"))))));
    }
    const script = join(workDir, ...relativePath.split("/"));
    const command = [...interpreter, script, ...input.args].map(quote).join(" ");
    const wrapped = await (input.sandbox ?? sandboxCommand)(command, cwd);
    return await new Promise<number>((done, fail) => {
      const child = spawn(wrapped, { shell: true, cwd, stdio: "inherit", env: input.env ?? process.env });
      child.once("error", fail);
      child.once("close", (code, signal) => done(code ?? (signal ? 128 : 1)));
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function put(workDir: string, path: string, content: Buffer): Promise<void> {
  const target = join(workDir, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { mode: 0o600 });
}

interface Marker { readonly owner: string; readonly itemId: string; readonly files: Record<string, string> }

async function locateItem(target: string): Promise<{ root: string; relativePath: string; marker: Marker }> {
  let folder = dirname(target);
  for (let depth = 0; depth < MAX_ROOT_SEARCH; depth += 1) {
    const raw = await readFile(join(folder, ".frely-managed.json"), "utf8").catch(() => null);
    if (raw !== null) {
      const marker = JSON.parse(raw) as Marker;
      if (marker.owner !== "frely-cli-cloud-item" || typeof marker.files !== "object" || marker.files === null) throw new CloudItemError("item_invalid", "This folder was not installed by frely item install.");
      const relativePath = relative(folder, target).split(sep).join(posix.sep);
      if (relativePath.startsWith("..") || relativePath === "") throw new CloudItemError("input_invalid", "The script is outside its item folder.");
      return { root: folder, relativePath, marker };
    }
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  throw new CloudItemError("item_invalid", "This script is not inside an item installed by frely item install.");
}

/** The lease to use for this run: the stored one while it lasts, renewed when it is near its end or has ended. */
async function currentLease(input: { root: string; marker: Marker; device: DeviceSealKey; call: CloudToolCaller; now: () => Date }): Promise<SealedLeaseRecord> {
  const stored = await readStoredLease(input.root);
  const remaining = stored ? Date.parse(stored.lease.expiresAt) - input.now().getTime() : -1;
  if (stored && remaining > RENEW_BELOW_MS) return stored;
  const skillId = stored?.skillId ?? input.marker.itemId;
  try {
    const renewed = await withTimeout(renew(input.call, skillId, input.device), stored && remaining > 0 ? RENEW_WAIT_MS : 180000);
    await writeLease(input.root, renewed);
    return renewed;
  } catch (error) {
    if (error instanceof CloudToolError && error.code === "creator_pass_required") {
      await rm(join(input.root, ...SEALED_LEASE_FILE.split("/")), { force: true });
      throw new CloudItemError("input_invalid", "Your access to this item has ended, so its sealed scripts no longer run. Buy a pass, then run frely item install again.");
    }
    if (stored && remaining > 0) return stored;
    throw new CloudItemError("input_invalid", "The access lease for this item's sealed scripts has ended and could not be renewed. Connect to the internet and try again.");
  }
}

async function renew(call: CloudToolCaller, skillId: string, device: DeviceSealKey): Promise<SealedLeaseRecord> {
  const value = await call("skills.install", { skillId, part: "premium", sealTo: device.publicKey, leaseOnly: true });
  const manifest = value.manifest as { version?: unknown; lease?: unknown } | undefined;
  const lease = parseLease(manifest?.lease);
  if (!lease || !Number.isSafeInteger(manifest?.version)) throw new CloudItemError("item_invalid", "Frely returned an invalid lease.");
  return { skillId, version: manifest!.version as number, lease };
}

async function readStoredLease(root: string): Promise<SealedLeaseRecord | null> {
  const raw = await readFile(join(root, ...SEALED_LEASE_FILE.split("/")), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as { format?: unknown; skillId?: unknown; version?: unknown; lease?: unknown };
    const lease = parseLease(value.lease);
    if (value.format !== 1 || typeof value.skillId !== "string" || !Number.isSafeInteger(value.version) || !lease) return null;
    return { skillId: value.skillId, version: value.version as number, lease };
  } catch { return null; }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("lease renewal timed out")), ms); })]).finally(() => clearTimeout(timer));
}
