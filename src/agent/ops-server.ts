/**
 * Local GUI ops socket (plan §4.2 as amended for M4): a Unix domain socket
 * bound to the current user (0600) exposing the shared agent-op surface plus
 * `config_get`/`config_set`, and pushing `tasks_changed` notifications so the
 * Frely App task panel stays live. The socket lives only as long as the
 * serving process (`frely mcp serve`), which is also the process hosting
 * agent task execution, so remote and GUI views share one task store.
 */
import { connect, createServer, type Socket, type Server } from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgentService } from "./agent-service.js";
import { loadAgentConfig, saveAgentConfig, type AgentRuntimeConfig } from "./agent-service.js";

import { AGENT_MAX_COST_USD_LIMIT, agentStateDir, TaskStore, type AgentTaskRecord } from "./task-store.js";
import { VERSION } from "../version.js";
import { AGENT_OPS, dispatchAgentOp, isAgentOp } from "./ops.js";

const MAX_LINE_BYTES = 512 * 1024;

export interface AgentOpsServer {
  path: string;
  close: () => Promise<void>;
}

export interface AgentOpsServerOptions {
  workspace: string;
  socketPath?: string;
  env?: NodeJS.ProcessEnv;
  pollIntervalMs?: number;
  log?: (message: string) => void;
}

type OpsRequest = { id: unknown; op: unknown; args: unknown };

export async function startAgentOpsServer(agent: AgentService, options: AgentOpsServerOptions): Promise<AgentOpsServer> {
  const env = options.env ?? process.env;
  const socketPath = options.socketPath ?? join(agentStateDir(env), "ops.sock");
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });

  const sockets = new Set<import("node:net").Socket>();
  const clients = new Set<{ write: (line: string) => void }>();
  const store = TaskStore.open(undefined, env);
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    const client = {
      write: (line: string) => {
        if (!socket.destroyed) socket.write(`${line}\n`);
      },
    };
    clients.add(client);
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) void handleLine(line, client);
        if (buffer.length > MAX_LINE_BYTES) {
          client.write(JSON.stringify({ id: null, ok: false, error: { code: "request_too_large", message: "Request line exceeds the 512KB limit." } }));
          socket.destroy();
          return;
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => { clients.delete(client); sockets.delete(socket); });
    socket.on("error", () => { clients.delete(client); sockets.delete(socket); });
    // Greet the client with a task snapshot so it can render without a leading list call.
    void store.list().then((tasks) => client.write(JSON.stringify({ push: "tasks_changed", tasks })), () => undefined);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  await chmod(socketPath, 0o600);

  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  // Establish the baseline before accepting changes: any task created after
  // startup (including between a client's welcome snapshot and the first
  // poll tick) must eventually produce a push.
  let fingerprint = fingerprintFor(await store.list());
  const poll = setInterval(() => {
    if (clients.size === 0) return;
    void store.list().then((tasks) => {
      const next = fingerprintFor(tasks);
      if (next === fingerprint) return;
      fingerprint = next;
      broadcast(JSON.stringify({ push: "tasks_changed", tasks }));
    }, (error) => options.log?.(`agent.ops.poll_failed ${error instanceof Error ? error.message : String(error)}`));
  }, pollIntervalMs);
  poll.unref?.();

  async function handleLine(line: string, client: { write: (line: string) => void }): Promise<void> {
    let request: OpsRequest;
    try {
      const parsed = JSON.parse(line) as OpsRequest;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      request = parsed;
    } catch {
      client.write(JSON.stringify({ id: null, ok: false, error: { code: "invalid_request", message: "Each line must be a JSON request object." } }));
      return;
    }
    const id = request.id ?? null;
    try {
      const result = await dispatch(request);
      client.write(JSON.stringify({ id, ok: true, result }));
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : "internal";
      client.write(JSON.stringify({ id, ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } }));
    }
  }

  async function dispatch(request: OpsRequest): Promise<unknown> {
    if (request.op === "ping") return { pong: true, pid: process.pid, version: VERSION };
    if (request.op === "config_get") return { config: await loadAgentConfig(env) };
    if (request.op === "config_set") {
      const patch = (request.args && typeof request.args === "object" && !Array.isArray(request.args) ? request.args : {}) as Partial<AgentRuntimeConfig>;
      const current = await loadAgentConfig(env);
      const next: AgentRuntimeConfig = {
        schemaVersion: 1,
        remoteControlEnabled: typeof patch.remoteControlEnabled === "boolean" ? patch.remoteControlEnabled : current.remoteControlEnabled,
        defaultMaxCostUsd: typeof patch.defaultMaxCostUsd === "number" ? patch.defaultMaxCostUsd : current.defaultMaxCostUsd,
        maxCostUsdLimit: clampCost(patch.maxCostUsdLimit, current.maxCostUsdLimit),
        maxConcurrentTasks: clampConcurrency(patch.maxConcurrentTasks, current.maxConcurrentTasks),
      };
      await saveAgentConfig(next, env);
      return { config: next };
    }
    if (typeof request.op === "string" && isAgentOp(request.op)) {
      const args = (request.args && typeof request.args === "object" && !Array.isArray(request.args) ? request.args : {}) as Record<string, unknown>;
      return dispatchAgentOp(request.op, args, agent, { workspace: options.workspace }, { source: { kind: "gui" }, approvedBy: "gui" });
    }
    throw Object.assign(new Error(`Unknown op. Supported: ping, config_get, config_set, and agent ops (${AGENT_OPS.join(", ")}).`), { code: "unknown_op" });
  }

  function broadcast(line: string): void {
    for (const client of clients) client.write(line);
  }

  return {
    path: socketPath,
    close: async () => {
      clearInterval(poll);
      clients.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketPath, { force: true });
    },
  };
}

function clampCost(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= AGENT_MAX_COST_USD_LIMIT ? value : fallback;
}

function clampConcurrency(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 4 ? value : fallback;
}

function fingerprintFor(tasks: AgentTaskRecord[]): string {
  return JSON.stringify(tasks.map((task) => [task.id, task.status, task.mergeStatus, task.usage.costUsd, task.updatedAt]));
}

export function pingAgentOpsSocket(socketPath: string, timeoutMs: number): Promise<{ running: boolean; pid?: number | undefined; version?: string | undefined }> {
  return new Promise((resolvePing) => {
    const socket = connect(socketPath);
    const finish = (value: { running: boolean; pid?: number | undefined; version?: string | undefined }) => {
      socket.destroy();
      clearTimeout(timer);
      resolvePing(value);
    };
    const timer = setTimeout(() => finish({ running: false }), timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, op: "ping", args: {} })}\n`));
    socket.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const response = JSON.parse(line) as { ok?: boolean; result?: { pong?: boolean; pid?: number; version?: string } };
          if (response.ok && response.result?.pong) finish({ running: true, pid: response.result.pid, version: response.result.version });
        } catch { /* ignore partial lines */ }
      }
    });
    socket.on("error", () => finish({ running: false }));
  });
}
