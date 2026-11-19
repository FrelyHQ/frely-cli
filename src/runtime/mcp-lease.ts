import { performance } from "node:perf_hooks";

/** Wall time enforces server expiry; elapsed time prevents rollback within a running process. */
export class McpLease {
  readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly elapsedDeadline: number;
  /** True once the lease ran out by time; a lease closed for another reason (reconnect, authorization change) is not "expired". */
  private expired = false;
  /** Why a still-valid lease was closed, when the reason is one the owner can act on. */
  private closedFor: "login_expired" | undefined;
  /** The server refused this computer's login. Remote control does not depend on it (device key and MCP authorization do), so this is only reported. */
  loginExpired = false;
  constructor(readonly authorizationId: string, readonly expiresAt: number,
    private readonly wall = () => Date.now(), private readonly elapsed = () => performance.now()) {
    if (!Number.isFinite(expiresAt)) throw new Error("MCP authorization expiry is invalid.");
    this.elapsedDeadline = this.elapsed() + Math.max(0, expiresAt - this.wall());
    this.arm();
  }
  assert(): void {
    if (this.expired || this.wall() >= this.expiresAt || this.elapsed() >= this.elapsedDeadline) {
      this.expired = true;
      this.close();
      throw new Error("MCP_AUTHORIZATION_EXPIRED: remote execution is disabled; run frely link on to renew.");
    }
    // Closed while still valid: this session ended (the connection or authorization changed), the authorization itself did not.
    if (this.controller.signal.aborted) {
      if (this.closedFor === "login_expired") throw new Error("Frely login expired on this computer, so it stopped running remote commands. Run `frely login` on it; remote control resumes by itself within a minute.");
      throw new Error("MCP session closed on this computer; retry the call.");
    }
  }
  /** For the capability report: what this computer believes, so the web can show a lease that differs from its own record. */
  state(): { id: string; expiresAt: string; active: boolean; reason?: "expired" | "closed" | "login_expired"; loginExpired?: true } {
    const expired = this.expired || this.wall() >= this.expiresAt || this.elapsed() >= this.elapsedDeadline;
    const active = !expired && !this.controller.signal.aborted;
    return { id: this.authorizationId, expiresAt: new Date(this.expiresAt).toISOString(), active, ...(active ? {} : { reason: expired ? "expired" : this.closedFor ?? "closed" }), ...(active && this.loginExpired ? { loginExpired: true as const } : {}) };
  }
  /** `reason` is kept only for the first close: it says why this session ended. */
  close(reason?: "login_expired"): void {
    if (!this.controller.signal.aborted) this.closedFor = reason;
    clearTimeout(this.timer); this.controller.abort();
  }
  private arm(): void {
    const remaining = Math.min(this.expiresAt - this.wall(), this.elapsedDeadline - this.elapsed());
    if (remaining <= 0) { this.expired = true; this.close(); return; }
    this.timer = setTimeout(() => this.arm(), Math.min(remaining, 86_400_000));
    this.timer.unref?.();
  }
}
