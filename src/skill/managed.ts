import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
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

export function skillSlug(name: string, distributionId: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").replace(/-+/gu, "-").slice(0, 44) || "agent";
  return `frely-${base}-${distributionId.slice(-8)}`.slice(0, 64).replace(/-+$/u, "");
}

export async function writeManagedSkill(input: {
  readonly record: Omit<ManagedSkillRecord, "sha256" | "installedAt">;
  readonly content: string;
  readonly home?: string;
}): Promise<ManagedSkillRecord> {
  const metadataPath = join(dirname(input.record.skillPath), ".frely-managed.json");
  const current = await readOwnedFile(input.record.skillPath);
  const metadata = await readOwnedFile(metadataPath, 4096);
  let marker: Record<string, unknown> | null = null;
  if (metadata !== null) {
    try { marker = recordValue(JSON.parse(metadata)); } catch { marker = null; }
    if (!marker || marker.version !== 1 || marker.owner !== "frely-cli-skill" || marker.distributionId !== input.record.distributionId) {
      throw new ManagedSkillError("unmanaged_skill_exists", "An unmanaged Skill already exists at the target path.");
    }
  }
  if (current !== null && (!marker || (hashText(current) !== marker.sha256 && hashText(current) !== marker.pendingSha256))) {
    throw new ManagedSkillError("managed_skill_modified", "The managed Skill was modified; refusing to overwrite it.");
  }
  const sha256 = hashText(input.content);
  await atomicWrite(metadataPath, JSON.stringify({ version: 1, owner: "frely-cli-skill", distributionId: input.record.distributionId, sha256: current === null ? null : hashText(current), pendingSha256: sha256 }));
  await atomicWrite(input.record.skillPath, input.content);
  await atomicWrite(metadataPath, JSON.stringify({ version: 1, owner: "frely-cli-skill", distributionId: input.record.distributionId, sha256 }));
  const record: ManagedSkillRecord = Object.freeze({ ...input.record, sha256, installedAt: new Date().toISOString() });
  await atomicWrite(recordPath(input.home ?? homedir(), record.distributionId), `${JSON.stringify(record, null, 2)}\n`);
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
  await unlink(join(dirname(record.skillPath), ".frely-managed.json")).catch(ignoreAbsent);
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
