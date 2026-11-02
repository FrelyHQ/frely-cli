import { claimLinkAuthorization, registerLinkKey } from "./mcp-authorization.js";

export interface LinkClaimDeps {
  register: () => Promise<void>;
  claim: () => Promise<boolean>;
  /** Whether the local lock is set; a locked computer neither registers nor claims. */
  locked: () => Promise<boolean>;
}

const defaultDeps: LinkClaimDeps = { register: registerLinkKey, claim: claimLinkAuthorization, locked: async () => (await import("./remote-lock.js")).remoteLocked() };

/**
 * The standby service waits for the owner to turn remote control on from the web (tri-state `null` to `true`): it registers this
 * computer's remote-link key, then asks the relay whether a lease was approved for it. When one was, it is saved like `frely link on`
 * would save it and `onClaimed` runs, so the service can restart in full mode. A failed round never stops the watch.
 */
export async function watchLinkClaim(options: { signal: AbortSignal; log: (message: string) => void; onClaimed: () => void; intervalMs?: number; deps?: LinkClaimDeps }): Promise<void> {
  const deps = options.deps ?? defaultDeps;
  const interval = options.intervalMs ?? 20_000;
  let registered = false;
  while (!options.signal.aborted) {
    try {
      if (await deps.locked()) { await sleep(interval, options.signal); continue; }
      if (!registered) { await deps.register(); registered = true; }
      if (await deps.claim()) { options.log("Remote control was turned on from the web; restarting to serve it."); options.onClaimed(); return; }
    } catch (error) {
      options.log(`Remote link check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(interval, options.signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  });
}
