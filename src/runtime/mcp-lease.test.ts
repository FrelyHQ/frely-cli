import test from "node:test";
import assert from "node:assert/strict";
import { FairRwScheduler } from "./scheduler.js";
import { McpLease } from "./mcp-lease.js";
import { ProcessManager } from "./process-manager.js";
import { runShellCommand } from "./process-tree.js";
import { safeEnv } from "./workspace.js";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("MCP lease expires at the boundary and clock rollback cannot extend a running lease", () => {
  let wall = 1000, elapsed = 0;
  const lease = new McpLease("synthetic", 2000, () => wall, () => elapsed);
  try {
    lease.assert(); wall = 1999; elapsed = 999; lease.assert();
    wall = 1000; elapsed = 1000;
    assert.throws(() => lease.assert(), /MCP_AUTHORIZATION_EXPIRED/);
    assert.equal(lease.controller.signal.aborted, true);
    wall = 0; elapsed = 0;
    assert.throws(() => lease.assert(), /MCP_AUTHORIZATION_EXPIRED/);
  } finally { lease.close(); }
});

test("a 180-day lease does not overflow a Node timer", async () => {
  const lease = new McpLease("synthetic", Date.now() + 180 * 86400000);
  try { await sleep(15); assert.equal(lease.controller.signal.aborted, false); lease.assert(); }
  finally { lease.close(); }
});

test("queued MCP mutations recheck authorization before execution", async () => {
  let wall = 1000;
  const lease = new McpLease("synthetic", 2000, () => wall, () => 0);
  const scheduler = new FairRwScheduler(1, () => lease.assert());
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let executions = 0;
  try {
    const first = scheduler.write(async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); });
    await started;
    const queued = scheduler.write(async () => { executions++; });
    const rejected = assert.rejects(queued, /MCP_AUTHORIZATION_EXPIRED/);
    wall = 2000; release();
    await first; await rejected;
    assert.equal(executions, 0);
  } finally { lease.close(); }
});

test("cancelling a running shell command rejects its result", async () => {
  const controller = new AbortController();
  const command = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;
  const result = runShellCommand(command, process.cwd(), safeEnv(), 5000, 1024, controller.signal);
  const rejected = assert.rejects(result, /authorization was cancelled/);
  await sleep(30); controller.abort(); await rejected;
});

test("closing an MCP process manager stops tracked children and forbids new starts", async () => {
  const manager = new ProcessManager();
  const started = manager.start(`"${process.execPath}" -e "setInterval(() => {}, 1000)"`, process.cwd(), safeEnv());
  try {
    await sleep(30); await manager.close();
    for (let attempt = 0; attempt < 40 && manager.read(started.id, 0, 0).running; attempt++) await sleep(25);
    assert.equal(manager.read(started.id, 0, 0).running, false);
    assert.throws(() => manager.start("echo blocked", process.cwd(), safeEnv()), /closed/);
  } finally { await manager.close(); }
});
