import { installDirName, managedSkillRoot, type SkillHost, type SkillScope } from "./managed.js";
import { CloudItemError, safeRelativePath, writeItemFolder, type ItemFile } from "./cloud-item.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Same limits as every other item. */
const MAX_FILES = 512;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const SHA = /^[0-9a-f]{40}$/u;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPO = /^[A-Za-z0-9._-]{1,100}$/u;

export type GithubFetch = (url: string, accept: string) => Promise<Response>;

const defaultFetch: GithubFetch = (url, accept) => fetch(url, { headers: { accept, "user-agent": "frely-cli" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });

export interface GithubItemInstallResult {
  readonly id: string;
  readonly name: string;
  readonly commit: string;
  readonly license: string | null;
  readonly path: string;
  readonly files: number;
  readonly hasScripts: boolean;
  /** Always true: Frely does not scan files it does not hold. */
  readonly needsReview: true;
}

/**
 * Installs a listed public GitHub Skill at the exact commit Frely's page shows. Frely only says which repository and commit; the files come
 * straight from GitHub (two hosts, both fixed here), so Frely stores and forwards nothing. The commit is never replaced by a newer one.
 */
export async function installGithubItem(input: {
  readonly login: string; readonly repo: string; readonly commitSha: string; readonly license: string | null; readonly hasScripts: boolean;
  readonly host?: SkillHost; readonly scope?: SkillScope; readonly dir?: string; readonly cwd?: string; readonly home?: string; readonly fetch?: GithubFetch;
}): Promise<GithubItemInstallResult> {
  const { login, repo, commitSha } = input;
  if (!LOGIN.test(login) || !REPO.test(repo) || repo === "." || repo === ".." || !SHA.test(commitSha)) throw new CloudItemError("item_invalid", "Frely returned an invalid GitHub Skill.");
  const get = input.fetch ?? defaultFetch;
  const treeUrl = `https://api.github.com/repos/${encodeURIComponent(login)}/${encodeURIComponent(repo)}/git/trees/${commitSha}?recursive=1`;
  const treeResponse = await get(treeUrl, "application/vnd.github+json").catch(() => { throw new CloudItemError("item_invalid", "GitHub could not be reached."); });
  if (!treeResponse.ok) throw new CloudItemError("item_invalid", `GitHub did not return commit ${commitSha.slice(0, 7)} of ${login}/${repo} (status ${treeResponse.status}). The repository may have been deleted or made private.`);
  const tree = (await treeResponse.json()) as { truncated?: unknown; tree?: Array<{ path?: unknown; type?: unknown; mode?: unknown; size?: unknown }> };
  if (tree.truncated === true || !Array.isArray(tree.tree)) throw new CloudItemError("item_invalid", "This repository is too large to install. Clone it yourself.");
  // Files only: no symlinks, no submodules, no repository metadata. Sizes come from the list, so limits hold before anything is downloaded.
  const entries = tree.tree.filter((entry) => entry.type === "blob" && entry.mode !== "120000" && typeof entry.path === "string"
    && !(entry.path as string).split("/").some((part) => part === ".git" || part === ".github")) as Array<{ path: string; size?: number }>;
  const total = entries.reduce((sum, entry) => sum + (typeof entry.size === "number" ? entry.size : 0), 0);
  if (entries.length > MAX_FILES || total > MAX_TOTAL_BYTES) throw new CloudItemError("item_invalid", `This repository is too large to install (limit ${MAX_FILES} files, 8 MB). Clone it yourself.`);
  if (!entries.some((entry) => entry.path === "SKILL.md")) throw new CloudItemError("item_invalid", "This repository has no SKILL.md at its root.");

  const paths = entries.map((entry) => safeRelativePath(entry.path));
  const files: ItemFile[] = [];
  let downloaded = 0;
  for (const path of paths) {
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(login)}/${encodeURIComponent(repo)}/${commitSha}/${path.split("/").map(encodeURIComponent).join("/")}`;
    const response = await get(url, "application/octet-stream").catch(() => { throw new CloudItemError("item_invalid", "GitHub could not be reached."); });
    if (!response.ok) throw new CloudItemError("item_invalid", `GitHub did not return ${path} (status ${response.status}).`);
    const content = Buffer.from(await response.arrayBuffer());
    downloaded += content.length;
    if (downloaded > MAX_TOTAL_BYTES) throw new CloudItemError("item_invalid", "This repository is too large to install. Clone it yourself.");
    files.push({ path, contentBase64: content.toString("base64"), isScript: false });
  }

  const home = input.home ?? homedir();
  const cwd = input.cwd ?? process.cwd();
  const name = `github-${login.toLowerCase()}/${repo.toLowerCase()}`;
  const target = join(managedSkillRoot(input.host ?? "generic", input.scope ?? "global", resolve(cwd, input.scope === "project" ? input.dir ?? "." : "."), home), installDirName(name));
  const itemId = `github:${login.toLowerCase()}/${repo.toLowerCase()}`;
  await writeItemFolder(target, itemId, "skill", files, home);
  return Object.freeze({ id: itemId, name, commit: commitSha, license: input.license, path: target, files: files.length, hasScripts: input.hasScripts, needsReview: true });
}
