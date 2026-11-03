import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LINK_AGENTS, agentSkillRoot, placeNewLink, skillContext, type LinkAgent, type LinkRecord, type SymlinkFn } from "./agent-links.js";
import { listManagedSkills, writeManagedLinks } from "./managed.js";
import { listInstalls, writeInstall } from "./registry.js";

/**
 * Agents installed after a Skill get its link later. A Skill keeps its one copy in `.agents/skills`; this pass walks every Skill Frely
 * installed and links it into each agent that is present now and has no link yet. A link the person deleted (the agent's Skill folder is
 * still there, the link is gone) is remembered and not put back, except when `force` names that agent. A link whose agent folder is gone
 * (the agent was removed) is dropped from the record, so the agent counts as new again if it comes back.
 */
export interface LinkSyncChange { readonly agent: LinkAgent; readonly path: string; readonly skill: string }
export interface LinkSyncResult {
  /** False when nothing was scanned: the agent folders look as they did at the last full pass, or another pass holds the lock. */
  readonly scanned: boolean;
  readonly added: readonly LinkSyncChange[];
  /** Links an agent should have but that could not be made (a folder Frely did not write is in the way, or the write failed). */
  readonly skipped: ReadonlyArray<LinkSyncChange & { readonly reason: string }>;
  readonly dismissed: readonly LinkSyncChange[];
}

export interface LinkSyncOptions {
  readonly home?: string;
  /** "check": scan only when the agent folders in the home folder changed since the last full pass. "full": always scan. */
  readonly mode?: "check" | "full";
  /** Link this agent even if its folder is missing or the person deleted the link before. */
  readonly force?: LinkAgent;
  /** Report what would change without writing anything. */
  readonly dryRun?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly symlinkFn?: SymlinkFn;
}

const LOCK_STALE_MS = 60_000;
const EMPTY: LinkSyncResult = Object.freeze({ scanned: false, added: [], skipped: [], dismissed: [] });

export function linkSyncStatePath(home: string): string { return join(home, ".config", "frely", "agent-links-state.json"); }

/** Which agent folders exist in the home folder, plus the agents this CLI knows: a CLI that learns a new agent rescans once. */
export async function agentFingerprint(home: string): Promise<string> {
  const agents = Object.keys(LINK_AGENTS).sort();
  const present: string[] = [];
  for (const agent of agents) if (await exists(join(home, LINK_AGENTS[agent as LinkAgent].detect))) present.push(agent);
  return JSON.stringify({ version: 1, agents, present });
}

export async function syncAgentLinks(options: LinkSyncOptions = {}): Promise<LinkSyncResult> {
  const home = options.home ?? homedir();
  const fingerprint = await agentFingerprint(home);
  if ((options.mode ?? "full") === "check" && options.force === undefined) {
    const last = await readFile(linkSyncStatePath(home), "utf8").catch(() => null);
    if (last !== null && last.trim() === fingerprint) return EMPTY;
  }
  if (options.dryRun) return scan(home, options, true).then((result) => result.value);
  const release = await lock(home);
  if (release === null) return EMPTY;
  try {
    const { value, clean } = await scan(home, options, false);
    // A pass that could not write somewhere (another agent's sandbox, say) leaves the old state, so the next command tries again.
    if (clean) await writeState(home, fingerprint).catch(() => undefined);
    return value;
  } finally { await release(); }
}

interface Entry {
  readonly canonical: string;
  readonly links: readonly LinkRecord[];
  readonly dismissed: readonly string[];
  save(links: readonly LinkRecord[], dismissed: readonly string[]): Promise<void>;
}

async function entries(home: string): Promise<Entry[]> {
  const found: Entry[] = [];
  for (const record of await listInstalls(home)) {
    if (record.kind === "prompt") continue;
    found.push({
      canonical: record.path, links: record.links ?? [], dismissed: record.dismissedLinks ?? [],
      save: async (links, dismissed) => {
        const { links: _links, dismissedLinks: _dismissed, ...rest } = record;
        await writeInstall({ ...rest, ...(links.length > 0 ? { links } : {}), ...(dismissed.length > 0 ? { dismissedLinks: dismissed } : {}) }, home);
      },
    });
  }
  for (const record of await listManagedSkills(home)) {
    found.push({ canonical: dirname(record.skillPath), links: record.links ?? [], dismissed: record.dismissedLinks ?? [], save: (links, dismissed) => writeManagedLinks(record, links, dismissed, home) });
  }
  return found;
}

async function scan(home: string, options: LinkSyncOptions, dryRun: boolean): Promise<{ value: LinkSyncResult; clean: boolean }> {
  const added: LinkSyncChange[] = [];
  const skipped: Array<LinkSyncChange & { reason: string }> = [];
  const dismissedNow: LinkSyncChange[] = [];
  let clean = true;
  for (const entry of await entries(home).catch(() => [] as Entry[])) {
    try {
      const context = skillContext(entry.canonical, home);
      // Only Skills in `.agents/skills` are linked; a folder installed straight into an agent the old way, or a project that is gone, is left as is.
      if (context === null || context.legacy || !await exists(join(entry.canonical, "SKILL.md"))) continue;
      const links = [...entry.links];
      const dismissed = new Set(entry.dismissed);
      let changed = false;
      for (const agent of Object.keys(LINK_AGENTS) as LinkAgent[]) {
        const root = agentSkillRoot(agent, context.scope, context.base);
        const path = join(root, context.name);
        const forced = options.force === agent;
        const present = forced || await exists(join(context.base, LINK_AGENTS[agent].detect));
        const index = links.findIndex((link) => resolve(link.path) === resolve(path));
        const change = { agent, path, skill: context.name };
        if (!present) {
          // The agent was removed: its link went with it. Forget both, so a reinstalled agent is linked again.
          if (index >= 0 && !await exists(path)) { links.splice(index, 1); changed = true; }
          if (dismissed.delete(path)) changed = true;
          continue;
        }
        if (index >= 0 && await exists(path)) continue;
        if (!forced && dismissed.has(path)) continue;
        if (index >= 0 && !forced && await exists(root)) {
          // Linked before, the agent's Skill folder is still there, the link is not: the person removed it.
          links.splice(index, 1); dismissed.add(path); changed = true; dismissedNow.push(change);
          continue;
        }
        if (dryRun) { added.push(change); continue; }
        const outcome = await placeNewLink(path, entry.canonical, agent, { ...(options.platform ? { platform: options.platform } : {}), ...(options.symlinkFn ? { symlinkFn: options.symlinkFn } : {}) });
        if (outcome.mode === "skipped") { skipped.push({ ...change, reason: outcome.reason ?? "skipped" }); if (outcome.reason?.startsWith("could not")) clean = false; continue; }
        if (index >= 0) links.splice(index, 1);
        links.push({ path, mode: outcome.mode });
        dismissed.delete(path);
        changed = true;
        added.push(change);
      }
      if (changed && !dryRun) await entry.save(links, [...dismissed]);
    } catch { clean = false; }
  }
  return { value: Object.freeze({ scanned: true, added, skipped, dismissed: dismissedNow }), clean };
}

async function lock(home: string): Promise<(() => Promise<void>) | null> {
  const path = join(home, ".config", "frely", "agent-links.lock");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      await file.writeFile(String(process.pid)); await file.close();
      return () => unlink(path).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(path).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age < LOCK_STALE_MS) return null;
      await unlink(path).catch(() => undefined);
    }
  }
  return null;
}

async function writeState(home: string, fingerprint: string): Promise<void> {
  const path = linkSyncStatePath(home);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${fingerprint}\n`, { mode: 0o600 });
  await rename(temporary, path).catch(async (error: unknown) => { await unlink(temporary).catch(() => undefined); throw error; });
}

async function exists(path: string): Promise<boolean> { return lstat(path).then(() => true, () => false); }

/** One line per agent that got new links, for a foreground command's stderr. */
export function linkSyncNotice(result: LinkSyncResult): string {
  const byAgent = new Map<LinkAgent, number>();
  for (const change of result.added) byAgent.set(change.agent, (byAgent.get(change.agent) ?? 0) + 1);
  return [...byAgent].map(([agent, count]) => `Linked ${count} Frely Skill${count === 1 ? "" : "s"} into ${agent}. Restart ${agent} so it rescans Skills.\n`).join("");
}

/** The background service's pass: once at start, then every `intervalMs` (default 10 minutes). Returns a stop function. */
export function watchAgentLinks(input: { readonly log?: (message: string) => void; readonly intervalMs?: number; readonly home?: string } = {}): () => void {
  const run = () => {
    void syncAgentLinks({ mode: "full", ...(input.home ? { home: input.home } : {}) }).then((result) => {
      if (result.added.length > 0) input.log?.(`agent_links.added ${result.added.length}`);
    }, () => undefined);
  };
  run();
  const timer = setInterval(run, input.intervalMs ?? 10 * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
