import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/**
 * Guard for `.git/config` writes made by `run_command` (see allowGitConfig in sandbox.ts).
 *
 * The sandbox lets a command change the workspace `.git/config` so `git push -u`, `git remote add`, `git config user.name` and
 * `git submodule` work. A git config can also make git run programs later, outside the sandbox (an fsmonitor, a credential helper, a
 * `!` alias, a pager...). So the files are snapshotted before the command and compared after it exits: every key that makes git run a
 * program and that the command added or changed is removed again, and the caller tells the model what was removed.
 *
 * All reading and writing goes through `git config --file`, so the formatting and comments of the file are kept. Includes are never
 * followed. If git itself cannot be used, the file is put back byte for byte instead.
 */

/** How deep below the workspace root `.git` directories are looked for; matches the sandbox's own scan depth. */
const SCAN_DEPTH = 3;
const MAX_SCANNED_DIRECTORIES = 5000;
const GIT_TIMEOUT_MS = 10_000;

export interface ConfigEntry { key: string; value: string }
export interface RemovedConfigKey { file: string; key: string }
export interface GuardResult { removed: RemovedConfigKey[]; restored: string[]; unreadable: string[] }

/**
 * Whether a git config entry makes git run a program (or load configuration that can). `key` is `section.subsection.variable`
 * as `git config --list` prints it; section and variable names are case-insensitive, the subsection is not.
 */
export function runsPrograms(key: string, value: string): boolean {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first < 1) return false;
  const section = key.slice(0, first).toLowerCase();
  const variable = key.slice(last + 1).toLowerCase();
  const hasSubsection = last > first;
  switch (section) {
    case "core": return !hasSubsection && ["fsmonitor", "sshcommand", "hookspath", "pager", "editor", "askpass", "gitproxy", "alternaterefscommand"].includes(variable);
    case "credential": return variable === "helper";
    case "filter": return hasSubsection && ["clean", "smudge", "process"].includes(variable);
    case "diff": return hasSubsection ? ["textconv", "command"].includes(variable) : variable === "external";
    case "merge": return hasSubsection && variable === "driver";
    case "gpg": return variable === "program";
    case "include":
    case "includeif": return variable === "path";
    case "uploadpack":
    case "receivepack": return true;
    case "remote": return hasSubsection && ["uploadpack", "receivepack", "vcs"].includes(variable);
    case "sequence": return !hasSubsection && variable === "editor";
    case "alias": return !hasSubsection && value.trimStart().startsWith("!");
    case "submodule": return hasSubsection && variable === "update" && value.trimStart().startsWith("!");
    case "pager": return true;
    case "difftool":
    case "mergetool":
    case "trailer":
    case "browser":
    case "man": return hasSubsection && variable === "cmd";
    case "web": return !hasSubsection && variable === "browser";
    case "init": return !hasSubsection && variable === "templatedir";
    case "protocol": return hasSubsection && variable === "allow" && key.slice(first + 1, last).toLowerCase() === "ext";
    default: return false;
  }
}

function git(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: tmpdir(), timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}

let gitUsable: Promise<boolean> | undefined;

/** Whether `git` can be run here. Without it the guard cannot do its job, so the sandbox keeps `.git/config` read-only. */
export function gitConfigGuardAvailable(): Promise<boolean> {
  gitUsable ??= git(["--version"]).then(() => true, () => false);
  return gitUsable;
}

/** Test hook: forget the cached `git --version` answer. */
export function resetGitConfigGuardForTests(): void {
  gitUsable = undefined;
}

/** All entries of one config file, in file order. Throws when git cannot parse the file. */
export async function listConfigEntries(file: string): Promise<ConfigEntry[]> {
  const output = await git(["config", "--file", file, "--no-includes", "--list", "-z"]);
  return output.split("\0").filter((item) => item !== "").map((item) => {
    const newline = item.indexOf("\n");
    // A key written without a value (`[core] fsmonitor`) is the boolean true.
    return newline === -1 ? { key: item, value: "true" } : { key: item.slice(0, newline), value: item.slice(newline + 1) };
  });
}

/** Keys of `after` that run programs and whose entries are not all already present in `before`. */
export function addedProgramKeys(before: readonly ConfigEntry[], after: readonly ConfigEntry[]): string[] {
  const remaining = new Map<string, number>();
  for (const { key, value } of before) remaining.set(`${key}\0${value}`, (remaining.get(`${key}\0${value}`) ?? 0) + 1);
  const keys = new Set<string>();
  for (const { key, value } of after) {
    if (!runsPrograms(key, value)) continue;
    const id = `${key}\0${value}`;
    const count = remaining.get(id) ?? 0;
    if (count > 0) remaining.set(id, count - 1); else keys.add(key);
  }
  return [...keys];
}

/** Every `.git/config` (a real `.git` directory, not a worktree link) at most SCAN_DEPTH levels below `root`. */
export async function findGitConfigs(root: string): Promise<string[]> {
  const found: string[] = [];
  let scanned = 0;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (scanned++ >= MAX_SCANNED_DIRECTORIES) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.name === ".git") found.push(join(path, "config"));
      else if (depth < SCAN_DEPTH) await visit(path, depth + 1);
    }
  };
  await visit(root, 0);
  return found;
}

async function readRaw(file: string): Promise<string | null> {
  try {
    if (!(await stat(file)).isFile()) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export class GitConfigGuard {
  private constructor(private readonly root: string, private readonly before: ReadonlyMap<string, string | null>) {}

  /** Record the content of every `.git/config` below `root`. */
  static async snapshot(root: string): Promise<GitConfigGuard> {
    const files = await findGitConfigs(root);
    return new GitConfigGuard(root, new Map(await Promise.all(files.map(async (file) => [file, await readRaw(file)] as const))));
  }

  /** Compare with the snapshot and undo every program-running key the command added or changed. Never throws. */
  async restore(): Promise<GuardResult> {
    const result: GuardResult = { removed: [], restored: [], unreadable: [] };
    let files: string[];
    try { files = [...new Set([...this.before.keys(), ...(await findGitConfigs(this.root))])]; } catch { files = [...this.before.keys()]; }
    for (const file of files) {
      const previous = this.before.get(file) ?? null;
      const now = await readRaw(file);
      if (now === null || now === previous) continue;
      try {
        const before = previous === null ? [] : await entriesOfText(previous, file);
        const added = addedProgramKeys(before, await listConfigEntries(file));
        for (const key of added) {
          await git(["config", "--file", file, "--no-includes", "--unset-all", key]);
          for (const entry of before.filter((item) => item.key === key)) await git(["config", "--file", file, "--no-includes", "--add", entry.key, entry.value]);
          result.removed.push({ file: relative(this.root, file) || file, key });
        }
      } catch {
        // git cannot parse one of the two versions: an existing file goes back byte for byte, a new unparseable file cannot be used by git either.
        if (previous !== null) {
          try { await writeFile(file, previous); result.restored.push(relative(this.root, file) || file); } catch { result.unreadable.push(relative(this.root, file) || file); }
        } else result.unreadable.push(relative(this.root, file) || file);
      }
    }
    return result;
  }
}

/**
 * Entries of the snapshot text. The snapshot is raw text, so it is parsed by writing nothing: `git config --file` needs a path, and
 * the file on disk has already changed. A stdin form exists (`--blob` or `-f -`) only for newer git, so the text goes through a
 * temporary file instead.
 */
async function entriesOfText(text: string, label: string): Promise<ConfigEntry[]> {
  const dir = await mkdtemp(join(tmpdir(), "frely-gitconfig-"));
  try {
    const copy = join(dir, "config");
    await writeFile(copy, text, { mode: 0o600 });
    return await listConfigEntries(copy);
  } catch (error) {
    throw new Error(`cannot parse the saved copy of ${label}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One short note for the command result, or undefined when the guard changed nothing. */
export function guardNote(result: GuardResult): string | undefined {
  const parts: string[] = [];
  if (result.removed.length > 0) {
    parts.push(`removed ${result.removed.map(({ file, key }) => `${key} (${file})`).join(", ")}, because those settings make git run programs and the command sandbox does not allow commands to set them`);
  }
  if (result.restored.length > 0) parts.push(`restored ${result.restored.join(", ")} to its content before the command, because it could no longer be parsed`);
  if (result.unreadable.length > 0) parts.push(`could not check ${result.unreadable.join(", ")}; look at it before running git there`);
  return parts.length === 0 ? undefined : `[Frely sandbox] .git/config: ${parts.join("; ")}.`;
}

/** Per workspace, the state of its `.git/config` files right after the last guarded command's check. */
const lastChecked = new Map<string, GitConfigGuard>();

/** Remember the current state of the workspace's `.git/config` files as the reference for the next check. */
export async function rememberGitConfigs(root: string): Promise<void> {
  lastChecked.set(root, await GitConfigGuard.snapshot(root));
}

/**
 * Run the guard against the state remembered after the previous guarded command in this workspace. It catches a write made between
 * commands by a process that escaped the process-group kill (setsid, double fork). Does nothing for a workspace without a remembered state.
 */
export async function checkRememberedGitConfigs(root: string): Promise<GuardResult | undefined> {
  const previous = lastChecked.get(root);
  if (!previous) return undefined;
  const result = await previous.restore();
  await rememberGitConfigs(root);
  return result;
}

/** Test hook. */
export function forgetRememberedGitConfigsForTests(): void {
  lastChecked.clear();
}

/** Joins notes, skipping empty ones. */
export const joinNotes = (...notes: (string | undefined)[]): string | undefined => {
  const present = notes.filter((note): note is string => note !== undefined);
  return present.length === 0 ? undefined : present.join("\n");
};

export const LEFTOVERS_NOTE = "[Frely sandbox] Background processes left running by this command were stopped (commands that may change .git/config cannot leave processes behind).";
