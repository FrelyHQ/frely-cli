import type { Installation } from "./installation.js";

export interface Release { version: string; baseUrl?: string }
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

export async function latestRelease(installation: Installation, request: typeof fetch = fetch): Promise<Release> {
  const standalone = installation.method === "standalone";
  const response = await request(standalone
    ? "https://api.github.com/repos/FrelyHQ/frely-cli/releases/latest"
    : "https://registry.npmjs.org/frely-cli/latest", {
    headers: { accept: "application/json", "user-agent": "frely-cli" },
    signal: AbortSignal.timeout(4000), redirect: "error",
  });
  if (!response.ok) throw new Error(`Release lookup failed (HTTP ${response.status}).`);
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error("Release metadata is too large.");
  const data = JSON.parse(text) as Record<string, unknown>;
  if (standalone && (data.draft !== false || data.prerelease !== false)) throw new Error("GitHub release is not a stable published release.");
  const version = stableVersion(standalone ? String(data.tag_name).replace(/^v/u, "") : data.version);
  if (!standalone && data.name !== "frely-cli") throw new Error("Release package name does not match frely-cli.");
  return { version, ...(standalone ? { baseUrl: `https://github.com/FrelyHQ/frely-cli/releases/download/v${version}` } : {}) };
}

declare const FRELY_BUILD_TARGET: string | undefined;
export function standaloneAsset(platform = process.platform, arch = process.arch, target = typeof FRELY_BUILD_TARGET === "string" ? FRELY_BUILD_TARGET : undefined): string {
  // Compiled target includes libc, so an Alpine executable never changes distribution during an upgrade.
  const value = target ?? `${platform === "win32" ? "windows" : platform}-${arch}`;
  if (!/^(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)(?:-musl)?|windows-(?:arm64|x64))$/u.test(value)) throw new Error("This platform has no standalone release.");
  return `frely-${value}${value.startsWith("windows") ? ".exe" : ""}`;
}
