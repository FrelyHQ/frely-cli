import { cp, lstat, mkdir, readFile, readlink, realpath, rm, rmdir, symlink, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { SkillHost, SkillScope } from "./managed.js";

/**
 * A Skill has one copy, in `.agents/skills`. Agents that do not read that folder (and are present on this computer) get a link to it in
 * their own Skill folder. Agents that read `.agents` (Codex, OpenCode, ...) get nothing, so a Skill is never loaded twice.
 */
export type LinkAgent = "workbuddy" | "codebuddy" | "claude-code" | "pi";
export type LinkMode = "symlink" | "junction" | "copy";

export interface LinkRecord { readonly path: string; readonly mode: LinkMode }
export interface LinkOutcome {
  readonly agent: LinkAgent | null;
  readonly path: string;
  readonly mode: LinkMode | "skipped";
  readonly reason?: string;
}

interface AgentDir {
  /** Folder whose existence says the agent is installed here: relative to the home folder or the project. */
  readonly detect: string;
  readonly global: string;
  readonly project: string;
}

export const LINK_AGENTS: Readonly<Record<LinkAgent, AgentDir>> = {
  workbuddy: { detect: ".workbuddy", global: join(".workbuddy", "skills"), project: join(".workbuddy", "skills") },
  codebuddy: { detect: ".codebuddy", global: join(".codebuddy", "skills"), project: join(".codebuddy", "skills") },
  "claude-code": { detect: ".claude", global: join(".claude", "skills"), project: join(".claude", "skills") },
  pi: { detect: ".pi", global: join(".pi", "agent", "skills"), project: join(".pi", "skills") },
};

export function isLinkAgent(host: string | undefined): host is LinkAgent {
  return host !== undefined && Object.prototype.hasOwnProperty.call(LINK_AGENTS, host);
}

export function agentSkillRoot(agent: LinkAgent, scope: SkillScope, base: string): string {
  return join(base, LINK_AGENTS[agent][scope]);
}

export interface SkillContext { readonly base: string; readonly scope: SkillScope; readonly name: string; readonly canonical: string; readonly legacy: boolean }

/** Where a Skill folder sits: under `<base>/.agents/skills` (canonical) or under an agent's own folder (the layout before links existed). */
export function skillContext(folder: string, home = homedir()): SkillContext | null {
  const path = resolve(folder);
  const parent = dirname(path);
  const roots: Array<{ rel: string; legacy: boolean }> = [{ rel: join(".agents", "skills"), legacy: false }];
  for (const agent of Object.values(LINK_AGENTS)) for (const rel of [agent.global, agent.project]) roots.push({ rel, legacy: true });
  for (const { rel, legacy } of roots) {
    const suffix = sep + rel;
    if (parent === join(home, rel) || parent.endsWith(suffix)) {
      const base = parent === join(home, rel) ? resolve(home) : parent.slice(0, parent.length - suffix.length);
      if (base === "") continue;
      const scope: SkillScope = base === resolve(home) ? "global" : "project";
      const name = basename(path);
      return { base, scope, name, canonical: join(base, ".agents", "skills", name), legacy };
    }
  }
  return null;
}

/** The folder a Skill installed at `folder` belongs in now: the same name under `.agents/skills`. */
export function canonicalFolder(folder: string, home = homedir()): string {
  return skillContext(folder, home)?.canonical ?? resolve(folder);
}

type SymlinkFn = (target: string, path: string, type: "dir" | "junction") => Promise<void>;

export interface LinkInput {
  /** The Skill folder under `.agents/skills`. */
  readonly canonical: string;
  readonly home: string;
  /** What the person asked for with `--host`; a link-capable agent here is linked even if its folder is missing. */
  readonly host?: SkillHost;
  readonly previous?: readonly LinkRecord[];
  /** Relative path to SHA-256 of every file Frely wrote into `canonical` (a copy is only replaced while it still has these). */
  readonly previousFiles?: Readonly<Record<string, string>>;
  /** Called for an existing real folder in an agent's Skill folder; returns true when it is an untouched older Frely install of this same Skill (and has dropped its record), so it may be replaced by the link. */
  readonly adopt?: (path: string) => Promise<boolean>;
  readonly platform?: NodeJS.Platform;
  readonly symlinkFn?: SymlinkFn;
}

export async function linkSkill(input: LinkInput): Promise<{ links: LinkRecord[]; outcomes: LinkOutcome[] }> {
  const context = skillContext(input.canonical, input.home);
  const links: LinkRecord[] = [];
  const outcomes: LinkOutcome[] = [];
  const wanted = new Map<string, LinkAgent | null>();
  if (context !== null && !context.legacy) {
    for (const [agent, dir] of Object.entries(LINK_AGENTS) as Array<[LinkAgent, AgentDir]>) {
      const present = input.host === agent || await exists(join(context.base, dir.detect));
      if (present) wanted.set(join(agentSkillRoot(agent, context.scope, context.base), context.name), agent);
    }
  }
  for (const record of input.previous ?? []) if (!wanted.has(record.path)) wanted.set(record.path, null);
  const canonical = resolve(input.canonical);
  for (const [path, agent] of wanted) {
    const previous = input.previous?.find((record) => record.path === path);
    const outcome = await placeLink({ path, canonical, previous, input, agent });
    outcomes.push(outcome);
    if (outcome.mode !== "skipped") links.push({ path, mode: outcome.mode });
    else if (previous !== undefined) links.push(previous);
  }
  return { links, outcomes };
}

async function placeLink(args: { path: string; canonical: string; previous: LinkRecord | undefined; input: LinkInput; agent: LinkAgent | null }): Promise<LinkOutcome> {
  const { path, canonical, previous, input, agent } = args;
  const done = (mode: LinkMode): LinkOutcome => ({ agent, path, mode });
  const skip = (reason: string): LinkOutcome => ({ agent, path, mode: "skipped", reason });
  const info = await lstat(path).catch((error: unknown) => { if (isAbsent(error)) return null; throw error; });
  if (info !== null) {
    if (info.isSymbolicLink()) {
      if (await pointsTo(path, canonical)) return done(previous?.mode === "junction" ? "junction" : "symlink");
      return skip("a link to somewhere else already exists");
    }
    if (!info.isDirectory()) return skip("something else already exists");
    if (previous?.mode === "copy" && input.previousFiles !== undefined && await copyUntouched(path, input.previousFiles)) {
      await rm(path, { recursive: true, force: true });
    } else if (previous?.mode !== "copy" && input.adopt !== undefined && await input.adopt(path)) {
      await rm(path, { recursive: true, force: true });
    } else {
      return skip(previous?.mode === "copy" ? "the copy was edited" : "a folder Frely did not install already exists");
    }
  }
  await mkdir(dirname(path), { recursive: true });
  const platform = input.platform ?? process.platform;
  const type = platform === "win32" ? "junction" : "dir";
  try {
    await (input.symlinkFn ?? symlink)(canonical, path, type);
    return done(type === "junction" ? "junction" : "symlink");
  } catch {
    try {
      await cp(canonical, path, { recursive: true, errorOnExist: true, force: false });
      return done("copy");
    } catch (error) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      return skip(`could not link or copy (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
  }
}

/** Removes what `linkSkill` made. Call before the Skill folder itself goes. A link is removed itself, never through; a copy only while untouched. */
export async function unlinkSkill(links: readonly LinkRecord[] | undefined, canonical: string, files: Readonly<Record<string, string>>): Promise<LinkOutcome[]> {
  const outcomes: LinkOutcome[] = [];
  for (const link of links ?? []) {
    const info = await lstat(link.path).catch((error: unknown) => { if (isAbsent(error)) return null; throw error; });
    if (info === null) continue;
    if (info.isSymbolicLink()) {
      if (!await pointsTo(link.path, resolve(canonical))) { outcomes.push({ agent: null, path: link.path, mode: "skipped", reason: "points elsewhere; left in place" }); continue; }
      await unlink(link.path).catch(() => rmdir(link.path));
      outcomes.push({ agent: null, path: link.path, mode: link.mode });
    } else if (info.isDirectory() && link.mode === "copy" && await copyUntouched(link.path, files)) {
      await rm(link.path, { recursive: true, force: true });
      outcomes.push({ agent: null, path: link.path, mode: "copy" });
    } else {
      outcomes.push({ agent: null, path: link.path, mode: "skipped", reason: "edited or not made by Frely; left in place" });
    }
  }
  return outcomes;
}

/** Copies one file the install wrote after the links were made (a sealed-script lease) into every copy-mode link. */
export async function copyIntoCopies(links: readonly LinkRecord[], canonical: string, relativePath: string): Promise<void> {
  for (const link of links) {
    if (link.mode !== "copy") continue;
    await mkdir(dirname(join(link.path, relativePath)), { recursive: true });
    await cp(join(canonical, relativePath), join(link.path, relativePath), { force: true });
  }
}

async function copyUntouched(path: string, files: Readonly<Record<string, string>>): Promise<boolean> {
  for (const [relative, sha256] of Object.entries(files)) {
    const content = await readFile(join(path, relative)).catch(() => null);
    if (content === null || createHash("sha256").update(content).digest("hex") !== sha256) return false;
  }
  return true;
}

async function pointsTo(link: string, canonical: string): Promise<boolean> {
  const [a, b] = await Promise.all([realpath(link).catch(() => null), realpath(canonical).catch(() => null)]);
  if (a !== null && b !== null) return a === b;
  const target = await readlink(link).catch(() => null);
  return target !== null && resolve(dirname(link), target.replace(/^\\\\\?\\/u, "")).replace(/[\\/]+$/u, "") === canonical.replace(/[\\/]+$/u, "");
}

async function exists(path: string): Promise<boolean> { return lstat(path).then(() => true, () => false); }
function isAbsent(error: unknown): boolean { return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"; }

/** One line per link made or skipped, for the text output of an install. */
export function linkLines(outcomes: readonly LinkOutcome[] | undefined): string {
  return (outcomes ?? []).map((outcome) => outcome.mode === "skipped" ? `Skipped link: ${outcome.path} (${outcome.reason ?? "skipped"})\n` : `Linked: ${outcome.path} (${outcome.mode})\n`).join("");
}
