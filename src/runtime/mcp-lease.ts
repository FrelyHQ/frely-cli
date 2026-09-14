import { performance } from "node:perf_hooks";

/** Wall time enforces server expiry; elapsed time prevents rollback within a running process. */
export class McpLease {
  readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly elapsedDeadline: number;
  constructor(readonly authorizationId: string, readonly expiresAt: number,
    private readonly wall = () => Date.now(), private readonly elapsed = () => performance.now()) {
    if (!Number.isFinite(expiresAt)) throw new Error("MCP authorization expiry is invalid.");
    this.elapsedDeadline = this.elapsed() + Math.max(0, expiresAt - this.wall());
    this.arm();
  }
  assert(): void {
    if (this.controller.signal.aborted || this.wall() >= this.expiresAt || this.elapsed() >= this.elapsedDeadline) {
      this.close();
      throw new Error("MCP_AUTHORIZATION_EXPIRED: remote execution is disabled; run frely mcp renew.");
    }
  }
  close(): void { clearTimeout(this.timer); this.controller.abort(); }
  private arm(): void {
    const remaining = Math.min(this.expiresAt - this.wall(), this.elapsedDeadline - this.elapsed());
    if (remaining <= 0) { this.close(); return; }
    this.timer = setTimeout(() => this.arm(), Math.min(remaining, 86_400_000));
    this.timer.unref?.();
  }
}
