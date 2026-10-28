import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Where an Agent's code comes from: a Frely Agent page (`username/name`) or a public GitHub repository. */
export type AgentSource =
  | { kind: "frely"; user: string; name: string }
  | { kind: "github"; owner: string; repo: string };

export class SourceError extends Error {
  constructor(message: string) { super(message); this.name = "SourceError"; }
}

const FRELY_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

export function parseSource(target: string): AgentSource {
  const github = GITHUB_URL.exec(target);
  if (github) return { kind: "github", owner: github[1]!, repo: github[2]! };
  const [user, name, extra] = target.replace(/^@/u, "").split("/");
  if (user !== undefined && name !== undefined && extra === undefined && FRELY_PART.test(user) && FRELY_PART.test(name)) return { kind: "frely", user, name };
  throw new SourceError("Use a Frely Agent name such as username/name, or a public GitHub address such as https://github.com/owner/repo.");
}

export const githubUrl = (source: { owner: string; repo: string }): string => `https://github.com/${source.owner}/${source.repo}`;

/** The public record a Frely Agent page keeps for its repository. */
export interface RegisteredRepo { repoUrl: string; commit: string | undefined; name: string | undefined }

/** Reads the repository the Agent's author registered on Frely. The commit is the one the author listed. */
export async function resolveRegisteredRepo(user: string, name: string, relayUrl: string, fetchFn: typeof fetch = fetch): Promise<RegisteredRepo> {
  const response = await fetchFn(`${relayUrl}/api/public/agent-repos/${encodeURIComponent(user)}/${encodeURIComponent(name)}`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) throw new SourceError(`${user}/${name} is not a Frely Agent with a repository.`);
  if (!response.ok) throw new SourceError(`Frely could not look up ${user}/${name} (HTTP ${response.status}).`);
  const body = await response.json().catch(() => null) as { repoUrl?: unknown; commit?: unknown; name?: unknown } | null;
  if (!body || typeof body.repoUrl !== "string" || !GITHUB_URL.test(body.repoUrl)) throw new SourceError(`Frely returned no usable repository for ${user}/${name}.`);
  const commit = typeof body.commit === "string" && COMMIT.test(body.commit) ? body.commit : undefined;
  return { repoUrl: body.repoUrl.replace(/\.git$/u, "").replace(/\/$/u, ""), commit, name: typeof body.name === "string" ? body.name : undefined };
}

/** git with no prompts, no hooks, no submodules and https only: the repository is untrusted. */
async function git(args: readonly string[], cwd: string | undefined): Promise<string> {
  const safe = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false"];
  try {
    const { stdout } = await run("git", [...safe, ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" }, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim().split("\n").slice(-3).join(" ");
    throw new SourceError(`git ${args[0]} failed${stderr ? `: ${stderr}` : "."}`);
  }
}

/** Downloads `repoUrl` into the empty-or-missing `dir`, at `commit` when one is given, else at the default branch. Returns the commit that is checked out. */
export async function download(repoUrl: string, dir: string, commit: string | undefined): Promise<string> {
  await mkdir(dirname(dir), { recursive: true });
  if (commit) {
    await mkdir(dir, { recursive: true });
    await git(["init", "--quiet"], dir);
    await git(["fetch", "--quiet", "--depth", "1", "--no-tags", "--no-recurse-submodules", repoUrl, commit], dir);
    await git(["checkout", "--quiet", "FETCH_HEAD"], dir);
  } else {
    await git(["clone", "--quiet", "--depth", "1", "--no-tags", "--single-branch", "--no-recurse-submodules", repoUrl, dir], undefined);
  }
  const head = await git(["rev-parse", "HEAD"], dir);
  if (!COMMIT.test(head)) throw new SourceError("git did not report a commit.");
  return head;
}
