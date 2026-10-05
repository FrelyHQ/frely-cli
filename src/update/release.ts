import type { Installation } from "./installation.js";

export interface Release { version: string; baseUrl?: string; /** Tried when `baseUrl` (the mirror) cannot supply the asset. */ fallbackBaseUrl?: string }

/** Static mirror of the GitHub release assets, reachable from mainland China. `FRELY_RELEASE_MIRROR=off` disables it; any https URL replaces it. */
export const DEFAULT_RELEASE_MIRROR = "https://dl.frely.cloud/cli";
export function releaseMirror(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = (env.FRELY_RELEASE_MIRROR ?? "").trim();
  if (value === "off") return null;
  const url = new URL(value || DEFAULT_RELEASE_MIRROR);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("FRELY_RELEASE_MIRROR must be an https URL without credentials, or off.");
  return url.toString().replace(/\/+$/u, "");
}

const GITHUB_RELEASES = "https://github.com/FrelyHQ/frely-cli/releases/download";
async function mirrorRelease(mirror: string, request: typeof fetch): Promise<Release> {
  const response = await request(`${mirror}/latest`, { headers: { "user-agent": "frely-cli" }, signal: AbortSignal.timeout(4000), redirect: "error" });
  if (!response.ok) throw new Error(`Mirror lookup failed (HTTP ${response.status}).`);
  const version = stableVersion((await response.text()).trim());
  return { version, baseUrl: `${mirror}/v${version}`, fallbackBaseUrl: `${GITHUB_RELEASES}/v${version}` };
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

/** `mirror: null` skips the mirror lookup. A standalone installation asks the mirror first and GitHub only when the mirror has no answer. */
export async function latestRelease(installation: Installation, request: typeof fetch = fetch, mirror: string | null = releaseMirror()): Promise<Release> {
  const standalone = installation.method === "standalone";
  if (standalone && mirror) {
    try { return await mirrorRelease(mirror, request); } catch { /* GitHub below */ }
  }
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
  const version = stableVersion(standalone ? String(data.tag_name).replace(/^v/u, "") : latest);
  if (!standalone && !(data.versions as Record<string, unknown> | undefined)?.[version]) throw new Error("Registry metadata does not list its latest version.");
  return { version, ...(standalone ? { baseUrl: `${GITHUB_RELEASES}/v${version}` } : {}) };
}

declare const FRELY_BUILD_TARGET: string | undefined;
export function standaloneAsset(platform = process.platform, arch = process.arch, target = typeof FRELY_BUILD_TARGET === "string" ? FRELY_BUILD_TARGET : undefined): string {
  // Compiled target includes libc, so an Alpine executable never changes distribution during an update.
  const value = target ?? `${platform === "win32" ? "windows" : platform}-${arch}`;
  if (!/^(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)(?:-musl)?|windows-(?:arm64|x64))$/u.test(value)) throw new Error("This platform has no standalone release.");
  return `frely-${value}${value.startsWith("windows") ? ".exe" : ""}`;
}
