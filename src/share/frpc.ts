import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * frpc, the client of Frely's frps relay, is downloaded on first use to the user's data directory and run by `frely share`. The version is
 * pinned and every platform's archive has its SHA-256 here (from the release's frp_sha256_checksums.txt), so a changed download is refused.
 */
export const FRPC_VERSION = "0.71.1";

export interface FrpcAsset { readonly file: string; readonly sha256: string; readonly binary: string }

const ASSETS: Readonly<Record<string, FrpcAsset>> = Object.freeze({
  "darwin-arm64": { file: `frp_${FRPC_VERSION}_darwin_arm64.tar.gz`, sha256: "d15d0324b99e14619c9aa46e37f6db588c06a09be4bc6f7948890b6b61077842", binary: "frpc" },
  "darwin-x64": { file: `frp_${FRPC_VERSION}_darwin_amd64.tar.gz`, sha256: "8acb59b6fb998cc8d209d1373d90bf70fa5ec3efeb4dfbc7bda6ce3abd78cb45", binary: "frpc" },
  "linux-x64": { file: `frp_${FRPC_VERSION}_linux_amd64.tar.gz`, sha256: "1d9875210972a5d1a62b2dc4c48df45ab0af05d3ca1b5e494a014428259df803", binary: "frpc" },
  "linux-arm64": { file: `frp_${FRPC_VERSION}_linux_arm64.tar.gz`, sha256: "8edf590b0c396fa42f9c147121a76af83cfc2002b08f5aef0ea1008c43482019", binary: "frpc" },
  "win32-x64": { file: `frp_${FRPC_VERSION}_windows_amd64.zip`, sha256: "b90074b2b6a1d792a7a40f085ac6d276bcab2d1bc60201f8a86ca53ce65ce821", binary: "frpc.exe" },
  "win32-arm64": { file: `frp_${FRPC_VERSION}_windows_arm64.zip`, sha256: "6c25afb4058f7708937db7064836fec593e941de0e6c2c255982335a9b16d370", binary: "frpc.exe" },
});

const RELEASE_BASE = `https://github.com/fatedier/frp/releases/download/v${FRPC_VERSION}`;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const execute = promisify(execFile);

export function frpcAsset(platform: string = process.platform, arch: string = process.arch): FrpcAsset {
  const asset = ASSETS[`${platform}-${arch}`];
  if (!asset) throw new Error(`frely share has no frpc build for ${platform}-${arch}.`);
  return asset;
}

/** `~/.local/share/frely/bin` (`XDG_DATA_HOME` first; `%LOCALAPPDATA%` on Windows). */
export function frpcDirectory(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, home: string = homedir()): string {
  const root = env.XDG_DATA_HOME || (platform === "win32" ? env.LOCALAPPDATA : undefined) || join(home, ".local", "share");
  return join(root, "frely", "bin");
}

export function frpcPath(directory: string, asset: FrpcAsset): string {
  return join(directory, `frpc-${FRPC_VERSION}${asset.binary.endsWith(".exe") ? ".exe" : ""}`);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface FrpcDeps {
  readonly platform?: string;
  readonly arch?: string;
  /** Replaces the pinned table entry (tests only). */
  readonly asset?: FrpcAsset;
  readonly directory?: string;
  /** Base URL that serves the release files by name; `FRELY_FRPC_BASE_URL` points it at a mirror (the checksum still applies). */
  readonly baseUrl?: string;
  readonly download?: (url: string) => Promise<Uint8Array>;
  /** Unpacks a .tar.gz or .zip archive into a directory. */
  readonly extract?: (archive: string, into: string) => Promise<void>;
  readonly log?: (text: string) => void;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Downloading frpc failed: HTTP ${response.status}.`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_ARCHIVE_BYTES) throw new Error("The frpc download is larger than expected.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("The frpc download is larger than expected.");
  return bytes;
}

/** bsdtar (macOS, Windows 10+) and GNU tar (zip aside) read both formats; the archive is verified before it is unpacked. */
async function extractWithTar(archive: string, into: string): Promise<void> {
  await execute("tar", ["-xf", archive, "-C", into], { timeout: 60_000 });
}

async function findFile(directory: string, name: string): Promise<string | null> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { const found = await findFile(path, name); if (found) return found; }
    else if (entry.name === name) return path;
  }
  return null;
}

/** The path of the pinned frpc, downloaded and verified first when it is not there yet. */
export async function ensureFrpc(deps: FrpcDeps = {}): Promise<string> {
  const asset = deps.asset ?? frpcAsset(deps.platform, deps.arch);
  const directory = deps.directory ?? frpcDirectory();
  const target = frpcPath(directory, asset);
  try {
    const { access } = await import("node:fs/promises");
    await access(target);
    return target;
  } catch { /* not downloaded yet */ }
  const log = deps.log ?? (() => undefined);
  const base = (deps.baseUrl ?? process.env.FRELY_FRPC_BASE_URL ?? RELEASE_BASE).replace(/\/+$/u, "");
  log(`Downloading frpc ${FRPC_VERSION} (${asset.file}) once...\n`);
  const bytes = await (deps.download ?? fetchBytes)(`${base}/${asset.file}`);
  if (sha256Hex(bytes) !== asset.sha256) throw new Error("The downloaded frpc does not match its pinned checksum; it was discarded.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(tmpdir(), "frely-frpc-"));
  try {
    const archive = join(work, asset.file);
    await writeFile(archive, bytes, { mode: 0o600 });
    const unpacked = join(work, "out");
    await mkdir(unpacked);
    await (deps.extract ?? extractWithTar)(archive, unpacked);
    const binary = await findFile(unpacked, asset.binary);
    if (!binary) throw new Error("The frpc archive has no frpc binary.");
    const staged = `${target}.${process.pid}.tmp`;
    await copyFile(binary, staged);
    await chmod(staged, 0o755);
    await rename(staged, target);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
  return target;
}
