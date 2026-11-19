import { performance } from "node:perf_hooks";

/** Wall time enforces server expiry; elapsed time prevents rollback within a running process. */
export class McpLease {
  readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly elapsedDeadline: number;
  /** True once the lease ran out by time; a lease closed for another reason (reconnect, authorization change) is not "expired". */
  private expired = false;
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
    if (this.controller.signal.aborted) throw new Error("MCP session closed on this computer; retry the call.");
  }
  /** For the capability report: what this computer believes, so the web can show a lease that differs from its own record. */
  state(): { id: string; expiresAt: string; active: boolean; reason?: "expired" | "closed" } {
    const expired = this.expired || this.wall() >= this.expiresAt || this.elapsed() >= this.elapsedDeadline;
    const active = !expired && !this.controller.signal.aborted;
    return { id: this.authorizationId, expiresAt: new Date(this.expiresAt).toISOString(), active, ...(active ? {} : { reason: expired ? "expired" : "closed" }) };
  }
  close(): void { clearTimeout(this.timer); this.controller.abort(); }
  private arm(): void {
    const remaining = Math.min(this.expiresAt - this.wall(), this.elapsedDeadline - this.elapsed());
    if (remaining <= 0) { this.expired = true; this.close(); return; }
    this.timer = setTimeout(() => this.arm(), Math.min(remaining, 86_400_000));
    this.timer.unref?.();
  }
}
