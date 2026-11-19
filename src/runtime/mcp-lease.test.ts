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

test("a lease closed because the login expired says so, and tells the owner what to run", () => {
  const lease = new McpLease("synthetic", Date.now() + 60_000);
  lease.close("login_expired");
  lease.close();
  assert.throws(() => lease.assert(), /Frely login expired on this computer.*frely login/);
  assert.deepEqual({ active: lease.state().active, reason: lease.state().reason }, { active: false, reason: "login_expired" });
  const plain = new McpLease("synthetic", Date.now() + 60_000);
  plain.close();
  assert.throws(() => plain.assert(), /MCP session closed on this computer/);
  assert.equal(plain.state().reason, "closed");
});

test("a login the server refused is reported but does not stop the lease", () => {
  const lease = new McpLease("synthetic", Date.now() + 60_000);
  try {
    lease.loginExpired = true;
    lease.assert();
    assert.deepEqual({ active: lease.state().active, loginExpired: lease.state().loginExpired }, { active: true, loginExpired: true });
    lease.loginExpired = false;
    assert.equal("loginExpired" in lease.state(), false);
  } finally { lease.close(); }
});

test("a 365-day lease does not overflow a Node timer", async () => {
  const lease = new McpLease("synthetic", Date.now() + 365 * 86400000);
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
  const started = await manager.start(`"${process.execPath}" -e "setInterval(() => {}, 1000)"`, process.cwd(), safeEnv(), process.cwd());
  try {
    await sleep(30); await manager.close();
    for (let attempt = 0; attempt < 40 && manager.read(started.id, 0, 0).running; attempt++) await sleep(25);
    assert.equal(manager.read(started.id, 0, 0).running, false);
    await assert.rejects(manager.start("echo blocked", process.cwd(), safeEnv(), process.cwd()), /closed/);
  } finally { await manager.close(); }
});

test("a lease closed while still valid reports a closed session, not an expired authorization", () => {
  const lease = new McpLease("synthetic", Date.now() + 60_000);
  assert.deepEqual({ active: lease.state().active, reason: lease.state().reason }, { active: true, reason: undefined });
  lease.close();
  assert.throws(() => lease.assert(), (error: Error) => !/MCP_AUTHORIZATION_EXPIRED/u.test(error.message) && /session closed/u.test(error.message));
  assert.equal(lease.state().reason, "closed");
  let wall = 1000;
  const old = new McpLease("synthetic", 2000, () => wall, () => 0);
  wall = 2000;
  assert.equal(old.state().reason, "expired");
  old.close();
});
