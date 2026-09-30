/**
 * AgentService: orchestrates agent tasks end-to-end — validation, worktrees,
 * the agent host process, events, budget, and the merge workflow. This is the
 * single implementation behind the GUI, the device relay (`method: "agent"`),
 * and the `frely app` CLI.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { diagnostic, type DiagnosticLog } from "../runtime/diagnostics.js";
import { FairRwScheduler } from "../runtime/scheduler.js";
import { type AgentHostConnection, AgentHostSupervisor, type HostRequest } from "./supervisor.js";
import { AgentToolExecutor, toolKindFromMethod } from "./tool-executor.js";
import {
  AGENT_DEFAULT_MAX_COST_USD,
  AGENT_MAX_COST_USD_LIMIT,
  AGENT_DEFAULT_MAX_CONCURRENT_TASKS,
  AGENT_START_RATE_LIMIT_PER_MINUTE,
  AGENT_TASK_MAX_GOAL_BYTES,
  AgentStoreError,
  type AgentTaskRecord,
  type AgentTaskSource,
  agentConfigPath,
  isTerminalStatus,
  nextRuntimeStatus,
  TaskStore,
  type StoredAgentEvent,
} from "./task-store.js";
import { type AgentHostTaskEvent, newTaskId } from "./protocol.js";
import { branchNameForTask, createTaskWorktree, inspectWorkspace, mergeTaskBranch, removeTaskWorktree, taskDiff, WorktreeError } from "./worktrees.js";

export class AgentServiceError extends Error {
  constructor(readonly code: AgentServiceErrorCode, message?: string) {
    super(message ?? code);
    this.name = "AgentServiceError";
  }
}

export type AgentServiceErrorCode =
  | "invalid_args"
  | "task_not_found"
  | "workspace_not_git_repo"
  | "workspace_dirty"
  | "too_many_tasks"
  | "rate_limited"
  | "invalid_state"
  | "budget_exceeded"
  | "remote_control_disabled"
  | "app_not_installed"
  | "host_unavailable"
  | "internal";

export type AgentRuntimeConfig = {
  schemaVersion: 1;
  remoteControlEnabled: boolean;
  defaultMaxCostUsd: number;
  maxCostUsdLimit: number;
  maxConcurrentTasks: number;
};

export const DEFAULT_AGENT_CONFIG: AgentRuntimeConfig = {
  schemaVersion: 1,
  remoteControlEnabled: false,
  defaultMaxCostUsd: AGENT_DEFAULT_MAX_COST_USD,
  maxCostUsdLimit: AGENT_MAX_COST_USD_LIMIT,
  maxConcurrentTasks: AGENT_DEFAULT_MAX_CONCURRENT_TASKS,
};

export async function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): Promise<AgentRuntimeConfig> {
  try {
    const raw = JSON.parse(await readFile(agentConfigPath(env), "utf8")) as Partial<AgentRuntimeConfig>;
    return {
      schemaVersion: 1,
      remoteControlEnabled: raw.remoteControlEnabled === true,
      defaultMaxCostUsd: boundedCost(raw.defaultMaxCostUsd, AGENT_DEFAULT_MAX_COST_USD),
      maxCostUsdLimit: boundedCost(raw.maxCostUsdLimit, AGENT_MAX_COST_USD_LIMIT),
      maxConcurrentTasks: boundedConcurrency(raw.maxConcurrentTasks),
    };
  } catch {
    return { ...DEFAULT_AGENT_CONFIG };
  }
}

export async function saveAgentConfig(config: AgentRuntimeConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = agentConfigPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

function boundedCost(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= AGENT_MAX_COST_USD_LIMIT ? value : fallback;
}

function boundedConcurrency(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 4 ? value : AGENT_DEFAULT_MAX_CONCURRENT_TASKS;
}

export type StartTaskInput = {
  workspace: string;
  goal: string;
  model?: string;
  maxCostUsd?: number;
  source: AgentTaskSource;
};

export class AgentService {
  private readonly executors = new Map<string, AgentToolExecutor>();
  private readonly scheduler = new FairRwScheduler(4);
  private credentialsSent = false;
  private budgetCancels = new Set<string>();
  private _supervisor: AgentHostSupervisor | null = null;

  constructor(
    private readonly deps: {
      store: TaskStore;
      resolveSupervisor: () => AgentHostSupervisor;
      modelCredentials?: () => { apiKey: string; baseUrl: string; model: string } | null;
      config?: () => Promise<AgentRuntimeConfig>;
      log?: DiagnosticLog;
    },
  ) {}

  supervisor(): AgentHostSupervisor {
    this._supervisor ??= this.deps.resolveSupervisor();
    return this._supervisor;
  }

  async startTask(input: StartTaskInput): Promise<AgentTaskRecord> {
    const goal = typeof input.goal === "string" ? input.goal.trim() : "";
    if (goal.length === 0 || Buffer.byteLength(goal) > AGENT_TASK_MAX_GOAL_BYTES) throw new AgentServiceError("invalid_args", "goal must be 1..65536 bytes.");
    if (typeof input.workspace !== "string" || input.workspace.length === 0) throw new AgentServiceError("invalid_args", "workspace is required.");
    const config = (await this.deps.config?.()) ?? DEFAULT_AGENT_CONFIG;
    if (input.source.kind !== "gui" && !config.remoteControlEnabled) throw new AgentServiceError("remote_control_disabled", "Run `frely app remote enable` first.");
    const maxCostUsd = boundedCost(input.maxCostUsd ?? config.defaultMaxCostUsd, config.defaultMaxCostUsd);

    const tasks = await this.deps.store.list();
    const now = Date.now();
    const active = tasks.filter((task) => !isTerminalStatus(task.status));
    if (active.length >= config.maxConcurrentTasks) throw new AgentServiceError("too_many_tasks");
    const recentStarts = tasks.filter((task) => now - Date.parse(task.createdAt) < 60_000).length;
    if (recentStarts >= AGENT_START_RATE_LIMIT_PER_MINUTE) throw new AgentServiceError("rate_limited");

    let worktree: Awaited<ReturnType<typeof createTaskWorktree>>;
    const taskId = newTaskId();
    try {
      worktree = await createTaskWorktree(taskId, input.workspace);
    } catch (error) {
      if (error instanceof WorktreeError) {
        if (error.code === "not_a_git_repo") throw new AgentServiceError("workspace_not_git_repo");
        if (error.code === "dirty_workspace") throw new AgentServiceError("workspace_dirty");
      }
      throw error;
    }

    const id = taskId;
    const record: AgentTaskRecord = {
      id,
      source: input.source,
      workspace: input.workspace,
      worktreePath: worktree.path,
      branch: worktree.branch,
      baseBranch: worktree.baseBranch,
      baseCommit: worktree.baseCommit,
      goal,
      model: input.model ?? null,
      maxCostUsd,
      status: "queued",
      mergeStatus: "none",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      error: null,
      mergeRequest: null,
      approval: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settledAt: null,
    };
    await this.deps.store.create(record);

    try {
      const connection = await this.ensureHostWithCredentials();
      this.executors.set(id, new AgentToolExecutor(worktree.path, this.scheduler));
      await connection.request("task.start", {
        taskId: id,
        worktreePath: worktree.path,
        goal,
        model: input.model ?? null,
        budgetUsd: maxCostUsd,
        baseBranch: worktree.baseBranch,
        baseCommit: worktree.baseCommit,
      });
    } catch (error) {
      this.executors.delete(id);
      await this.deps.store.update(id, (task) => ({ ...task, status: "failed", error: error instanceof Error ? error.message : "task start failed", settledAt: new Date().toISOString() }));
      await this.deps.store.appendEvent(id, { type: "status", status: "failed", detail: "Agent host unavailable." });
      if (error instanceof AgentServiceError) throw error;
      throw new AgentServiceError("host_unavailable", error instanceof Error ? error.message : "agent host unavailable");
    }
    return (await this.deps.store.read(id))!;
  }

  async listTasks(workspace?: string): Promise<AgentTaskRecord[]> {
    const tasks = await this.deps.store.list();
    return workspace ? tasks.filter((task) => task.workspace === workspace) : tasks;
  }

  async getTask(id: string): Promise<AgentTaskRecord> {
    return this.deps.store.read(id);
  }

  async getEvents(id: string, cursor = 0): Promise<{ events: StoredAgentEvent[]; nextCursor: number | null }> {
    return this.deps.store.readEvents(id, cursor);
  }

  async sendMessage(id: string, message: string): Promise<void> {
    if (typeof message !== "string" || message.length === 0 || message.length > 64 * 1024) throw new AgentServiceError("invalid_args");
    const task = await this.deps.store.read(id);
    if (task.status !== "running" && task.status !== "waiting_input") throw new AgentServiceError("invalid_state", `Cannot send a message to a ${task.status} task.`);
    const connection = await this.supervisor().ensureHost();
    await connection.request("task.message", { taskId: id, message });
  }

  async cancelTask(id: string): Promise<AgentTaskRecord> {
    const task = await this.deps.store.read(id);
    if (isTerminalStatus(task.status)) return task;
    if (task.status === "queued" && !this.executors.has(id)) {
      return this.settleCancelled(id, "Cancelled before start.");
    }
    try {
      const connection = await this.supervisor().ensureHost();
      await connection.request("task.cancel", { taskId: id, reason: "User requested cancellation." }, 10_000);
    } catch (error) {
      this.debug("agent.task.cancel_failed", id, error);
      return this.settleCancelled(id, "Cancelled (host unreachable).");
    }
    return this.deps.store.read(id);
  }

  private async settleCancelled(id: string, detail: string): Promise<AgentTaskRecord> {
    this.executors.delete(id);
    const record = await this.deps.store.update(id, (task) => ({ ...task, status: "cancelled", settledAt: new Date().toISOString() }));
    await this.deps.store.appendEvent(id, { type: "status", status: "cancelled", detail });
    return record;
  }

  async getDiff(id: string, path?: string): Promise<{ diff: string; truncated: boolean }> {
    const task = await this.deps.store.read(id);
    try {
      return await taskDiff(id, task.workspace, path);
    } catch (error) {
      if (error instanceof WorktreeError && error.code === "not_a_git_repo") throw new AgentServiceError("workspace_not_git_repo");
      throw new AgentServiceError("internal", error instanceof Error ? error.message : "diff failed");
    }
  }

  async requestMerge(id: string, note?: string): Promise<AgentTaskRecord> {
    const task = await this.deps.store.read(id);
    if (task.status !== "completed") throw new AgentServiceError("invalid_state", "Only completed tasks can request a merge.");
    if (task.mergeStatus !== "none") throw new AgentServiceError("invalid_state", `Merge already ${task.mergeStatus}.`);
    return this.deps.store.update(id, (record) => ({
      ...record,
      mergeStatus: "merge_requested",
      mergeRequest: { requestedAt: new Date().toISOString(), ...(note !== undefined && note.length > 0 ? { note: note.slice(0, 2048) } : {}) },
    }));
  }

  async approveMerge(id: string, approvedBy: "gui" | "web"): Promise<AgentTaskRecord> {
    const task = await this.deps.store.read(id);
    if (task.mergeStatus !== "merge_requested") throw new AgentServiceError("invalid_state", `Merge state is ${task.mergeStatus}.`);
    const approved = await this.deps.store.update(id, (record) => ({
      ...record,
      mergeStatus: "approved",
      approval: { approvedAt: new Date().toISOString(), approvedBy },
    }));
    const outcome = await mergeTaskBranch(id, task.workspace);
    if (outcome.status === "merged") {
      await removeTaskWorktree(id, task.workspace).catch(() => undefined);
      return this.deps.store.update(id, (record) => ({ ...record, mergeStatus: "merged" }));
    }
    return this.deps.store.update(id, (record) => ({ ...record, mergeStatus: "merge_conflict", error: outcome.detail }));
  }

  async discardTask(id: string): Promise<AgentTaskRecord> {
    const task = await this.deps.store.read(id);
    if (task.mergeStatus === "merged" || task.mergeStatus === "discarded") throw new AgentServiceError("invalid_state", `Task already ${task.mergeStatus}.`);
    await removeTaskWorktree(id, task.workspace).catch(() => undefined);
    this.executors.delete(id);
    return this.deps.store.update(id, (record) => ({ ...record, mergeStatus: "discarded" }));
  }

  async stopHost(): Promise<void> {
    for (const executor of this.executors.values()) executor.dispose();
    this.executors.clear();
    await this.supervisor().stop();
  }

  status(): { host: ReturnType<AgentHostSupervisor["status"]> } {
    return { host: this.supervisor().status() };
  }

  // --- host wiring ---------------------------------------------------------

  private async ensureHostWithCredentials(): Promise<AgentHostConnection> {
    const connection = await this.supervisor().ensureHost();
    if (!this.credentialsSent) {
      const credentials = this.deps.modelCredentials?.();
      if (credentials) connection.notify("model.credentials", credentials);
      this.credentialsSent = true;
    }
    return connection;
  }

  private debug(event: string, taskId: string, error?: unknown): void {
    this.deps.log?.(JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, event, taskId, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) }));
  }

  private eventsQueue: Promise<void> = Promise.resolve();

  readonly onTaskEvent = (taskId: string, event: AgentHostTaskEvent): void => {
    // Hosts may burst events in a single tick (e.g. running+completed); apply them
    // strictly in arrival order so a late non-terminal write cannot overwrite a terminal one.
    this.eventsQueue = this.eventsQueue
      .then(() => this.handleTaskEvent(taskId, event))
      .catch((error) => this.debug("agent.event_apply_failed", taskId, error));
  };

  private async handleTaskEvent(taskId: string, event: AgentHostTaskEvent): Promise<void> {
    if (event.type === "status") {
      const current = await this.deps.store.read(taskId).catch(() => null);
      if (!current) return;
      const next = nextRuntimeStatus(current.status, event);
      if (next === null) {
        this.debug("agent.task.status_rejected", taskId);
        return;
      }
      await this.deps.store.update(taskId, (task) => ({
        ...task,
        status: next,
        error: next === "failed" ? event.detail ?? "Task failed." : task.error,
        settledAt: isTerminalStatus(next) ? new Date().toISOString() : task.settledAt,
      }));
      if (isTerminalStatus(next)) {
        this.executors.get(taskId)?.dispose();
        this.executors.delete(taskId);
        void this.supervisor().ensureHost().then((connection) => connection.request("session.dispose", { taskId }, 5_000)).catch(() => undefined);
      }
    }
    if (event.type === "usage") {
      const task = await this.deps.store.read(taskId).catch(() => null);
      if (!task) return;
      await this.deps.store.update(taskId, (record) => ({
        ...record,
        usage: {
          inputTokens: record.usage.inputTokens + event.inputTokens,
          outputTokens: record.usage.outputTokens + event.outputTokens,
          costUsd: Math.max(record.usage.costUsd, event.costUsd),
        },
      }));
      const latest = await this.deps.store.read(taskId);
      if (latest.usage.costUsd >= latest.maxCostUsd && !isTerminalStatus(latest.status) && !this.budgetCancels.has(taskId)) {
        this.budgetCancels.add(taskId);
        void this.supervisor()
          .ensureHost()
          .then((connection) => connection.request("task.cancel", { taskId, reason: "Budget limit reached." }, 10_000))
          .catch(() => this.settleCancelled(taskId, "Budget limit reached (host unreachable)."));
      }
    }
    await this.deps.store.appendEvent(taskId, event);
  }

  readonly onHostLost = (error?: Error): void => {
    this.credentialsSent = false;
    this.budgetCancels.clear();
    void this.failRunningTasks(error).catch(() => undefined);
  };

  private async failRunningTasks(error?: Error): Promise<void> {
    const detail = error ? `Agent host exited unexpectedly: ${error.message}` : "Agent host exited unexpectedly.";
    for (const task of await this.deps.store.list()) {
      if (isTerminalStatus(task.status)) continue;
      this.executors.delete(task.id);
      await this.deps.store.update(task.id, (record) => ({ ...record, status: "failed", error: detail, settledAt: new Date().toISOString() }));
      await this.deps.store.appendEvent(task.id, { type: "status", status: "failed", detail });
    }
  }

  readonly onToolRequest = async (request: HostRequest, args: Record<string, unknown>, taskId: string): Promise<unknown> => {
    const kind = toolKindFromMethod(request.method);
    if (!kind) throw new Error(`Unsupported tool method: ${request.method}`);
    const executor = this.executors.get(taskId);
    if (!executor) {
      const task = await this.deps.store.read(taskId).catch(() => null);
      if (!task) throw new Error("Unknown task.");
      throw new Error(`Task ${taskId} is ${task.status}; tools are unavailable.`);
    }
    const result = await executor.execute(kind, args);
    if (!result.ok) throw new Error(result.error.message);
    return result.result;
  };
}

export { TaskStore, AgentStoreError, branchNameForTask };
