import type { Installation } from "./installation.js";

/** Where one standalone release can be downloaded; tried in order, each verified on its own. */
export type ReleaseSource =
  | { kind: "github"; baseUrl: string }
  /** The same executable as an npm package tarball holding `package/frely[.exe]` and its `.sha256`. */
  | { kind: "npm"; registry: string; tarballUrl: string };
export interface Release { version: string; sources?: ReleaseSource[] }

const GITHUB_RELEASES = "https://github.com/FrelyHQ/frely-cli/releases/download";
/** npmmirror is the China CDN of npmjs; both carry @frelyhq/cli-<target>. */
export const NPM_REGISTRIES = ["https://registry.npmmirror.com", "https://registry.npmjs.org"];
export function platformPackage(asset = standaloneAsset()): string {
  return `@frelyhq/cli-${asset.replace(/^frely-/u, "").replace(/\.exe$/u, "")}`;
}
export function releaseSources(version: string, asset = standaloneAsset()): ReleaseSource[] {
  const name = platformPackage(asset);
  return [
    { kind: "github", baseUrl: `${GITHUB_RELEASES}/v${version}` },
    ...NPM_REGISTRIES.map((registry) => ({ kind: "npm" as const, registry, tarballUrl: `${registry}/${name}/-/${name.split("/")[1]}-${version}.tgz` })),
  ];
}

/** GitHub answered, but not with a stable published release: a real error, never a reason to try another source. */
class ReleaseRejected extends Error {}

/** Why a lookup failed, short enough for one line: timeouts and the network error code (ECONNRESET, ENOTFOUND...) are what tell the networks apart. */
function reason(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  if (error.name === "TimeoutError" || error.name === "AbortError") return "timeout";
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? `${error.message} (${code})` : error.message;
}

async function githubLatest(request: typeof fetch): Promise<string> {
  const response = await request("https://api.github.com/repos/FrelyHQ/frely-cli/releases/latest", {
    headers: { accept: "application/json", "user-agent": "frely-cli" },
    signal: AbortSignal.timeout(4000), redirect: "error",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error("metadata too large");
  const data = JSON.parse(text) as Record<string, unknown>;
  if (data.draft !== false || data.prerelease !== false) throw new ReleaseRejected("GitHub release is not a stable published release.");
  try { return stableVersion(String(data.tag_name).replace(/^v/u, "")); } catch (error) { throw new ReleaseRejected((error as Error).message); }
}

/** The npm registries carry the platform package of every release: ask one of them for its latest version. */
async function npmRegistryLatest(request: typeof fetch, registry: string, asset: string): Promise<string> {
  const response = await request(`${registry}/${platformPackage(asset)}/latest`, { headers: { accept: "application/json", "user-agent": "frely-cli" }, signal: AbortSignal.timeout(6000), redirect: "error" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error("metadata too large");
  return stableVersion((JSON.parse(text) as { version?: unknown }).version);
}

export function stableVersion(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)) throw new Error("Release source did not return a stable version.");
  return value;
}
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const core = v.split("-")[0]!.split("+")[0]!;
    return stableVersion(core).split(".").map(BigInt);
  };
  const aa = parse(a), bb = parse(b);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i]! > bb[i]! ? 1 : -1;
  return a.includes("-") === b.includes("-") ? 0 : a.includes("-") ? -1 : 1;
}

/**
 * Standalone installations query GitHub first and use the npm registries as fallbacks.
 * If every source fails, the error includes the reason from each source.
 */
export async function latestRelease(installation: Installation, request: typeof fetch = fetch): Promise<Release> {
  if (installation.method !== "standalone") {
    // npm/bun resolve from the abbreviated packument, which can lag /latest after a publish; check what they will install.
    const response = await request("https://registry.npmjs.org/frely-cli", {
      headers: { accept: "application/vnd.npm.install-v1+json", "user-agent": "frely-cli" },
      signal: AbortSignal.timeout(4000), redirect: "error",
    });
    if (!response.ok) throw new Error(`Release lookup failed (HTTP ${response.status}).`);
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error("Release metadata is too large.");
    const data = JSON.parse(text) as Record<string, unknown>;
    if (data.name !== "frely-cli") throw new Error("Release package name does not match frely-cli.");
    const version = stableVersion((data["dist-tags"] as Record<string, unknown> | undefined)?.latest);
    if (!(data.versions as Record<string, unknown> | undefined)?.[version]) throw new Error("Registry metadata does not list its latest version.");
    return { version };
  }
  const asset = standaloneAsset();
  const failures: string[] = [];
  try {
    const version = await githubLatest(request);
    return { version, sources: releaseSources(version, asset) };
  } catch (error) {
    if (error instanceof ReleaseRejected) throw error;
    failures.push(`GitHub: ${reason(error)}`);
  }
  for (const registry of NPM_REGISTRIES) {
    try {
      const version = await npmRegistryLatest(request, registry, asset);
      return { version, sources: releaseSources(version, asset) };
    } catch (error) {
      failures.push(`${new URL(registry).hostname}: ${reason(error)}`);
    }
  }
  throw new Error(`Release lookup failed on GitHub, npmmirror and npmjs. (${failures.join("; ")})`);
}

declare const FRELY_BUILD_TARGET: string | undefined;
export function standaloneAsset(platform = process.platform, arch = process.arch, target = typeof FRELY_BUILD_TARGET === "string" ? FRELY_BUILD_TARGET : undefined): string {
  // Compiled target includes libc, so an Alpine executable never changes distribution during an update.
  const value = target ?? `${platform === "win32" ? "windows" : platform}-${arch}`;
  if (!/^(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)(?:-musl)?|windows-(?:arm64|x64))$/u.test(value)) throw new Error("This platform has no standalone release.");
  return `frely-${value}${value.startsWith("windows") ? ".exe" : ""}`;
}
