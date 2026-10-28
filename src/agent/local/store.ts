import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * What is known about one Agent running on this computer. It lives with Frely's own files, not in the Agent's folder: the sandbox
 * cannot read or write there, so the program it runs cannot change which sites it was approved for.
 */
export interface LocalAgentRecord {
  version: 1;
  slug: string;
  /** What the person typed: `username/name` or a GitHub address. */
  source: string;
  repoUrl: string;
  commit: string;
  name: string;
  workspace: string;
  setup: string | undefined;
  run: string;
  /** Sites from frely.yaml, asked for when the Agent is added and started. */
  network: string[];
  addedAt: string;
  setupDone: boolean;
  /** Approved site -> when the approval ends (ISO time). */
  approvals: Record<string, string>;
  pid: number | undefined;
  startedAt: string | undefined;
}

export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/u;

const configRoot = (): string => process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
/** Records, logs and sockets: `~/.config/frely/agent-local`. */
export const stateDir = (): string => join(configRoot(), "frely", "agent-local");
/** One folder per Agent, the only place its program can write besides the system temp folder. */
export const agentsRoot = (): string => resolve(process.env.FRELY_AGENTS_DIR || join(homedir(), "frely-agents"));

export function assertSlug(slug: string): void {
  if (!SLUG.test(slug)) throw new Error("The Agent name must be lower-case letters, digits and dashes.");
}

export const workspaceOf = (slug: string): string => join(agentsRoot(), slug);
export const recordPath = (slug: string): string => join(stateDir(), `${slug}.json`);
export const logPath = (slug: string): string => join(stateDir(), `${slug}.log`);
/** Short enough for the ~100 character limit of a Unix socket path. */
export const socketPath = (slug: string): string => join(process.env.XDG_RUNTIME_DIR || stateDir(), `m-${createHash("sha256").update(slug).digest("hex").slice(0, 10)}.sock`);

/** Whether `path` is inside the Agents folder (and not the folder itself), so a removal can never reach anything else. */
export function insideAgentsRoot(path: string): boolean {
  const root = agentsRoot();
  const target = resolve(path);
  return target !== root && target.startsWith(root.endsWith(sep) ? root : root + sep);
}

export async function readRecord(slug: string): Promise<LocalAgentRecord | undefined> {
  assertSlug(slug);
  const raw = await readFile(recordPath(slug), "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as LocalAgentRecord;
    return value.version === 1 && value.slug === slug && typeof value.run === "string" ? value : undefined;
  } catch { return undefined; }
}

export async function writeRecord(record: LocalAgentRecord): Promise<void> {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  const target = recordPath(record.slug);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, target);
  await chmod(target, 0o600).catch(() => undefined);
}

export async function listRecords(): Promise<LocalAgentRecord[]> {
  const names = await readdir(stateDir()).catch(() => [] as string[]);
  const records: LocalAgentRecord[] = [];
  for (const name of names.filter((file) => file.endsWith(".json")).sort()) {
    const record = await readRecord(name.slice(0, -5)).catch(() => undefined);
    if (record) records.push(record);
  }
  return records;
}

export async function removeRecordFiles(slug: string): Promise<void> {
  await rm(recordPath(slug), { force: true });
  await rm(logPath(slug), { force: true });
  await rm(socketPath(slug), { force: true });
}

/** Whether the process the record names is still running. */
export function isRunning(record: Pick<LocalAgentRecord, "pid">): boolean {
  if (record.pid === undefined) return false;
  try { process.kill(record.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Approvals that have not ended yet, as a site list. */
export function approvedHosts(record: Pick<LocalAgentRecord, "approvals" | "network">, now = Date.now()): string[] {
  return record.network.filter((host) => { const end = record.approvals[host]; return end !== undefined && Date.parse(end) > now; });
}
