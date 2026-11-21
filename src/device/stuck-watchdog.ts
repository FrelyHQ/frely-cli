import type { DiagnosticLog } from "../runtime/diagnostics.js";
import { diagnostic } from "../runtime/diagnostics.js";

/** A managed service that stays disconnected this long, while the relay answers, is stuck: it exits so the supervisor starts it fresh. */
export const STUCK_DISCONNECT_MS = 5 * 60_000;
const CHECK_INTERVAL_MS = 30_000;
const REACHABLE_TIMEOUT_MS = 5_000;
/** Exit code of a self-requested restart. Never 77 (SERVICE_AUTH_REQUIRED): the supervisor must start the service again. */
export const SERVICE_STUCK_EXIT_CODE = 75;

export interface StuckWatchdogOptions {
  /** True while a command, a managed process or an unsent result is in flight: a stuck check never ends running work. */
  busy: () => boolean;
  /** True when the relay answers at all (any HTTP status). When the network itself is down a restart would not help. */
  reachable: () => Promise<boolean>;
  onStuck: () => void;
  signal: AbortSignal;
  log?: DiagnosticLog;
  now?: () => number;
  thresholdMs?: number;
  intervalMs?: number;
}

export interface StuckWatchdog {
  connected(): void;
  disconnected(): void;
  /** One check; the timer calls it. Returns true when it asked for a restart. */
  check(): Promise<boolean>;
  stop(): void;
}

export function startStuckWatchdog(options: StuckWatchdogOptions): StuckWatchdog {
  const now = options.now ?? Date.now;
  const threshold = options.thresholdMs ?? STUCK_DISCONNECT_MS;
  const log = options.log ?? (() => undefined);
  let since: number | undefined = now();
  let fired = false;
  const check = async (): Promise<boolean> => {
    if (fired || options.signal.aborted || since === undefined || now() - since < threshold) return false;
    if (options.busy()) return false;
    const stuckMs = now() - since;
    if (!await options.reachable().catch(() => false)) return false;
    // The connection may have returned while the relay was probed.
    if (since === undefined || options.busy()) return false;
    fired = true;
    diagnostic(log, "relay.stuck_restart", { durationMs: stuckMs });
    options.onStuck();
    return true;
  };
  const timer = setInterval(() => { void check(); }, options.intervalMs ?? CHECK_INTERVAL_MS);
  timer.unref?.();
  return {
    connected: () => { since = undefined; },
    disconnected: () => { since ??= now(); },
    check,
    stop: () => clearInterval(timer),
  };
}

/** Any HTTP answer from the relay origin counts as reachable. */
export async function relayReachable(relayUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    await fetchImpl(new URL("/", relayUrl), { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(REACHABLE_TIMEOUT_MS) });
    return true;
  } catch { return false; }
}
