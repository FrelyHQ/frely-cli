import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { assertManagedSkillPath, managedSkillRoot, type SkillHost, type SkillScope } from "./managed.js";
import { loadOrCreateDeviceSealKey, parseLease, stubFor, type SealedLease } from "./sealed.js";
import { filesDigest, readInstall, untouched, writeInstall, type InstallRecord } from "./registry.js";

export const CLOUD_SKILL_ID = /^cloud_skill_[0-9a-f]{24}$/u;
const MAX_FILES = 512;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/** Calls one Frely Cloud tool and returns its JSON result; a tool failure throws CloudToolError. */
export type CloudToolCaller = (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;

export class CloudToolError extends Error {
  constructor(readonly code: string) {
    super(`Frely Cloud call failed: ${code}`);
    this.name = "CloudToolError";
  }
}

export class CloudItemError extends Error {
  constructor(readonly code: "input_invalid" | "item_invalid" | "unmanaged_item_exists" | "managed_item_modified", message: string) {
    super(message);
    this.name = "CloudItemError";
  }
}

interface ItemFile { readonly path: string; readonly contentBase64: string; readonly isScript: boolean; readonly sealed?: true }
interface ItemManifest { readonly id: string; readonly kind: "prompt" | "skill"; readonly slug: string; readonly displayName: string; readonly version: number; readonly hasScripts: boolean; readonly premiumFileCount: number; readonly scanned: boolean }

export interface CloudItemInstallResult {
  readonly id: string;
  readonly kind: "prompt" | "skill";
  readonly name: string;
  readonly version: number;
  readonly path: string;
  readonly files: number;
  readonly premium: "installed" | "pass_required" | "none";
  readonly hasScripts: boolean;
  /** Paid scripts saved encrypted; they run through `frely item run` inside the command sandbox. */
  readonly sealedScripts: number;
  /** True for a Skill without a passing Frely scan: its files must be read before it is used. */
  readonly needsReview: boolean;
  /** True when Frely's automated scan passed for exactly this version, so the item is already marked reviewed. */
  readonly scanned: boolean;
}

/**
 * Install a download-install Prompt or Skill: the free part always, the paid
 * part when the account holds a pass. A Skill goes into the host's Skill
 * folder; a Prompt into `dir` (default: the current directory). Files are
 * written without execute permission, and a folder this command did not
 * create, or one edited since install, is never overwritten.
 */
export async function installCloudItem(input: {
  readonly skillId: string;
  readonly call: CloudToolCaller;
  readonly host?: SkillHost;
  readonly scope?: SkillScope;
  readonly dir?: string;
  readonly cwd?: string;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<CloudItemInstallResult> {
  if (!CLOUD_SKILL_ID.test(input.skillId)) throw new CloudItemError("input_invalid", "Use the item id shown in the marketplace, for example cloud_skill_0123456789abcdef01234567.");
  const free = parseContent(await input.call("skills.install", { skillId: input.skillId, part: "free" }), input.skillId);
  let files = free.files;
  let lease: SealedLease | null = null;
  let premium: CloudItemInstallResult["premium"] = "none";
  if (free.manifest.premiumFileCount > 0) {
    try {
      const device = await loadOrCreateDeviceSealKey(input.env, input.home);
      const paid = parseContent(await input.call("skills.install", { skillId: input.skillId, part: "premium", sealTo: device.publicKey }), input.skillId);
      files = [...files, ...paid.files];
      lease = paid.lease;
      premium = "installed";
    } catch (error) {
      if (!(error instanceof CloudToolError) || error.code !== "creator_pass_required") throw error;
      premium = "pass_required";
    }
  }
  const { manifest } = free;
  const cwd = input.cwd ?? process.cwd();
  const home = input.home ?? homedir();
  // An item keeps the name its creator gave it, exactly like a Skill copied there by hand.
  const target = manifest.kind === "skill"
    ? join(managedSkillRoot(input.host ?? "generic", input.scope ?? "global", resolve(cwd, input.scope === "project" ? input.dir ?? "." : "."), home), manifest.slug)
    : join(resolve(cwd, input.dir ?? "."), manifest.slug);
  const placed = placeSealedScripts(files);
  const written = await writeItemFolder(target, manifest.id, manifest.kind, placed.files, home);
  if (lease !== null && placed.sealed > 0) await writeLease(target, { skillId: manifest.id, version: manifest.version, lease });
  // A passing scan is bound to this version's files on the server, so the local review is already done.
  const scanned = manifest.kind === "skill" && manifest.scanned;
  if (scanned) await writeInstall({ ...written, trustedDigest: filesDigest(written.files) }, home);
  return Object.freeze({
    id: manifest.id, kind: manifest.kind, name: manifest.displayName, version: manifest.version,
    path: target, files: files.length, premium, hasScripts: manifest.hasScripts, sealedScripts: placed.sealed, needsReview: manifest.kind === "skill" && !scanned, scanned,
  });
}

export const SEALED_DIR = ".frely-sealed";
export const SEALED_LEASE_FILE = `${SEALED_DIR}/lease.json`;
export const sealedFilePath = (path: string): string => `${SEALED_DIR}/files/${path}.sealed`;

/** Each sealed script becomes its ciphertext under `.frely-sealed/files/` plus a plain placeholder at its own path. */
function placeSealedScripts(files: readonly ItemFile[]): { files: ItemFile[]; sealed: number } {
  const placed: ItemFile[] = [];
  let sealed = 0;
  for (const file of files) {
    if (file.sealed !== true) { placed.push(file); continue; }
    sealed += 1;
    placed.push({ path: sealedFilePath(file.path), contentBase64: file.contentBase64, isScript: false });
    const stub = stubFor(file.path);
    if (stub !== undefined) placed.push({ path: file.path, contentBase64: Buffer.from(stub).toString("base64"), isScript: true });
  }
  return { files: placed, sealed };
}

export interface SealedLeaseRecord { readonly skillId: string; readonly version: number; readonly lease: SealedLease }

/** Replaces the folder's lease; the lease is not part of the recorded file list, so a renewal never counts as an edit. */
export async function writeLease(folder: string, record: SealedLeaseRecord): Promise<void> {
  await atomicWrite(join(folder, SEALED_LEASE_FILE), Buffer.from(JSON.stringify({ format: 1, ...record })));
}

/** Remembers that the installed files of this version were reviewed, or reports whether they were. */
export async function trustCloudItem(folder: string, options: { readonly check?: boolean; readonly home?: string } = {}): Promise<{ readonly trusted: boolean }> {
  const home = options.home ?? homedir();
  const record = await readInstall(folder, home);
  if (!record) throw new CloudItemError("item_invalid", "This folder was not installed by frely item install.");
  const digest = filesDigest(record.files);
  if (options.check) return { trusted: record.trustedDigest === digest && await untouched(record) };
  await writeInstall({ ...record, trustedDigest: digest }, home);
  return { trusted: true };
}

function parseContent(value: Record<string, unknown>, skillId: string): { manifest: ItemManifest; files: ItemFile[]; lease: SealedLease | null } {
  const manifest = record(value.manifest);
  const premium = record(manifest?.premium);
  if (!manifest || manifest.id !== skillId || (manifest.kind !== "prompt" && manifest.kind !== "skill")
    || typeof manifest.slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u.test(manifest.slug)
    || typeof manifest.displayName !== "string" || !Number.isSafeInteger(manifest.version) || !Array.isArray(value.files) || value.files.length > MAX_FILES) {
    throw new CloudItemError("item_invalid", "Frely returned an invalid item.");
  }
  const scan = record(manifest.scan);
  const scanned = scan?.verdict === "pass" && typeof manifest.manifestDigest === "string" && scan.manifestDigest === manifest.manifestDigest;
  let total = 0;
  const files = value.files.map((raw) => {
    const file = record(raw);
    const sealed = file?.sealed === true;
    const content = sealed ? file?.sealedBase64 : file?.contentBase64;
    if (!file || typeof file.path !== "string" || typeof content !== "string") throw new CloudItemError("item_invalid", "Frely returned an invalid item file.");
    total += Math.floor(content.length * 3 / 4);
    const path = safeRelativePath(file.path);
    if (path === SEALED_DIR || path.startsWith(`${SEALED_DIR}/`)) throw new CloudItemError("item_invalid", "Frely returned an unsafe file path.");
    return { path, contentBase64: content, isScript: file.isScript === true, ...(sealed ? { sealed: true as const } : {}) };
  });
  if (total > MAX_TOTAL_BYTES) throw new CloudItemError("item_invalid", "The item is too large.");
  return {
    manifest: {
      id: skillId, kind: manifest.kind, slug: manifest.slug, displayName: manifest.displayName, version: manifest.version as number,
      hasScripts: manifest.hasScripts === true, premiumFileCount: typeof premium?.fileCount === "number" ? premium.fileCount : 0, scanned,
    },
    files,
    lease: parseLease(manifest.lease),
  };
}

/** Item paths are canonical forward-slash relative paths on every platform; `join` maps them to the OS. */
function safeRelativePath(path: string): string {
  const normalized = posix.normalize(path);
  if (!path || path.includes("\0") || path.includes("\\") || posix.isAbsolute(path) || win32.isAbsolute(path) || normalized.split("/").some((part) => part === ".." || part === "" || part === "." || part.includes(":"))) {
    throw new CloudItemError("item_invalid", "Frely returned an unsafe file path.");
  }
  return normalized;
}

/**
 * Writes the files of one item folder and records them. A folder that already
 * exists is replaced only when Frely wrote it for this same item and nothing in
 * it was edited since.
 */
export async function writeItemFolder(target: string, itemId: string, kind: InstallRecord["kind"], files: readonly ItemFile[], home: string): Promise<InstallRecord> {
  await assertManagedSkillPath(join(target, "SKILL.md"));
  const exists = await lstat(target).then(() => true, (error: unknown) => { if (isAbsent(error)) return false; throw error; });
  if (exists) {
    const previous = await readInstall(target, home);
    if (!previous || previous.itemId !== itemId) {
      throw new CloudItemError("unmanaged_item_exists", `A folder Frely did not install for this item already exists at ${target}. Move it away or install somewhere else.`);
    }
    for (const path of Object.keys(previous.files)) {
      const current = await readFile(join(target, safeRelativePath(path))).catch((error: unknown) => { if (isAbsent(error)) return null; throw error; });
      if (current !== null && hash(current) !== previous.files[path]) throw new CloudItemError("managed_item_modified", `${join(target, path)} was edited; refusing to overwrite it.`);
    }
  }
  const written: Record<string, string> = {};
  for (const file of files) {
    const content = Buffer.from(file.contentBase64, "base64");
    await atomicWrite(join(target, file.path), content);
    written[file.path] = hash(content);
  }
  const record: InstallRecord = { version: 1, kind, itemId, path: resolve(target), files: written };
  await writeInstall(record, home);
  return record;
}

async function atomicWrite(path: string, value: Buffer): Promise<void> {
  await assertManagedSkillPath(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertManagedSkillPath(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(value); await file.sync(); }
  finally { await file.close(); }
  try { await assertManagedSkillPath(path); await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => undefined); }
}

function hash(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function isAbsent(error: unknown): boolean { return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"; }
