import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SkillHost = "chatgpt" | "codex" | "claude-code" | "pi" | "generic";
export type SkillScope = "global" | "project";

export interface ManagedSkillRecord {
  readonly version: 1;
  readonly distributionId: string;
  readonly manifestUrl: string;
  readonly modelId: string;
  readonly mcpUrl: string;
  readonly name: string;
  readonly slug: string;
  readonly host: SkillHost;
  readonly scope: SkillScope;
  readonly authMode: "account" | "api-key";
  readonly skillPath: string;
  readonly sha256: string;
  readonly installedAt: string;
  /** Hash of a Skill file being written; set only while a write is in flight. */
  readonly pendingSha256?: string;
}

export class ManagedSkillError extends Error {
  constructor(readonly code: "unmanaged_skill_exists" | "managed_skill_modified" | "local_state_invalid", message: string) {
    super(message);
    this.name = "ManagedSkillError";
  }
}

export function managedSkillRoot(host: SkillHost, scope: SkillScope, cwd = process.cwd(), home = homedir()): string {
  if (scope === "project") {
    if (host === "claude-code") return join(resolve(cwd), ".claude", "skills");
    if (host === "pi") return join(resolve(cwd), ".pi", "skills");
    return join(resolve(cwd), ".agents", "skills");
  }
  if (host === "claude-code") return join(home, ".claude", "skills");
  if (host === "pi") return join(home, ".pi", "agent", "skills");
  return join(home, ".agents", "skills");
}

/** The Skill's own name, as its creator wrote it; nothing is added to it. */
export function skillSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").replace(/-+/gu, "-").slice(0, 64).replace(/-+$/u, "") || "agent";
}

export async function writeManagedSkill(input: {
  readonly record: Omit<ManagedSkillRecord, "sha256" | "installedAt" | "pendingSha256">;
  readonly content: string;
  readonly home?: string;
}): Promise<ManagedSkillRecord> {
  const home = input.home ?? homedir();
  const current = await readOwnedFile(input.record.skillPath);
  const previous = await readManagedSkill(input.record.distributionId, home).catch(() => null);
  if (current !== null) {
    if (!previous || previous.skillPath !== input.record.skillPath) throw new ManagedSkillError("unmanaged_skill_exists", "A Skill Frely did not install for this Agent already exists at the target path.");
    if (hashText(current) !== previous.sha256 && hashText(current) !== previous.pendingSha256) throw new ManagedSkillError("managed_skill_modified", "The managed Skill was modified; refusing to overwrite it.");
  }
  const sha256 = hashText(input.content);
  const stamp = { ...input.record, installedAt: new Date().toISOString() };
  // The record goes first with the new hash pending, so a crash between the two writes is recoverable.
  await atomicWrite(recordPath(home, stamp.distributionId), `${JSON.stringify({ ...stamp, sha256: current === null ? sha256 : hashText(current), pendingSha256: sha256 }, null, 2)}\n`);
  await atomicWrite(input.record.skillPath, input.content);
  const record: ManagedSkillRecord = Object.freeze({ ...stamp, sha256 });
  await atomicWrite(recordPath(home, record.distributionId), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function readManagedSkill(distributionId: string, home = homedir()): Promise<ManagedSkillRecord | null> {
  const text = await readOwnedFile(recordPath(home, distributionId), 64 * 1024);
  if (text === null) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ManagedSkillError("local_state_invalid", "Installed Frely Skill metadata is invalid."); }
  const item = recordValue(value);
  const authMode = item?.authMode === undefined ? "account" : item.authMode;
  if (!item || item.version !== 1 || item.distributionId !== distributionId || typeof item.manifestUrl !== "string" || typeof item.modelId !== "string" || typeof item.mcpUrl !== "string" || typeof item.name !== "string" || typeof item.slug !== "string" || typeof item.skillPath !== "string" || typeof item.sha256 !== "string" || typeof item.installedAt !== "string" || !["chatgpt", "codex", "claude-code", "pi", "generic"].includes(String(item.host)) || !["global", "project"].includes(String(item.scope)) || !["account", "api-key"].includes(String(authMode))) {
    throw new ManagedSkillError("local_state_invalid", "Installed Frely Skill metadata is invalid.");
  }
  return Object.freeze({ ...item, authMode }) as unknown as ManagedSkillRecord;
}

export async function managedSkillState(record: ManagedSkillRecord): Promise<"managed" | "modified" | "missing"> {
  const text = await readOwnedFile(record.skillPath);
  if (text === null) return "missing";
  return hashText(text) === record.sha256 ? "managed" : "modified";
}

export async function removeManagedSkill(record: ManagedSkillRecord, home = homedir()): Promise<void> {
  const state = await managedSkillState(record);
  if (state === "modified") throw new ManagedSkillError("managed_skill_modified", "Managed Skill was modified; refusing to remove it.");
  await unlink(record.skillPath).catch(ignoreAbsent);
  await rmdir(dirname(record.skillPath)).catch(() => undefined);
  await unlink(recordPath(home, record.distributionId)).catch(ignoreAbsent);
}

export async function assertManagedSkillPath(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    const stat = await lstat(current).catch((error: unknown) => { if (isAbsent(error)) return null; throw error; });
    if (stat?.isSymbolicLink()) throw new ManagedSkillError("unmanaged_skill_exists", "Refusing to traverse a symbolic link while managing a Skill.");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function readOwnedFile(path: string, maxBytes = 512 * 1024): Promise<string | null> {
  await assertManagedSkillPath(path);
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (isAbsent(error)) return null; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new ManagedSkillError("local_state_invalid", "Managed Skill file is invalid.");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await assertManagedSkillPath(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertManagedSkillPath(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(value, "utf8"); await file.sync(); }
  finally { await file.close(); }
  try { await assertManagedSkillPath(path); await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => undefined); }
}

function recordPath(home: string, distributionId: string): string { return join(home, ".config", "frely", "skills", `${distributionId}.json`); }
function hashText(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function recordValue(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function isAbsent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function ignoreAbsent(error: unknown): void { if (!isAbsent(error)) throw error; }
