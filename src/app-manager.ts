import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/**
 * `frely app install|open|status|update|uninstall` — install and manage the
 * Frely App (GUI) from the frely-cli side (architecture doc §8.2).
 *
 * Distribution facts (tool/release_contract.mjs in the app repository):
 * - public release mirror: github.com/FrelyHQ/frely-cli (the private source
 *   repository never serves downloads directly)
 * - release tags: `frely-app-v<version>` (legacy `frely-client-v<version>`)
 * - asset names: `Frely-App-<version>-<label>.<ext>` (legacy `Pi-Client-…`)
 * - Homebrew: `brew install --cask frelyhq/tap/frely-app`
 */

export type AppAsset = {
  name: string;
  url: string;
  size: number;
};

export type AppRelease = {
  tag: string;
  version: string;
  prerelease: boolean;
  assets: AppAsset[];
};

export type AppInstallStatus = {
  installed: boolean;
  path?: string;
  version?: string;
  running: boolean;
  managedBy: "homebrew" | "manual" | "none";
};

export const DISTRIBUTION_REPO = "FrelyHQ/frely-cli";
export const TAG_PREFIXES = ["frely-app-v", "frely-client-v"] as const;
export const ASSET_PREFIXES = ["Frely-App-", "Pi-Client-"] as const;
export const HOMEBREW_CASK = "frely-app";
export const HOMEBREW_LEGACY_CASK = "frely-client";
export const DARWIN_APP_NAMES = ["Frely App.app", "Frely Client.app"] as const;

export type AppManagerDeps = {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  fetchText?: (url: string) => Promise<string>;
  downloadFile?: (url: string, destination: string) => Promise<void>;
  run?: (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  which?: (command: string) => string | undefined;
  pathExists?: (path: string) => Promise<boolean>;
  log?: (message: string) => void;
};

const defaultRun = (command: string, args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => resolveRun({ code: -1, stdout, stderr: String(error) }));
    child.on("close", (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
  });

const defaultFetchText = async (url: string) => {
  const response = await fetch(url, { headers: { accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${url}`);
  return response.text();
};

const defaultDownloadFile = async (url: string, destination: string) => {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
};

export function resolveDeps(deps: AppManagerDeps = {}): Required<AppManagerDeps> {
  return {
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
    env: deps.env ?? process.env,
    fetchText: deps.fetchText ?? defaultFetchText,
    downloadFile: deps.downloadFile ?? defaultDownloadFile,
    run: deps.run ?? defaultRun,
    which: deps.which ?? ((command) => (defaultWhich(command) ? command : undefined)),
    pathExists: deps.pathExists ?? fileExists,
    log: deps.log ?? ((message) => process.stdout.write(`${message}\n`)),
  };
}

function defaultWhich(command: string): boolean {
  const pathDirectories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = process.platform === "win32" ? [command, `${command}.exe`] : [command];
  for (const directory of pathDirectories) {
    for (const candidate of candidates) {
      try {
        accessSync(join(directory, candidate));
        return true;
      } catch {
        // continue
      }
    }
  }
  return false;
}


/** Lists published app releases on the distribution mirror, newest tags first. */
export async function listAppReleases(deps: AppManagerDeps = {}, limit = 10): Promise<AppRelease[]> {
  const d = resolveDeps(deps);
  const body = await d.fetchText(`https://api.github.com/repos/${DISTRIBUTION_REPO}/releases?per_page=30`);
  const raw = JSON.parse(body) as Array<{
    tag_name: string;
    prerelease: boolean;
    assets: Array<{ name: string; browser_download_url: string; size: number }>;
  }>;
  return raw
    .filter((release) => TAG_PREFIXES.some((prefix) => release.tag_name.startsWith(prefix)))
    .map((release) => ({
      tag: release.tag_name,
      version: release.tag_name.replace(/^frely-(app|client)-v/, ""),
      prerelease: release.prerelease,
      assets: (release.assets ?? []).map((asset) => ({ name: asset.name, url: asset.browser_download_url, size: asset.size })),
    }))
    .slice(0, limit);
}

export type AssetSelection = { release: AppRelease; asset: AppAsset; sha256Url: string | undefined };

/** Picks the best asset for the current platform/arch. */
export function selectAssetForPlatform(
  releases: AppRelease[],
  platform: NodeJS.Platform,
  arch: string,
): AssetSelection | null {
  const normalizedArch = arch === "x64" ? "x64" : arch;
  const wants =
    platform === "darwin"
      ? ["macos", "darwin"]
      : platform === "win32"
        ? ["windows", "win32"]
        : ["linux"];
  const matchAsset = (release: AppRelease, prefix: string, predicate: (lower: string) => boolean) => {
    const asset = release.assets.find((candidate) => {
      const lower = candidate.name.toLowerCase();
      return candidate.name.startsWith(prefix) && predicate(lower);
    });
    if (!asset) return undefined;
    const sha256 = release.assets.find((candidate) => candidate.name === `${asset.name}.sha256`);
    return { release, asset, sha256Url: sha256 ? sha256.url : undefined };
  };
  const validExtensions = (lower: string) => lower.endsWith(".dmg") || lower.endsWith(".zip") || lower.endsWith(".appimage") || lower.endsWith(".exe");
  const archMatchers =
    platform === "win32"
      ? [(lower: string) => lower.includes("x64")]
      : [
          (lower: string) => lower.includes(normalizedArch) || (normalizedArch === "x64" && lower.includes("amd64")),
          (lower: string) => lower.includes("universal"),
        ];
  for (const prefix of ASSET_PREFIXES) {
    for (const release of releases) {
      // Prefer an arch-specific asset, then fall back to universal builds.
      for (const archMatcher of archMatchers) {
        const selection = matchAsset(release, prefix, (lower) => validExtensions(lower) && wants.some((token) => lower.includes(token)) && archMatcher(lower));
        if (selection) return selection;
      }
    }
  }
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function darwinAppDirectories(deps: Required<AppManagerDeps>): string[] {
  const applications = resolve("/Applications");
  const userApplications = join(homedir(), "Applications");
  const names = deps.platform === "darwin" ? DARWIN_APP_NAMES : [];
  const directories: string[] = [];
  for (const base of [applications, userApplications]) {
    for (const name of names) directories.push(join(base, name));
  }
  return directories;
}

export async function appInstallStatus(deps: AppManagerDeps = {}): Promise<AppInstallStatus> {
  const d = resolveDeps(deps);
  if (d.platform === "darwin") {
    const brew = d.which("brew");
    let managedBy: AppInstallStatus["managedBy"] = "none";
    if (brew) {
      const info = await d.run("brew", ["list", "--cask", HOMEBREW_CASK]);
      const legacy = info.code === 0 ? null : await d.run("brew", ["list", "--cask", HOMEBREW_LEGACY_CASK]);
      if (info.code === 0 || legacy?.code === 0) managedBy = "homebrew";
    }
    for (const directory of darwinAppDirectories(d)) {
      if (await d.pathExists(directory)) {
        const plist = join(directory, "Contents/Info.plist");
        const version = await d
          .run("defaults", ["read", plist, "CFBundleShortVersionString"])
          .then((result) => (result.code === 0 ? result.stdout.trim() : undefined))
          .catch(() => undefined);
        const running = await d
          .run("pgrep", ["-f", `${directory}/Contents/MacOS/`])
          .then((result) => result.code === 0)
          .catch(() => false);
        return { installed: true, path: directory, ...(version ? { version } : {}), running, managedBy: managedBy === "homebrew" ? "homebrew" : "manual" };
      }
    }
    return { installed: false, running: false, managedBy };
  }
  // Linux/Windows: installed state is tracked by the download destination.
  const destination = await appDownloadDestination(d);
  if (destination && (await d.pathExists(destination))) {
    return { installed: true, path: destination, running: false, managedBy: "manual" };
  }
  return { installed: false, running: false, managedBy: "none" };
}

async function appDownloadDestination(d: Required<AppManagerDeps>): Promise<string | undefined> {
  if (d.platform === "linux") return join(homedir(), ".local", "opt", "frely-app");
  if (d.platform === "win32") return join(d.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "FrelyApp");
  return undefined;
}

async function verifySha256(d: Required<AppManagerDeps>, assetPath: string, sha256Url: string | undefined): Promise<void> {
  if (!sha256Url) return;
  const checksum = (await d.fetchText(sha256Url)).trim().split(/\s+/)[0];
  if (!checksum || !/^[0-9a-f]{64}$/.test(checksum)) return;
  const { createHash } = await import("node:crypto");
  const actual = createHash("sha256").update(await readFile(assetPath)).digest("hex");
  if (actual !== checksum) throw new Error(`SHA-256 mismatch for ${assetPath}: expected ${checksum}, got ${actual}`);
}

export type InstallResult = {
  installed: boolean;
  method: "homebrew" | "download";
  path?: string;
  version?: string;
};


async function findFirstExisting(d: Required<AppManagerDeps>, paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    if (await d.pathExists(candidate)) return candidate;
  }
  return undefined;
}

export async function installApp(deps: AppManagerDeps = {}, options: { force?: boolean } = {}): Promise<InstallResult> {
  const d = resolveDeps(deps);
  if (!options.force) {
    const status = await appInstallStatus(deps);
    if (status.installed) {
      d.log(`Frely App is already installed${status.version ? ` (version ${status.version})` : ""} at ${status.path}.`);
      d.log("Pass --force to reinstall or run `frely app update`.");
      return { installed: true, method: status.managedBy === "homebrew" ? "homebrew" : "download", ...(status.path ? { path: status.path } : {}), ...(status.version ? { version: status.version } : {}) };
    }
  }
  if (d.platform === "darwin") {
    const brew = d.which("brew");
    if (brew) {
      d.log("Installing with Homebrew: brew install --cask frelyhq/tap/frely-app …");
      const result = await d.run("brew", ["install", "--cask", `frelyhq/tap/${HOMEBREW_CASK}`]);
      if (result.code !== 0) {
        d.log(result.stderr || result.stdout || "brew install failed.");
        throw new Error("brew install failed");
      }
      d.log("Installed. First launch: in Finder, Control-click \"Frely App\", choose Open, and confirm Open (quarantine is preserved on purpose).");
      const status = await appInstallStatus(deps);
      return { installed: true, method: "homebrew", ...(status.path ? { path: status.path } : {}), ...(status.version ? { version: status.version } : {}) };
    }
    return installFromRelease(deps, { destinationHint: resolve("/Applications") });
  }
  return installFromRelease(deps, {});
}

async function installFromRelease(deps: AppManagerDeps, options: { destinationHint?: string }): Promise<InstallResult> {
  const d = resolveDeps(deps);
  const releases = await listAppReleases(deps);
  const selection = selectAssetForPlatform(releases, d.platform, d.arch);
  if (!selection) throw new Error(`No Frely App release asset found for ${d.platform}/${d.arch} on ${DISTRIBUTION_REPO} (looked for tags ${TAG_PREFIXES.join(", ")}).`);
  d.log(`Downloading ${selection.asset.name} (${(selection.asset.size / 1_048_576).toFixed(1)} MB) from ${selection.release.tag} …`);
  const downloadDirectory = join(tmpdir(), "frely-app-install");
  await rm(downloadDirectory, { recursive: true, force: true });
  await mkdir(downloadDirectory, { recursive: true });
  const assetPath = join(downloadDirectory, selection.asset.name);
  await d.downloadFile(selection.asset.url, assetPath);
  await verifySha256(d, assetPath, selection.sha256Url);
  d.log("Download verified.");

  if (d.platform === "darwin") {
    const target = options.destinationHint && (await directoryWritable(options.destinationHint)) ? options.destinationHint : join(homedir(), "Applications");
    const installedPath = join(target, DARWIN_APP_NAMES[0]);
    if (selection.asset.name.endsWith(".zip")) {
      const extracted = join(downloadDirectory, "extracted");
      await mkdir(extracted, { recursive: true });
      const extract = await d.run("ditto", ["-x", "-k", assetPath, extracted]);
      if (extract.code !== 0) throw new Error(`Extraction failed: ${extract.stderr}`);
      const appSource = await findFirstExisting(d, DARWIN_APP_NAMES.map((name) => join(extracted, name)));
      if (!appSource) throw new Error("No .app bundle found inside the downloaded archive.");
      const copy = await d.run("ditto", [appSource, installedPath]);
      if (copy.code !== 0) throw new Error(`Copy failed: ${copy.stderr}`);
    } else {
      // dmg: mount, copy, unmount — quarantine is preserved (no -no-quarantine).
      const mountPoint = join(downloadDirectory, "mounted");
      await mkdir(mountPoint, { recursive: true });
      const mount = await d.run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, assetPath]);
      if (mount.code !== 0) throw new Error(`Could not mount ${assetPath}: ${mount.stderr}`);
      try {
        const appSource = await findFirstExisting(d, DARWIN_APP_NAMES.map((name) => join(mountPoint, name)));
        if (!appSource) throw new Error("No .app bundle found inside the downloaded image.");
        const copy = await d.run("ditto", [appSource, installedPath]);
        if (copy.code !== 0) throw new Error(`Copy failed: ${copy.stderr}`);
      } finally {
        await d.run("hdiutil", ["detach", mountPoint, "-force"]);
      }
    }
    d.log(`Installed to ${installedPath}.`);
    d.log("First launch: in Finder, Control-click \"Frely App\", choose Open, and confirm Open (quarantine is preserved on purpose).");
    return { installed: true, method: "download", path: installedPath };
  }

  const destination = await appDownloadDestination(d);
  if (!destination) throw new Error(`Unsupported platform for direct download: ${d.platform}`);
  await mkdir(destination, { recursive: true });
  const target = join(destination, selection.asset.name);
  await d.downloadFile(selection.asset.url, target);
  await verifySha256(d, target, selection.sha256Url);
  if (d.platform === "linux" && target.endsWith(".AppImage")) {
    const chmod = await d.run("chmod", ["+x", target]);
    if (chmod.code !== 0) d.log("Warning: could not mark the AppImage executable; run chmod +x manually.");
  }
  d.log(`Installed to ${target}.`);
  return { installed: true, method: "download", path: target };
}

async function directoryWritable(directory: string): Promise<boolean> {
  try {
    const info = await stat(directory);
    await access(directory, constants.W_OK);
    return info.isDirectory();
  } catch {
    return false;
  }
}

export async function openApp(deps: AppManagerDeps = {}, options: { window?: boolean } = {}): Promise<void> {
  const d = resolveDeps(deps);
  const status = await appInstallStatus(deps);
  if (!status.installed || !status.path) throw new Error("Frely App is not installed. Run `frely app install` first.");
  if (d.platform === "darwin") {
    const args = options.window ? ["-a", status.path] : ["-g", "-a", status.path];
    const result = await d.run("open", args);
    if (result.code !== 0) throw new Error(`Could not open Frely App: ${result.stderr}`);
    d.log(options.window ? "Frely App opened." : "Frely App started in the background.");
    return;
  }
  if (d.platform === "linux") {
    const result = await d.run("xdg-open", [status.path]);
    if (result.code !== 0) throw new Error(`Could not open Frely App: ${result.stderr}`);
    return;
  }
  const result = await d.run("cmd", ["/c", "start", "", status.path]);
  if (result.code !== 0) throw new Error(`Could not open Frely App: ${result.stderr}`);
}

export async function updateApp(deps: AppManagerDeps = {}): Promise<InstallResult> {
  const d = resolveDeps(deps);
  const status = await appInstallStatus(deps);
  if (status.managedBy === "homebrew") {
    d.log("Updating with Homebrew …");
    const result = await d.run("brew", ["upgrade", "--cask", HOMEBREW_CASK]);
    if (result.code !== 0) throw new Error(`brew upgrade failed: ${result.stderr}`);
    return { installed: true, method: "homebrew" };
  }
  if (!status.installed) throw new Error("Frely App is not installed. Run `frely app install` first.");
  return installApp(deps, { force: true });
}

export async function uninstallApp(deps: AppManagerDeps = {}): Promise<void> {
  const d = resolveDeps(deps);
  const status = await appInstallStatus(deps);
  if (!status.installed) {
    d.log("Frely App is not installed.");
    return;
  }
  if (status.managedBy === "homebrew") {
    const result = await d.run("brew", ["uninstall", "--cask", HOMEBREW_CASK]);
    if (result.code !== 0) throw new Error(`brew uninstall failed: ${result.stderr}`);
    d.log("Uninstalled with Homebrew. User data (credentials) stays with frely-cli.");
    return;
  }
  if (d.platform === "darwin" && status.path) {
    await rm(status.path, { recursive: true, force: true });
    d.log(`Removed ${status.path}. User data (credentials) stays with frely-cli.`);
    return;
  }
  if (status.path) {
    await rm(resolve(status.path, ".."), { recursive: true, force: true });
    d.log(`Removed ${status.path}. User data stays with frely-cli.`);
  }
}
