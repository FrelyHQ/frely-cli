/**
 * Agent host supervisor: spawns the capsule agent host with a duplex fd3
 * protocol pipe, performs the frely.agent-host.v1 handshake, forwards tool
 * requests, and owns idle shutdown / crash handling.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { diagnostic, type DiagnosticLog } from "../runtime/diagnostics.js";
import { VERSION } from "../version.js";
import {
  AGENT_HOST_CONNECTION_KEY_ENV,
  AGENT_HOST_PROTOCOL_VERSION,
  AgentHostProtocolError,
  decodeAgentHostFrame,
  decodeTaskEvent,
  decodeToolParams,
  encodeAgentHostFrame,
  isToolMethod,
  newConnectionKey,
  type AgentHostTaskEvent,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./protocol.js";
import { type CapsuleFacts, type AppInstall } from "./app-install.js";

export const AGENT_HOST_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const AGENT_HOST_HANDSHAKE_TIMEOUT_MS = 15_000;

export type AgentHostStatus = "stopped" | "starting" | "running" | "failed";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string; timer: NodeJS.Timeout };

export type HostRequest = { id: JsonRpcId; method: string; params: unknown };

/** JSON-RPC peer over the fd3 pipe of a spawned agent host. */
export class AgentHostConnection {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private writeClosed = false;
  private closeListeners: Array<(error?: Error) => void> = [];

  private constructor(
    readonly process: ChildProcess,
    private readonly duplex: NodeJS.ReadWriteStream,
    private readonly log?: DiagnosticLog,
  ) {
    const lines = createInterface({ input: duplex, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    // readline re-emits input stream errors (e.g. ECONNRESET during host teardown) as its own
    // "error" event; without a listener that becomes an uncaughtException.
    lines.on("error", (error) => this.close(error));
    this.duplex.on("error", (error) => this.close(error));
    this.duplex.on("close", () => this.close());
    this.process.once("exit", (code, signal) => this.close(new Error(`Agent host exited (code=${code} signal=${signal}).`)));
  }

  static async start(facts: CapsuleFacts, options: { log?: DiagnosticLog | undefined; onEvent?: (taskId: string, event: AgentHostTaskEvent) => void; onToolRequest?: (request: HostRequest, args: Record<string, unknown>, taskId: string) => Promise<unknown> }): Promise<AgentHostConnection> {
    const key = newConnectionKey();
    const child = spawn(facts.executable, facts.agentHostArguments, {
      stdio: ["ignore", "ignore", "ignore", "pipe"],
      env: { ...process.env, [AGENT_HOST_CONNECTION_KEY_ENV]: key },
      windowsHide: true,
    });
    const duplex = child.stdio[3] as NodeJS.ReadWriteStream | null;
    if (!duplex) {
      child.kill();
      throw new AgentHostProtocolError("unexpected_frame");
    }
    const connection = new AgentHostConnection(child, duplex, options.log);
    try {
      await connection.handshake(key);
    } catch (error) {
      connection.kill();
      throw error;
    }
    connection.onEvent = options.onEvent;
    connection.onToolRequest = options.onToolRequest ?? null;
    return connection;
  }

  private onEvent?: ((taskId: string, event: AgentHostTaskEvent) => void) | undefined;
  private onToolRequest?: ((request: HostRequest, args: Record<string, unknown>, taskId: string) => Promise<unknown>) | null;

  private async handshake(connectionKey: string): Promise<void> {
    const result = (await this.request("initialize", { protocolVersion: AGENT_HOST_PROTOCOL_VERSION, cliVersion: cliVersion(), connectionKey, capabilities: ["tasks", "tools"] }, AGENT_HOST_HANDSHAKE_TIMEOUT_MS)) as Record<string, unknown>;
    if (!result || result.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION) {
      throw new AgentHostProtocolError("handshake_rejected");
    }
    this.notify("initialized", {});
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 120_000): Promise<unknown> {
    if (this.writeClosed) return Promise.reject(new Error("Agent host connection is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent host request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, method, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.writeClosed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id: JsonRpcId, result: unknown): void {
    if (this.writeClosed) return;
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    if (this.writeClosed) return;
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async shutdown(graceMs = 5_000): Promise<void> {
    try {
      await this.request("host.shutdown", {}, graceMs).catch(() => undefined);
    } finally {
      this.kill();
    }
  }

  kill(): void {
    this.writeClosed = true;
    this.process.kill();
  }

  onClose(listener: (error?: Error) => void): void {
    this.closeListeners.push(listener);
  }

  private write(message: JsonRpcMessage): void {
    this.duplex.write(encodeAgentHostFrame(message), (error) => {
      if (error) this.close(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = decodeAgentHostFrame(line);
    } catch (error) {
      diagnostic(this.log, "agent.host.frame_invalid", {}, error);
      this.close(error instanceof Error ? error : new Error("invalid frame"));
      return;
    }
    if ("method" in message) {
      if ("id" in message && message.id !== undefined) void this.handleHostRequest(message as { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: Record<string, unknown> });
      else this.handleNotification(message.method, message.params);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ("error" in message && message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
    else pending.resolve((message as { result?: unknown }).result);
  }

  private handleNotification(method: string, params: Record<string, unknown> | undefined): void {
    if (method !== "task.event") {
      diagnostic(this.log, "agent.host.unexpected_notification", { method });
      return;
    }
    try {
      const { taskId, event } = decodeTaskEvent(params);
      this.onEvent?.(taskId, event);
    } catch (error) {
      diagnostic(this.log, "agent.host.event_invalid", {}, error);
    }
  }

  private async handleHostRequest(request: { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: Record<string, unknown> }): Promise<void> {
    if (!isToolMethod(request.method)) {
      this.respondError(request.id, -32601, `Unknown method: ${request.method}`);
      return;
    }
    if (!this.onToolRequest) {
      this.respondError(request.id, -32000, "No tool executor attached.");
      return;
    }
    try {
      const { taskId, args } = decodeToolParams(request.method, request.params);
      const result = await this.onToolRequest({ id: request.id, method: request.method, params: request.params }, args, taskId);
      this.respond(request.id, { ok: true, result });
    } catch (error) {
      this.respond(request.id, { ok: false, error: { code: "tool_failed", message: error instanceof Error ? error.message.slice(0, 512) : "tool failed" } });
    }
  }

  private closed = false;
  private close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.writeClosed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error("Agent host connection closed."));
    }
    this.pending.clear();
    for (const listener of [...this.closeListeners]) listener(error);
    this.closeListeners = [];
  }
}

export function cliVersion(): string {
  return process.env.FRELY_CLI_VERSION_OVERRIDE ?? VERSION;
}

/** Owns the single agent host process across tasks. */
export class AgentHostSupervisor {
  private connection: AgentHostConnection | null = null;
  private starting: Promise<AgentHostConnection> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private state: AgentHostStatus = "stopped";
  private lastError: string | null = null;
  private integrityVerified = false;
  private lastActivityAt = 0;

  constructor(
    private readonly deps: {
      resolveFacts: () => Promise<CapsuleFacts>;
      onEvent: (taskId: string, event: AgentHostTaskEvent) => void;
      onToolRequest: (request: HostRequest, args: Record<string, unknown>, taskId: string) => Promise<unknown>;
      onHostLost: (error?: Error) => void;
      isIdle: () => boolean | Promise<boolean>;
      log?: DiagnosticLog | undefined;
      fullIntegrityVerification?: boolean;
      appInstall?: (() => Promise<AppInstall>) | undefined;
    },
  ) {}

  status(): { state: AgentHostStatus; hostVersion: string | null; lastError: string | null } {
    return { state: this.state, hostVersion: null, lastError: this.lastError };
  }

  async ensureHost(): Promise<AgentHostConnection> {
    if (this.connection) return this.connection;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.state = "starting";
      const facts = await this.deps.resolveFacts();
      if (this.deps.fullIntegrityVerification && !this.integrityVerified) {
        const { verifyCapsuleIntegrity } = await import("./app-install.js");
        const install = this.deps.appInstall ? await this.deps.appInstall() : null;
        if (install) await verifyCapsuleIntegrity(install);
        this.integrityVerified = true;
      }
      const connection = await AgentHostConnection.start(facts, {
        log: this.deps.log,
        onEvent: (taskId, event) => {
          this.lastActivityAt = Date.now();
          this.deps.onEvent(taskId, event);
        },
        onToolRequest: (request, args, taskId) => {
          this.lastActivityAt = Date.now();
          return this.deps.onToolRequest(request, args, taskId);
        },
      });
      connection.onClose((error) => {
        this.connection = null;
        this.state = "stopped";
        this.lastError = error ? error.message : null;
        this.deps.onHostLost(error);
      });
      this.connection = connection;
      this.state = "running";
      this.lastError = null;
      this.armIdleTimer();
      return connection;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async stop(): Promise<void> {
    this.disarmIdleTimer();
    const connection = this.connection;
    this.connection = null;
    this.state = "stopped";
    if (connection) await connection.shutdown();
  }

  private armIdleTimer(): void {
    this.disarmIdleTimer();
    this.lastActivityAt = Date.now();
    this.idleTimer = setInterval(() => {
      void Promise.resolve(this.deps.isIdle()).then((idle) => {
        if (idle && Date.now() - this.lastActivityAt >= AGENT_HOST_IDLE_TIMEOUT_MS) void this.stop();
      });
    }, 30_000);
    this.idleTimer.unref?.();
  }

  private disarmIdleTimer(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }
}
