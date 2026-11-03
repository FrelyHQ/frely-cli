/**
 * The CLI-owned Pi Node Capsule (M2): the CLI downloads the Capsule the Frely App publishes as a release asset,
 * verifies it and records it in `install.json`, which has the same shape as the App's `app.json`. The supervisor
 * then runs it exactly as it runs an App-installed one. The App is not needed.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { checkReleaseSignature } from "../update/release-signature.js";
import { APP_INSTALL_SCHEMA_VERSION, AppInstallError, readAppInstall, verifyCapsule, verifyCapsuleIntegrity, type AppInstall } from "./app-install.js";

export const CAPSULE_REPOSITORY = "FrelyHQ/frely-app";
export const CAPSULE_TAG_PREFIX = "capsule/v";
const PROTOCOL_VERSION = 1;
const MAX_ARCHIVE_BYTES = 400 * 1024 * 1024;

export function piNodeHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "pi-node");
}
export const cliInstallPath = (env: NodeJS.ProcessEnv = process.env): string => join(piNodeHome(env), "install.json");

export function capsuleTargetId(platform: string = process.platform, arch: string = process.arch): string {
  if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) throw new Error(`No Pi Node Capsule exists for ${platform}-${arch}.`);
  return `${platform}-${arch}`;
}

/** The install the CLI manages itself, or throws `app_not_installed` when none was made. */
export function readCliInstall(env: NodeJS.ProcessEnv = process.env): Promise<AppInstall> {
  return readAppInstall(cliInstallPath(env), env);
}

/** The App's install when there is one, otherwise the CLI's own. */
export async function readAnyInstall(env: NodeJS.ProcessEnv = process.env): Promise<AppInstall> {
  try { return await readAppInstall(undefined, env); } catch (error) {
    if (!(error instanceof AppInstallError) || error.code !== "app_not_installed") throw error;
    return readCliInstall(env);
  }
}

type ReleaseAsset = { name: string; browser_download_url: string };
type Release = { tag_name: string; draft?: boolean; prerelease?: boolean; assets: ReleaseAsset[] };

export interface CapsuleInstallDeps {
  readonly fetchFn?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly target?: string;
  /** Lists archive entries / extracts the archive; replaced in tests. */
  readonly tar?: (args: string[]) => Promise<string>;
  readonly verifyIntegrity?: (install: AppInstall) => Promise<void>;
}

export interface CapsuleInstallResult { readonly tag: string; readonly capsulePath: string; readonly changed: boolean }

function runTar(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve(out) : reject(new Error("The Capsule archive could not be unpacked."))));
  });
}

async function download(fetchFn: typeof fetch, url: string, limit: number): Promise<Buffer> {
  const response = await fetchFn(url, { headers: { "user-agent": "frely-cli" }, redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > limit) throw new Error("The download is larger than expected.");
  return body;
}

/** Finds the newest Capsule release for this platform. */
export async function latestCapsuleRelease(fetchFn: typeof fetch, target: string): Promise<{ tag: string; archive: ReleaseAsset; checksum: ReleaseAsset; signature?: ReleaseAsset }> {
  const response = await fetchFn(`https://api.github.com/repos/${CAPSULE_REPOSITORY}/releases?per_page=30`, { headers: { accept: "application/vnd.github+json", "user-agent": "frely-cli" } });
  if (!response.ok) throw new Error(`Could not list Capsule releases (${response.status}).`);
  const releases = (await response.json()) as Release[];
  const archiveName = `pi-node-capsule-${target}.tar.gz`;
  for (const release of releases) {
    if (release.draft || release.prerelease || !release.tag_name.startsWith(CAPSULE_TAG_PREFIX)) continue;
    const archive = release.assets.find((asset) => asset.name === archiveName);
    const checksum = release.assets.find((asset) => asset.name === `${archiveName}.sha256`);
    if (!archive || !checksum) continue;
    const signature = release.assets.find((asset) => asset.name === `${archiveName}.sig`);
    return { tag: release.tag_name, archive, checksum, ...(signature ? { signature } : {}) };
  }
  throw new Error(`No Pi Node Capsule is published for ${target} yet.`);
}

/**
 * Installs (or updates to) the newest Capsule. The archive must match its published SHA-256, contain only relative paths
 * and pass the manifest's file-by-file integrity check before it replaces anything. A running node keeps its old files
 * until the supervisor sees the new install and restarts it.
 */
export async function installCapsule(deps: CapsuleInstallDeps = {}): Promise<CapsuleInstallResult> {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;
  const tar = deps.tar ?? runTar;
  const target = deps.target ?? capsuleTargetId();
  const release = await latestCapsuleRelease(fetchFn, target);
  const home = piNodeHome(env);
  await mkdir(join(home, "capsules"), { recursive: true, mode: 0o700 });
  const current = await readCliInstall(env).catch(() => null);
  const work = await mkdtemp(join(tmpdir(), "frely-capsule-"));
  try {
    const archive = await download(fetchFn, release.archive.browser_download_url, MAX_ARCHIVE_BYTES);
    const checksumText = (await download(fetchFn, release.checksum.browser_download_url, 4096)).toString("utf8");
    const expected = /^([a-fA-F0-9]{64})(?:\s|$)/u.exec(checksumText)?.[1]?.toLowerCase();
    if (!expected || createHash("sha256").update(archive).digest("hex") !== expected) throw new Error("The Capsule download does not match its checksum.");
    const signature = release.signature ? (await download(fetchFn, release.signature.browser_download_url, 4096)).toString("utf8") : undefined;
    checkReleaseSignature({ version: release.tag, asset: release.archive.name, checksumText, signature });

    const file = join(work, "capsule.tar.gz");
    await writeFile(file, archive, { mode: 0o600 });
    for (const entry of (await tar(["-tzf", file])).split(/\r?\n/u).filter(Boolean)) {
      if (entry.startsWith("/") || /^[a-zA-Z]:/u.test(entry) || entry.split(/[\\/]/u).includes("..")) throw new Error("The Capsule archive has an unsafe path.");
    }
    const staged = join(work, "files");
    await mkdir(staged, { mode: 0o700 });
    await tar(["-xzf", file, "-C", staged, "--no-same-owner"]);

    const probe: AppInstall = { schemaVersion: APP_INSTALL_SCHEMA_VERSION, appVersion: release.tag, capsulePath: staged, protocolVersion: PROTOCOL_VERSION, agentDir: join(home, "agent"), projectsFile: join(home, "projects.json") };
    const facts = await verifyCapsule(probe);
    await (deps.verifyIntegrity ?? verifyCapsuleIntegrity)(probe);

    const destination = join(home, "capsules", facts.manifest.sourceCommit);
    await rm(destination, { recursive: true, force: true });
    await rename(staged, destination);
    const install: AppInstall = { ...probe, capsulePath: destination };
    await mkdir(install.agentDir, { recursive: true, mode: 0o700 });
    const projects = await readFile(install.projectsFile, "utf8").catch(() => "[]\n");
    await writeFile(install.projectsFile, projects, { mode: 0o600 });
    const record = cliInstallPath(env);
    await writeFile(`${record}.tmp`, `${JSON.stringify(install, null, 2)}\n`, { mode: 0o600 });
    await rename(`${record}.tmp`, record);
    await prune(join(home, "capsules"), destination, current?.capsulePath);
    return { tag: release.tag, capsulePath: destination, changed: current?.capsulePath !== destination };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Keeps the new Capsule and the one it replaced (a running node may still use it); removes older ones. */
async function prune(directory: string, keep: string, previous: string | undefined): Promise<void> {
  for (const name of await readdir(directory).catch(() => [])) {
    const path = join(directory, name);
    if (path !== keep && path !== previous) await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}
