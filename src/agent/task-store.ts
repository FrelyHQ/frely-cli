/**
 * Agent task store: one directory per task under the frely state directory
 * (`<state>/agent/tasks/<taskId>/`), with `task.json` for the record and
 * `events.jsonl` for the append-only event log.
 */
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isValidTaskId, type AgentHostTaskEvent } from "./protocol.js";

export type AgentTaskRuntimeStatus = "queued" | "running" | "waiting_input" | "completed" | "failed" | "cancelled";
export type AgentTaskMergeStatus = "none" | "merge_requested" | "approved" | "merged" | "merge_conflict" | "discarded";

export type AgentTaskSource = { kind: "gui" } | { kind: "web" } | { kind: "mcp"; authorizationId: string };

export type AgentTaskUsage = { inputTokens: number; outputTokens: number; costUsd: number };

export type AgentTaskRecord = {
  id: string;
  source: AgentTaskSource;
  workspace: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  goal: string;
  model: string | null;
  maxCostUsd: number;
  status: AgentTaskRuntimeStatus;
  mergeStatus: AgentTaskMergeStatus;
  usage: AgentTaskUsage;
  error: string | null;
  mergeRequest: { requestedAt: string; note?: string } | null;
  approval: { approvedAt: string; approvedBy: "gui" | "web" } | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
};

export type StoredAgentEvent = AgentHostTaskEvent & { seq: number; at: string };

export const AGENT_TASK_EVENTS_PAGE_SIZE = 100;
export const AGENT_TASK_MAX_GOAL_BYTES = 64 * 1024;
export const AGENT_DEFAULT_MAX_COST_USD = 2;
export const AGENT_MAX_COST_USD_LIMIT = 50;
export const AGENT_DEFAULT_MAX_CONCURRENT_TASKS = 2;
export const AGENT_START_RATE_LIMIT_PER_MINUTE = 5;

export class AgentStoreError extends Error {
  constructor(readonly code: "task_not_found" | "task_exists" | "store_corrupt" | "invalid_task") {
    super(code);
    this.name = "AgentStoreError";
  }
}

export function agentStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "frely", "agent");
}

export function agentConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "agent.json");
}

export function agentDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "frely");
}

export function workspaceStorageKey(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

/** Serialize + validate the runtime/merge state machine transitions. */
export function nextRuntimeStatus(current: AgentTaskRuntimeStatus, event: AgentHostTaskEvent): AgentTaskRuntimeStatus | null {
  if (event.type !== "status") return null;
  switch (current) {
    case "queued":
      // Host events may race ahead of CLI bookkeeping right after task.start,
      // so any authoritative host status is accepted from queued.
      return event.status === "running" || event.status === "waiting_input" || event.status === "completed" || event.status === "failed" || event.status === "cancelled"
        ? event.status
        : null;
    case "running":
      return event.status === "waiting_input" || event.status === "completed" || event.status === "failed" || event.status === "cancelled" || event.status === "running"
        ? event.status
        : null;
    case "waiting_input":
      return event.status === "running" || event.status === "completed" || event.status === "failed" || event.status === "cancelled" ? event.status : null;
    default:
      return null;
  }
}

export function isTerminalStatus(status: AgentTaskRuntimeStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export class TaskStore {
  constructor(private readonly rootDir: string) {}

  static open(rootDir?: string, env: NodeJS.ProcessEnv = process.env): TaskStore {
    return new TaskStore(rootDir ?? join(agentStateDir(env), "tasks"));
  }

  async create(record: AgentTaskRecord): Promise<void> {
    if (!isValidTaskId(record.id)) throw new AgentStoreError("invalid_task");
    const dir = this.taskDir(record.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (await this.read(record.id).then(() => true, () => false)) throw new AgentStoreError("task_exists");
    await this.persist(record);
  }

  async read(id: string): Promise<AgentTaskRecord> {
    if (!isValidTaskId(id)) throw new AgentStoreError("invalid_task");
    let raw: string;
    try {
      raw = await readFile(join(this.taskDir(id), "task.json"), "utf8");
    } catch {
      throw new AgentStoreError("task_not_found");
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new AgentStoreError("store_corrupt");
    }
    return validateTaskRecord(value);
  }

  async update(id: string, mutate: (record: AgentTaskRecord) => AgentTaskRecord): Promise<AgentTaskRecord> {
    const current = await this.read(id);
    const next = validateTaskRecord(mutate(structuredClone(current)));
    if (next.id !== current.id) throw new AgentStoreError("invalid_task");
    await this.persist(next);
    return next;
  }

  async list(): Promise<AgentTaskRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch {
      return [];
    }
    const records: AgentTaskRecord[] = [];
    for (const entry of entries.sort()) {
      if (!isValidTaskId(entry)) continue;
      const record = await this.read(entry).catch(() => null);
      if (record) records.push(record);
    }
    return records;
  }

  async appendEvent(id: string, event: AgentHostTaskEvent): Promise<StoredAgentEvent> {
    const dir = this.taskDir(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const last = await this.lastEventSeq(id);
    const stored: StoredAgentEvent = { ...event, seq: last + 1, at: new Date().toISOString() };
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(dir, "events.jsonl"), `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
    return stored;
  }

  async readEvents(id: string, cursor: number, limit = AGENT_TASK_EVENTS_PAGE_SIZE): Promise<{ events: StoredAgentEvent[]; nextCursor: number | null }> {
    let raw: string;
    try {
      raw = await readFile(join(this.taskDir(id), "events.jsonl"), "utf8");
    } catch {
      if (await this.read(id).then(() => true, () => false)) return { events: [], nextCursor: null };
      throw new AgentStoreError("task_not_found");
    }
    const events: StoredAgentEvent[] = [];
    let nextCursor: number | null = null;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let parsed: StoredAgentEvent;
      try {
        parsed = JSON.parse(line) as StoredAgentEvent;
      } catch {
        continue;
      }
      if (parsed.seq > cursor) {
        events.push(parsed);
        if (events.length > limit) {
          events.pop();
          nextCursor = parsed.seq - 1;
          break;
        }
      }
    }
    return { events, nextCursor };
  }

  private async lastEventSeq(id: string): Promise<number> {
    let raw: string;
    try {
      raw = await readFile(join(this.taskDir(id), "events.jsonl"), "utf8");
    } catch {
      return 0;
    }
    const lines = raw.trimEnd().split("\n");
    const last = lines[lines.length - 1];
    if (!last) return 0;
    try {
      const parsed = JSON.parse(last) as StoredAgentEvent;
      return typeof parsed.seq === "number" ? parsed.seq : 0;
    } catch {
      return 0;
    }
  }

  private taskDir(id: string): string {
    return join(this.rootDir, id);
  }

  private async persist(record: AgentTaskRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    const dir = this.taskDir(record.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `task.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, join(dir, "task.json"));
  }
}

export function validateTaskRecord(value: unknown): AgentTaskRecord {
  if (!value || typeof value !== "object") throw new AgentStoreError("store_corrupt");
  const r = value as Record<string, unknown>;
  const id = r.id;
  if (typeof id !== "string" || !isValidTaskId(id)) throw new AgentStoreError("store_corrupt");
  const runtimeStatuses: AgentTaskRuntimeStatus[] = ["queued", "running", "waiting_input", "completed", "failed", "cancelled"];
  const mergeStatuses: AgentTaskMergeStatus[] = ["none", "merge_requested", "approved", "merged", "merge_conflict", "discarded"];
  if (!runtimeStatuses.includes(r.status as AgentTaskRuntimeStatus)) throw new AgentStoreError("store_corrupt");
  if (!mergeStatuses.includes(r.mergeStatus as AgentTaskMergeStatus)) throw new AgentStoreError("store_corrupt");
  for (const key of ["workspace", "worktreePath", "branch", "baseBranch", "baseCommit", "goal", "createdAt", "updatedAt"] as const) {
    if (typeof r[key] !== "string") throw new AgentStoreError("store_corrupt");
  }
  for (const key of ["maxCostUsd"] as const) {
    if (typeof r[key] !== "number" || !Number.isFinite(r[key] as number) || (r[key] as number) <= 0) throw new AgentStoreError("store_corrupt");
  }
  return value as AgentTaskRecord;
}
