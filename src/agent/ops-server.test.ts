import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

import { startAgentOpsServer } from "./ops-server.js";
import { TaskStore, type AgentTaskRecord } from "./task-store.js";
import { createAgentService } from "./compose.js";

function makeTask(partial: Partial<AgentTaskRecord>): AgentTaskRecord {
  return {
    id: "at_aaaaaaaaaaaaaaaaaaaaaaaa",
    source: { kind: "web" },
    workspace: "/tmp/w",
    worktreePath: "/tmp/wt",
    branch: "frely/task-1",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    goal: "do the thing",
    model: null,
    maxCostUsd: 2,
    status: "queued",
    mergeStatus: "none",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    error: null,
    mergeRequest: null,
    approval: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    settledAt: null,
    ...partial,
  };
}

type OpsMessage = { id?: unknown; ok?: boolean; result?: unknown; error?: { code?: string; message?: string }; push?: string; tasks?: unknown[] };

class SocketClient {
  private readonly lines: OpsMessage[] = [];
  private readonly waiters: Array<{ resolve: (message: OpsMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  private buffer = "";
  constructor(readonly socket: import("node:net").Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 0) {
          try { this.enqueue(JSON.parse(line) as OpsMessage); } catch { this.enqueue({ id: null, ok: false, error: { code: "unparseable" } }); }
        }
        newline = this.buffer.indexOf("\n");
      }
    });
  }
  private enqueue(message: OpsMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      this.lines.push(message);
    }
  }
  static connect(path: string): Promise<SocketClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      socket.once("connect", () => resolve(new SocketClient(socket)));
      socket.once("error", reject);
    });
  }
  call(id: number | string, op: string, args: Record<string, unknown> = {}): void {
    this.socket.write(`${JSON.stringify({ id, op, args })}\n`);
  }
  next(timeoutMs = 5000): Promise<OpsMessage> {
    const queued = this.lines.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((entry) => entry.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("ops socket response timeout"));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }
  /** Drop queued push notifications so the next [next] waits for a fresh message. */
  drainPushes(): void {
    while (this.lines.length > 0 && this.lines[0]?.push !== undefined) this.lines.shift();
  }
  close(): void { this.socket.destroy(); }
}

test("agent ops socket serves ping, config, agent ops with gui identity, and task-change pushes", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "frely-ops-sock-"));
  const env = { ...process.env, XDG_STATE_HOME: stateRoot } as NodeJS.ProcessEnv;
  const socketPath = join(stateRoot, "ops.sock");
  const agent = createAgentService({ defaultWorkspace: "/tmp/w", env });
  const store = TaskStore.open(undefined, env);
  const server = await startAgentOpsServer(agent, { workspace: "/tmp/w", socketPath, env, pollIntervalMs: 50 });
  const client = await SocketClient.connect(server.path);
  try {
    // The server greets every client with a task snapshot.
    const welcome = await client.next() as { push?: string; tasks?: unknown[] };
    assert.equal(welcome.push, "tasks_changed");
    assert.equal(welcome.tasks?.length, 0);
    // Socket is current-user only.
    const mode = (await stat(server.path)).mode & 0o777;
    assert.equal(mode, 0o600);

    // ping
    client.call(1, "ping");
    const pong = await client.next() as { result?: { pong?: boolean } };
    assert.equal(pong.result?.pong, true);

    // config_get reflects defaults; config_set clamps and persists.
    client.call(2, "config_get");
    const config = await client.next() as { result?: { config?: { remoteControlEnabled?: boolean } } };
    assert.equal(config.result?.config?.remoteControlEnabled, false);
    client.call(3, "config_set", { remoteControlEnabled: true, maxConcurrentTasks: 99 });
    const saved = await client.next() as { result?: { config?: { remoteControlEnabled?: boolean; maxConcurrentTasks?: number } } };
    assert.equal(saved.result?.config?.remoteControlEnabled, true);
    assert.equal(saved.result?.config?.maxConcurrentTasks, 2, "out-of-range concurrency falls back to the current value");

    // Agent ops work over the socket with the full local task view.
    await store.create(makeTask({ id: "at_aaaaaaaaaaaaaaaaaaaaaaaa", goal: "from store" }));
    client.call(4, "agent_list_tasks");
    client.drainPushes();
    const listed = await client.next() as { result?: { tasks?: AgentTaskRecord[] } };
    assert.equal(listed.result?.tasks?.length, 1);
    assert.equal(listed.result?.tasks?.[0]?.source.kind, "web", "ops socket returns the full record including source");

    // Unknown op and malformed lines fail without killing the connection.
    client.call(5, "nope");
    const unknown = await client.next() as { error?: { code?: string } };
    assert.equal(unknown.error?.code, "unknown_op");
    client.socket.write("this is not json\n");
    const malformed = await client.next() as { error?: { code?: string } };
    assert.equal(malformed.error?.code, "invalid_request");
    client.call(6, "ping");
    assert.equal((await client.next() as { result?: { pong?: boolean } }).result?.pong, true);

    // Task changes are pushed to connected clients.
    await store.create(makeTask({ id: "at_bbbbbbbbbbbbbbbbbbbbbbbb", goal: "second", status: "running" }));
    const pushed = await client.next(3000) as { push?: string; tasks?: AgentTaskRecord[] };
    assert.ok(pushed.tasks && pushed.tasks.length >= 1, "task push carries the tasks");
    assert.equal(pushed.push, "tasks_changed");
    assert.equal(pushed.tasks?.length, 2);
  } finally {
    client.close();
    await server.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});
