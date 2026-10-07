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

/** GitHub cannot be reached (mainland China and similar networks): ask the npm registries for the platform package's latest version. */
async function npmLatest(request: typeof fetch, asset: string): Promise<string> {
  for (const registry of NPM_REGISTRIES) {
    try {
      const response = await request(`${registry}/${platformPackage(asset)}/latest`, { headers: { accept: "application/json", "user-agent": "frely-cli" }, signal: AbortSignal.timeout(6000), redirect: "error" });
      if (!response.ok) continue;
      const text = await response.text();
      if (text.length > 1024 * 1024) continue;
      return stableVersion((JSON.parse(text) as { version?: unknown }).version);
    } catch { /* next registry */ }
  }
  throw new Error("Release lookup failed on GitHub, npmmirror and npmjs.");
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

/** A standalone installation asks GitHub first and the npm registries (npmmirror, then npmjs) when GitHub cannot answer. */
export async function latestRelease(installation: Installation, request: typeof fetch = fetch): Promise<Release> {
  const standalone = installation.method === "standalone";
  let version: string;
  try {
    const response = await request(standalone
      ? "https://api.github.com/repos/FrelyHQ/frely-cli/releases/latest"
      // npm/bun resolve from the abbreviated packument, which can lag /latest after a publish; check what they will install.
      : "https://registry.npmjs.org/frely-cli", {
      headers: { accept: standalone ? "application/json" : "application/vnd.npm.install-v1+json", "user-agent": "frely-cli" },
      signal: AbortSignal.timeout(4000), redirect: "error",
    });
    if (!response.ok) throw new Error(`Release lookup failed (HTTP ${response.status}).`);
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error("Release metadata is too large.");
    const data = JSON.parse(text) as Record<string, unknown>;
    if (standalone && (data.draft !== false || data.prerelease !== false)) throw new Error("GitHub release is not a stable published release.");
    if (!standalone && data.name !== "frely-cli") throw new Error("Release package name does not match frely-cli.");
    const latest = standalone ? undefined : (data["dist-tags"] as Record<string, unknown> | undefined)?.latest;
    version = stableVersion(standalone ? String(data.tag_name).replace(/^v/u, "") : latest);
    if (!standalone && !(data.versions as Record<string, unknown> | undefined)?.[version]) throw new Error("Registry metadata does not list its latest version.");
  } catch (error) {
    // A GitHub answer that is invalid (draft, bad tag) is a real error, not a network problem.
    if (!standalone || (error instanceof Error && /stable/u.test(error.message))) throw error;
    version = await npmLatest(request, standaloneAsset());
  }
  return { version, ...(standalone ? { sources: releaseSources(version) } : {}) };
}

declare const FRELY_BUILD_TARGET: string | undefined;
export function standaloneAsset(platform = process.platform, arch = process.arch, target = typeof FRELY_BUILD_TARGET === "string" ? FRELY_BUILD_TARGET : undefined): string {
  // Compiled target includes libc, so an Alpine executable never changes distribution during an update.
  const value = target ?? `${platform === "win32" ? "windows" : platform}-${arch}`;
  if (!/^(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)(?:-musl)?|windows-(?:arm64|x64))$/u.test(value)) throw new Error("This platform has no standalone release.");
  return `frely-${value}${value.startsWith("windows") ? ".exe" : ""}`;
}
