import { openRelease } from "./fetch-release.js";
import type { ReleaseSource } from "./release.js";

/** Bytes read from each candidate, and the budget for the whole probe. */
export const PROBE_BYTES = 2_000_000;
export const PROBE_TIMEOUT_MS = 4000;

/** Bytes per second over the first PROBE_BYTES of `url`, or 0 when nothing arrived (error, timeout, not allowed). */
async function probeSpeed(url: string, request: typeof fetch, now: () => number): Promise<number> {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS), started = now();
  let bytes = 0;
  try {
    const response = await openRelease(url, { signal, request, headers: { range: `bytes=0-${PROBE_BYTES - 1}` } });
    if (!response.ok || !response.body) { await response.body?.cancel(); return 0; }
    const reader = response.body.getReader();
    try {
      while (bytes < PROBE_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
    } finally { await reader.cancel().catch(() => {}); }
  } catch { /* timeout or connection error: keep what arrived */ }
  const seconds = Math.max((now() - started) / 1000, 0.001);
  return bytes > 0 ? bytes / seconds : 0;
}

/**
 * Orders release sources by measured speed so a slow or unreachable GitHub does not hold up the download. GitHub and npmmirror are
 * probed in parallel; the faster goes first, one that delivered nothing counts as failed, and when both fail the given order stands.
 * npmjs is never probed and stays last as the fallback.
 */
export async function rankSources(sources: readonly ReleaseSource[], asset: string, request: typeof fetch = fetch, now: () => number = performance.now.bind(performance)): Promise<ReleaseSource[]> {
  const urlOf = (source: ReleaseSource) => source.kind === "github" ? `${source.baseUrl}/${asset}` : source.tarballUrl;
  const probed = (source: ReleaseSource) => source.kind === "github" || new URL(source.registry).hostname === "registry.npmmirror.com";
  const candidates = sources.filter(probed);
  const speeds = await Promise.all(candidates.map((source) => probeSpeed(urlOf(source), request, now)));
  const ranked = candidates.map((source, index) => ({ source, speed: speeds[index]!, index }))
    .sort((a, b) => b.speed - a.speed || a.index - b.index).map((entry) => entry.source);
  return [...ranked, ...sources.filter((source) => !probed(source))];
}
