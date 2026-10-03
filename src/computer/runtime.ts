import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { OCU_VERSION, ocuBinaryPath } from "./ocu.js";

const execFile = promisify(execFileCallback);

/**
 * The pinned open-computer-use release (plan computer-use D7): the npm tarball bundles every platform's
 * binary, and its sha512 integrity is fixed here, so a changed or tampered download is refused.
 * Bumping OCU_VERSION means updating both constants from `npm view open-computer-use@<version> dist`.
 */
export const OCU_TARBALL_URL = `https://registry.npmjs.org/open-computer-use/-/open-computer-use-${OCU_VERSION}.tgz`;
export const OCU_TARBALL_INTEGRITY = "sha512-pGNfWBBefl5qzQMo6rkC/e28sOfeczTQ0hEKkYn2sXwti38uz+fC4Y0oBdtnNACemsNVR06Dzp6SozJjkpkbSg==";
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;

export class OcuRuntimeError extends Error {
  constructor(readonly code: "unsupported_platform" | "download_failed" | "integrity_mismatch" | "extract_failed", message: string) {
    super(message);
    this.name = "OcuRuntimeError";
  }
}

export interface OcuRuntimeOptions {
  fetchImpl?: typeof fetch;
  url?: string;
  integrity?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Install target; defaults to the directory the toolset launches the binary from. */
  binaryPath?: string;
}

/** Path of the part of the tarball to extract for this platform, and what it becomes in the install directory. */
function layout(platform: NodeJS.Platform, arch: string): { member: string; kind: "app" | "binary"; source: string } {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : undefined;
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return { member: "package/dist/Open Computer Use.app", kind: "app", source: "Open Computer Use.app" };
  if (platform === "linux" && cpu) return { member: `package/dist/linux/${cpu}/open-computer-use`, kind: "binary", source: `dist/linux/${cpu}/open-computer-use` };
  if (platform === "win32" && cpu) return { member: `package/dist/windows/${cpu}/open-computer-use.exe`, kind: "binary", source: `dist/windows/${cpu}/open-computer-use.exe` };
  throw new OcuRuntimeError("unsupported_platform", `Computer use is not available for ${platform}-${arch}.`);
}

/** Download the pinned tarball, verify its integrity, and install this platform's runtime. Idempotent. */
export async function installOcuRuntime(options: OcuRuntimeOptions = {}): Promise<string> {
  const target = options.binaryPath ?? ocuBinaryPath();
  const plan = layout(options.platform ?? process.platform, options.arch ?? process.arch);
  const url = options.url ?? OCU_TARBALL_URL;
  if (!url.startsWith("https://") && !(options.url && options.fetchImpl)) throw new OcuRuntimeError("download_failed", "The runtime must be downloaded over HTTPS.");
  const response = await (options.fetchImpl ?? fetch)(url).catch((error: unknown) => {
    throw new OcuRuntimeError("download_failed", `Could not download the computer-use runtime: ${error instanceof Error ? error.message : "network error"}`);
  });
  if (!response.ok) throw new OcuRuntimeError("download_failed", `Could not download the computer-use runtime (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_TARBALL_BYTES) throw new OcuRuntimeError("download_failed", "The runtime download is larger than expected.");
  const expected = options.integrity ?? OCU_TARBALL_INTEGRITY;
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== expected) {
    throw new OcuRuntimeError("integrity_mismatch", "The downloaded runtime does not match the pinned checksum and was discarded.");
  }
  const installDir = plan.kind === "app" ? dirname(dirname(dirname(dirname(target)))) : dirname(target);
  await mkdir(dirname(installDir), { recursive: true });
  const stage = await mkdtemp(join(dirname(installDir), ".computer-install-"));
  try {
    const archive = join(stage, "runtime.tgz");
    await writeFile(archive, bytes);
    try {
      await execFile("tar", ["-xzf", archive, "-C", stage, plan.member], { timeout: 120_000 });
    } catch (error) {
      throw new OcuRuntimeError("extract_failed", `Could not unpack the computer-use runtime: ${error instanceof Error ? error.message : "tar failed"}`);
    }
    const extracted = join(stage, "package", "dist", ...(plan.kind === "app" ? [plan.source] : plan.source.split("/").slice(1)));
    const staged = join(stage, "ready");
    await mkdir(staged, { recursive: true });
    if (plan.kind === "app") await cp(extracted, join(staged, plan.source), { recursive: true });
    else {
      await cp(extracted, join(staged, plan.source.split("/").pop()!));
      if (process.platform !== "win32") await chmod(join(staged, plan.source.split("/").pop()!), 0o755);
    }
    await rm(installDir, { recursive: true, force: true });
    await mkdir(dirname(installDir), { recursive: true });
    await rename(staged, installDir);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return target;
}
