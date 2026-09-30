/**
 * Reads `~/.config/frely/app.json` (written by the Frely App) and verifies the
 * referenced Runtime Capsule well enough to launch its agent host entry.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const APP_INSTALL_SCHEMA_VERSION = 1;
export const CAPSULE_MANIFEST_NAME = "capsule-manifest.json";

export type AppInstall = {
  schemaVersion: number;
  appVersion: string;
  capsulePath: string;
  protocolVersion: number;
};

export type CapsuleManifest = {
  schemaVersion: number;
  capsuleKind: string;
  sourceCommit: string;
  target: { id: string; platform: string; architecture: string };
  versions: { piNode: string; protocol: string };
  runtime: { executable: string };
  application: { entrypoint: string; agentHostEntrypoint?: string; launch?: string[] };
};

export class AppInstallError extends Error {
  constructor(readonly code: "app_not_installed" | "app_manifest_invalid" | "capsule_invalid" | "capsule_platform_mismatch" | "capsule_integrity_failed") {
    super(code);
    this.name = "AppInstallError";
  }
}

export function appInstallPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "app.json");
}

export async function readAppInstall(path?: string, env: NodeJS.ProcessEnv = process.env): Promise<AppInstall> {
  let raw: string;
  try {
    raw = await readFile(path ?? appInstallPath(env), "utf8");
  } catch {
    throw new AppInstallError("app_not_installed");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AppInstallError("app_manifest_invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== APP_INSTALL_SCHEMA_VERSION) throw new AppInstallError("app_manifest_invalid");
  if (typeof record.appVersion !== "string" || typeof record.capsulePath !== "string" || !Number.isSafeInteger(record.protocolVersion)) {
    throw new AppInstallError("app_manifest_invalid");
  }
  return { schemaVersion: APP_INSTALL_SCHEMA_VERSION, appVersion: record.appVersion, capsulePath: record.capsulePath, protocolVersion: record.protocolVersion as number };
}

export type CapsuleFacts = {
  manifest: CapsuleManifest;
  nodeExecutable: string;
  agentHostEntrypoint: string;
  entrypointIsAgentHost: boolean;
};

/** Structural capsule verification: manifest shape, platform match, entrypoints. */
export async function verifyCapsule(appInstall: AppInstall): Promise<CapsuleFacts> {
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(join(appInstall.capsulePath, CAPSULE_MANIFEST_NAME), "utf8");
  } catch {
    throw new AppInstallError("capsule_invalid");
  }
  let manifest: CapsuleManifest;
  try {
    manifest = JSON.parse(manifestRaw) as CapsuleManifest;
  } catch {
    throw new AppInstallError("capsule_invalid");
  }
  if (manifest.schemaVersion !== 2 || manifest.capsuleKind !== "pi-node-runtime") throw new AppInstallError("capsule_invalid");
  if (typeof manifest.sourceCommit !== "string" || !/^[0-9a-f]{40}$/u.test(manifest.sourceCommit)) throw new AppInstallError("capsule_invalid");
  const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  if (manifest.target.platform !== platform) throw new AppInstallError("capsule_platform_mismatch");

  const nodeExecutable = join(appInstall.capsulePath, manifest.runtime.executable);
  if (!(await isFile(nodeExecutable))) throw new AppInstallError("capsule_invalid");

  const agentHostEntrypoint = manifest.application.agentHostEntrypoint ?? manifest.application.entrypoint;
  const entrypointPath = join(appInstall.capsulePath, agentHostEntrypoint);
  if (!(await isFile(entrypointPath))) throw new AppInstallError("capsule_invalid");
  return {
    manifest,
    nodeExecutable,
    agentHostEntrypoint: entrypointPath,
    entrypointIsAgentHost: manifest.application.agentHostEntrypoint !== undefined,
  };
}

/**
 * Full integrity walk (sha256 of every payload file against the manifest).
 * Expensive; run once per supervisor lifetime, not on every host restart.
 */
export async function verifyCapsuleIntegrity(appInstall: AppInstall): Promise<void> {
  const manifest = JSON.parse(await readFile(join(appInstall.capsulePath, CAPSULE_MANIFEST_NAME), "utf8")) as CapsuleManifest & {
    integrity: { algorithm: "sha256"; manifestExcludedPath: string; payloadFileCount: number; payloadSize: number; files: Array<{ path: string; sha256?: string; symlinkTarget?: string; bytes?: number }> };
  };
  const integrity = manifest.integrity;
  if (!integrity || integrity.algorithm !== "sha256") throw new AppInstallError("capsule_invalid");
  const seen = new Set<string>();
  let totalSize = 0;
  let count = 0;
  for (const entry of integrity.files) {
    if (typeof entry.path !== "string" || entry.path.startsWith("/") || entry.path.includes("..")) throw new AppInstallError("capsule_invalid");
    if (seen.has(entry.path)) throw new AppInstallError("capsule_invalid");
    seen.add(entry.path);
    const full = resolve(appInstall.capsulePath, entry.path);
    if (relative(appInstall.capsulePath, full).startsWith("..")) throw new AppInstallError("capsule_invalid");
    const info = await lstat(full).catch(() => null);
    if (!info) throw new AppInstallError("capsule_integrity_failed");
    if (entry.symlinkTarget !== undefined) {
      if (!info.isSymbolicLink()) throw new AppInstallError("capsule_integrity_failed");
      const target = await readlink(full);
      if (target !== entry.symlinkTarget) throw new AppInstallError("capsule_integrity_failed");
      continue;
    }
    if (!info.isFile()) throw new AppInstallError("capsule_integrity_failed");
    const hash = createHash("sha256");
    const content = await readFile(full);
    hash.update(content);
    if (hash.digest("hex") !== entry.sha256) throw new AppInstallError("capsule_integrity_failed");
    if (typeof entry.bytes === "number" && entry.bytes !== content.byteLength) throw new AppInstallError("capsule_integrity_failed");
    totalSize += content.byteLength;
    count += 1;
  }
  if (count !== integrity.payloadFileCount || totalSize !== integrity.payloadSize) throw new AppInstallError("capsule_integrity_failed");
}

async function isFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info !== null && info.isFile();
}
