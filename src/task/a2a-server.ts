import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { cancelTaskRun, startTask, TaskError, waitForTaskRun } from "./manager.js";
import { effectiveTaskStatus, isActive, listTaskRuns, type TaskRunRecord } from "./run-store.js";
import type { TaskShare } from "./share-store.js";

/** One call runs at a time per shared task; a few more wait their turn; further calls are answered busy and nothing is charged. */
export const SHARE_CONCURRENT = 1;
export const SHARE_QUEUED = 3;
/** A call waits this long for the result; after that the caller gets a task id and polls `tasks/get`. */
export const SHARE_WAIT_MS = 50_000;
/** Calls whose worktree changes the owner has not dealt with; at the limit new worktree calls are answered busy. */
export const UNHANDLED_WORKTREE_LIMIT = 10;
const MAX_REQUEST_BYTES = 16 * 1024;

export interface A2aServerDeps {
  readonly start?: typeof startTask;
  readonly wait?: typeof waitForTaskRun;
  readonly cancel?: typeof cancelTaskRun;
  readonly waitMs?: number;
  /** Tries to start the next queued call this often. */
  readonly retryMs?: number;
}

type Entry = { runId?: string; input: string; started: Promise<void>; startedOk: boolean; cancelled: boolean; failure?: string };

const BUSY = -32001;

function rpcError(id: unknown, code: number, message: string): object { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }
function reply(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

/** The Agent Card: built only from the shared definition's name, the owner's description and the version. A caller cannot change it. */
export function agentCard(share: TaskShare, url: string): object {
  return {
    protocolVersion: "0.3.0", name: share.name, description: share.description || `Task ${share.name} on the owner's computer.`,
    url, version: share.approvedHash.slice(0, 12), preferredTransport: "JSONRPC",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
    skills: [{ id: share.name, name: share.name, description: share.description || `Run ${share.name}.`, tags: [] }],
  };
}

function resultText(record: TaskRunRecord): string {
  const answer = record.answer?.trim();
  const parts: string[] = [];
  if (answer) parts.push(answer);
  if (record.snapshot.workspace === "worktree" && record.diffSummary) parts.push(`Changes (kept on the owner's computer):\n${record.diffSummary}`);
  if (parts.length === 0 && record.error) parts.push(record.error.message);
  return parts.join("\n\n");
}

function taskView(id: string, state: "submitted" | "working" | "completed" | "failed" | "canceled", text?: string): object {
  return { kind: "task", id, contextId: id, status: { state, ...(text ? { message: { kind: "message", role: "agent", messageId: randomUUID(), parts: [{ kind: "text", text }] } } : {}) }, ...(state === "completed" && text ? { artifacts: [{ artifactId: "result", parts: [{ kind: "text", text }] }] } : {}) };
}

function stateOf(record: TaskRunRecord): "working" | "completed" | "failed" | "canceled" {
  const status = effectiveTaskStatus(record);
  if (status === "queued" || status === "running") return "working";
  if (status === "completed") return "completed";
  return status === "cancelled" ? "canceled" : "failed";
}

/**
 * The A2A endpoint of one shared task, served on 127.0.0.1 and reached through the service share (frp). A remote caller supplies only the
 * request text: the runner, instructions, command, folder and workspace mode come from the approved definition and cannot be changed.
 */
export function createA2aServer(share: TaskShare, deps: A2aServerDeps = {}): { listen(port: number): Promise<number>; close(): Promise<void> } {
  const start = deps.start ?? startTask, wait = deps.wait ?? waitForTaskRun, cancel = deps.cancel ?? cancelTaskRun;
  const entries = new Map<string, Entry>();
  const queue: string[] = [];
  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;

  async function activeRuns(): Promise<TaskRunRecord[]> {
    return (await listTaskRuns()).filter((run) => run.snapshot.name === share.name && run.trigger === "remote" && isActive(run));
  }

  async function unhandledWorktrees(): Promise<number> {
    if (share.workspace !== "worktree") return 0;
    return (await listTaskRuns()).filter((run) => run.snapshot.name === share.name && run.trigger === "remote" && run.handledAt === undefined && run.status === "completed" && run.diffSummary !== undefined && run.diffSummary !== "No file changes.").length;
  }

  /** Starts queued calls while nothing of this share runs. Local tasks start without waiting here, so they go first. */
  async function pump(): Promise<void> {
    while (queue.length > 0) {
      if ((await activeRuns()).length >= SHARE_CONCURRENT) return;
      const id = queue[0]!;
      const entry = entries.get(id);
      if (!entry || entry.cancelled) { queue.shift(); continue; }
      try {
        const record = await start(share.name, { trigger: "remote", input: entry.input, workspace: share.workspace });
        entry.runId = record.runId; entry.startedOk = true; queue.shift();
      } catch (error) {
        if (error instanceof TaskError && error.code === "busy") return; // the computer is full: try again on the next tick
        entry.failure = error instanceof Error ? error.message : String(error); queue.shift();
      }
    }
  }

  async function view(id: string, entry: Entry, waitMs: number): Promise<object> {
    const deadline = Date.now() + waitMs;
    while (!entry.runId && !entry.failure && !entry.cancelled && Date.now() < deadline) {
      await pump();
      if (!entry.runId) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (entry.failure) return taskView(id, "failed", entry.failure);
    if (entry.cancelled) return taskView(id, "canceled");
    if (!entry.runId) return taskView(id, "submitted");
    const record = await wait(entry.runId, Math.max(0, deadline - Date.now()));
    const state = stateOf(record);
    return taskView(id, state, state === "working" ? undefined : resultText(record));
  }

  async function handle(request: IncomingMessage, response: ServerResponse, url: string): Promise<void> {
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(request.headers.host ?? "")) return reply(response, 403, { error: "forbidden" });
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && (path === "/.well-known/agent-card.json" || path === "/.well-known/agent.json")) return reply(response, 200, agentCard(share, url));
    if (request.method !== "POST" || path !== "/") return reply(response, 404, { error: "not_found" });
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += (chunk as Buffer).length; if (size > MAX_REQUEST_BYTES * 2) return reply(response, 413, rpcError(null, -32600, "Request too large.")); chunks.push(chunk as Buffer); }
    let message: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reply(response, 400, rpcError(null, -32700, "Parse error")); }
    const id = message.id ?? null;
    if (message.method === "message/send") {
      const parts = ((message.params?.message as { parts?: Array<{ kind?: string; text?: string }> } | undefined)?.parts ?? []);
      const text = parts.filter((part) => part.kind === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
      if (!text || Buffer.byteLength(text) > MAX_REQUEST_BYTES) return reply(response, 200, rpcError(id, -32602, "Send a text message of at most 16 KiB."));
      if (queue.length >= SHARE_QUEUED || (await activeRuns()).length + queue.length >= SHARE_CONCURRENT + SHARE_QUEUED) return reply(response, 200, rpcError(id, BUSY, "busy: this agent is handling other calls. Nothing was charged. Try again later."));
      if ((await unhandledWorktrees()) >= UNHANDLED_WORKTREE_LIMIT) return reply(response, 200, rpcError(id, BUSY, "busy: the owner has unhandled changes from earlier calls. Nothing was charged."));
      const taskId = randomUUID();
      const entry: Entry = { input: text, started: Promise.resolve(), startedOk: false, cancelled: false };
      entries.set(taskId, entry); queue.push(taskId);
      return reply(response, 200, { jsonrpc: "2.0", id, result: await view(taskId, entry, deps.waitMs ?? SHARE_WAIT_MS) });
    }
    if (message.method === "tasks/get" || message.method === "tasks/cancel") {
      const taskId = String(message.params?.id ?? "");
      const entry = entries.get(taskId);
      if (!entry) return reply(response, 200, rpcError(id, -32001, "Unknown task."));
      if (message.method === "tasks/cancel") {
        entry.cancelled = true;
        if (entry.runId) await cancel(entry.runId).catch(() => undefined);
      }
      return reply(response, 200, { jsonrpc: "2.0", id, result: await view(taskId, entry, 0) });
    }
    return reply(response, 200, rpcError(id, -32601, "Method not found"));
  }

  return {
    listen(port) {
      return new Promise((resolve, reject) => {
        const created = createServer((request, response) => {
          const address = created.address() as AddressInfo;
          void handle(request, response, `http://127.0.0.1:${address.port}/`).catch(() => { if (!response.headersSent) reply(response, 500, rpcError(null, -32603, "Internal error")); else response.end(); });
        });
        server = created;
        created.once("error", reject);
        created.listen(port, "127.0.0.1", () => {
          timer = setInterval(() => { void pump().catch(() => undefined); }, deps.retryMs ?? 2_000);
          timer.unref();
          resolve((created.address() as AddressInfo).port);
        });
      });
    },
    close() {
      if (timer) clearInterval(timer);
      const closing = server; server = undefined;
      return new Promise((resolve) => { if (!closing) { resolve(); return; } closing.close(() => resolve()); closing.closeAllConnections(); });
    },
  };
}

