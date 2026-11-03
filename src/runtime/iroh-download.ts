import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { openRelease } from "../update/fetch-release.js";

/**
 * The single-file build does not embed iroh's native module (about 20 MB of the executable). The build records which file of which upstream
 * npm package this target needs and its SHA-256; the first transfer that needs it downloads that package, takes the one `.node` file out,
 * checks it against the recorded hash and loads it from the data directory. Failure at any step means "no direct transfers", never a failed CLI.
 */
export interface IrohNativeSpec { readonly package: string; readonly version: string; readonly file: string; readonly sha256: string }
declare const FRELY_IROH_NATIVE: IrohNativeSpec | undefined;
/** Set by `build:standalone`; absent for the npm package (which resolves @number0/iroh from node_modules) and for targets without an iroh build (Intel Macs). */
export const BUILT_IROH_NATIVE: IrohNativeSpec | null = typeof FRELY_IROH_NATIVE === "object" && FRELY_IROH_NATIVE ? FRELY_IROH_NATIVE : null;

const REGISTRIES = ["https://registry.npmmirror.com", "https://registry.npmjs.org"];
const MAX_PACKAGE_BYTES = 80 * 1024 * 1024;
const MAX_MODULE_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const execute = promisify(execFile);

export interface IrohDownloadDeps {
  /** Where verified modules live; default `<XDG_DATA_HOME or ~/.local/share or %LOCALAPPDATA%>/frely/native/iroh`. */
  readonly directory?: string;
  /** The package tarball at `url`, or throws. */
  readonly download?: (url: string) => Promise<Uint8Array>;
  /** The bytes of `package/<file>` inside the tarball at `tarball`. */
  readonly extract?: (tarball: string, file: string) => Promise<Uint8Array>;
  readonly dlopen?: (path: string) => unknown;
  readonly log?: (text: string) => void;
  readonly registries?: readonly string[];
}

export function irohDirectory(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, home: string = homedir()): string {
  const root = env.XDG_DATA_HOME || (platform === "win32" ? env.LOCALAPPDATA : undefined) || join(home, ".local", "share");
  return join(root, "frely", "native", "iroh");
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function validSpec(spec: IrohNativeSpec): boolean {
  return /^iroh-[a-z0-9-]{1,40}$/u.test(spec.package) && /^\d+\.\d+\.\d+$/u.test(spec.version)
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.node$/u.test(spec.file) && /^[0-9a-f]{64}$/u.test(spec.sha256);
}

async function fetchPackage(url: string): Promise<Uint8Array> {
  const response = await openRelease(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    if (bytes > MAX_PACKAGE_BYTES) throw new Error("download exceeds its size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** tar writes the one named member to stdout: nothing from inside the archive is ever written to a path it chose. */
async function extractMember(tarball: string, file: string): Promise<Uint8Array> {
  const { stdout } = await execute("tar", ["-xzOf", tarball, `package/${file}`], { encoding: "buffer", maxBuffer: MAX_MODULE_BYTES, timeout: 60_000 });
  return stdout;
}

function loadNative(path: string): unknown {
  const holder: { exports: unknown } = { exports: {} };
  process.dlopen(holder as unknown as NodeJS.Module, path);
  return holder.exports;
}

async function cachedFileMatches(path: string, sha256: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > MAX_MODULE_BYTES) return false;
    return sha256Hex(await readFile(path)) === sha256;
  } catch { return false; }
}

/** The loaded native module, or null when it cannot be had (offline, checksum mismatch, system cannot load it). Never throws. */
export async function loadDownloadedIroh(spec: IrohNativeSpec | null, deps: IrohDownloadDeps = {}): Promise<unknown | null> {
  if (!spec || !validSpec(spec)) return null;
  const log = deps.log ?? (() => undefined);
  const dlopen = deps.dlopen ?? loadNative;
  try {
    const directory = join(deps.directory ?? irohDirectory(), `${spec.version}-${spec.package}`);
    const path = join(directory, spec.file);
    if (!await cachedFileMatches(path, spec.sha256)) {
      await rm(path, { force: true });
      log("Downloading the direct-transfer component (about 20 MB, once)…\n");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const bytes = await obtain(spec, deps);
      const staged = join(directory, `${spec.file}.${process.pid}.tmp`);
      await rm(staged, { force: true });
      await writeFile(staged, bytes, { flag: "wx", mode: 0o700 });
      await rename(staged, path);
    }
    return dlopen(path);
  } catch (error) {
    log(`Direct transfers are unavailable: ${error instanceof Error ? error.message : "the component could not be loaded"}.\n`);
    return null;
  }
}

/** Tries npmmirror, then npmjs; only bytes whose SHA-256 equals the build's recorded hash are returned. */
async function obtain(spec: IrohNativeSpec, deps: IrohDownloadDeps): Promise<Uint8Array> {
  const download = deps.download ?? fetchPackage, extract = deps.extract ?? extractMember;
  let failure = "no registry answered";
  for (const registry of deps.registries ?? REGISTRIES) {
    const work = await mkdtemp(join(deps.directory ?? irohDirectory(), ".download-"));
    try {
      const tarball = join(work, "package.tgz");
      await writeFile(tarball, await download(`${registry}/@number0/${spec.package}/-/${spec.package}-${spec.version}.tgz`), { mode: 0o600 });
      const bytes = await extract(tarball, spec.file);
      if (bytes.byteLength > MAX_MODULE_BYTES) throw new Error("module is larger than expected");
      if (sha256Hex(bytes) !== spec.sha256) throw new Error("checksum mismatch (the download was discarded)");
      return bytes;
    } catch (error) {
      failure = error instanceof Error ? error.message : failure;
    } finally { await rm(work, { recursive: true, force: true }).catch(() => undefined); }
  }
  throw new Error(failure);
}
