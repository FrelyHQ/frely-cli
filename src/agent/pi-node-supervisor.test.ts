import test from "node:test";
import assert from "node:assert/strict";
import { PiNodeSupervisor, type PiNodeEndpoint, type PiNodeSupervisorDeps } from "./pi-node-supervisor.js";
import type { AppInstall, CapsuleFacts } from "./app-install.js";

const install: AppInstall = { schemaVersion: 2, appVersion: "1.0.0", capsulePath: "/app/PiNode", protocolVersion: 0, agentDir: "/agent", projectsFile: "/agent/frely/mcp-projects.json" };
const facts = { manifest: { sourceCommit: "a".repeat(40) }, executable: "/app/PiNode/pi-node", headlessArguments: ["headless"], agentHostArguments: ["agent-host"] } as unknown as CapsuleFacts;

function harness(overrides: Partial<PiNodeSupervisorDeps> = {}) {
  const state = {
    install: install as AppInstall | null,
    nextPid: 100,
    alive: new Set<number>(),
    launched: [] as number[],
    terminated: [] as number[],
    endpoint: null as PiNodeEndpoint | null,
    saved: null as { pid: number; key: string } | null,
    changes: 0,
    clock: 0,
  };
  const deps: PiNodeSupervisorDeps = {
    readInstall: async () => {
      if (!state.install) throw new Error("app_not_installed");
      return state.install;
    },
    verify: async () => facts,
    verifyIntegrity: async () => undefined,
    launch: () => {
      const pid = state.nextPid++;
      state.alive.add(pid);
      state.launched.push(pid);
      state.endpoint = { url: `http://127.0.0.1:5${pid}/mcp`, token: `token-${pid}`, pid };
      return pid;
    },
    readEndpoint: async () => state.endpoint,
    readState: async () => state.saved,
    writeState: async (_install, value) => {
      state.saved = value;
    },
    isAlive: (pid) => state.alive.has(pid),
    terminate: async (pid) => {
      state.terminated.push(pid);
      state.alive.delete(pid);
    },
    onChange: () => {
      state.changes += 1;
    },
    now: () => state.clock,
    sleep: async () => undefined,
    ...overrides,
  };
  return { state, supervisor: new PiNodeSupervisor(deps) };
}

test("starts the headless node once and exposes its MCP as a local entry", async () => {
  const { state, supervisor } = harness();
  await supervisor.tick();
  await supervisor.tick();
  assert.deepEqual(state.launched, [100]);
  assert.equal(state.changes, 1);
  const entry = supervisor.localMcpEntry();
  assert.equal(entry?.name, "frely-app");
  assert.equal(entry?.url, "http://127.0.0.1:5100/mcp");
  assert.deepEqual(entry?.headers, { Authorization: "Bearer token-100" });
  assert.equal(entry?.flavor, "streamable");
});

test("restarts a crashed node after a backoff", async () => {
  const { state, supervisor } = harness();
  await supervisor.tick();
  state.alive.delete(100);
  state.clock = 1_000;
  await supervisor.tick(); // notices the exit, waits before restarting
  assert.deepEqual(state.launched, [100]);
  assert.equal(supervisor.localMcpEntry(), null);
  state.clock = 3_000;
  await supervisor.tick();
  assert.deepEqual(state.launched, [100, 101]);
  assert.equal(supervisor.localMcpEntry()?.url, "http://127.0.0.1:5101/mcp");
});

test("an App upgrade restarts the node", async () => {
  const { state, supervisor } = harness();
  await supervisor.tick();
  state.install = { ...install, appVersion: "1.1.0" };
  await supervisor.tick();
  assert.deepEqual(state.terminated, [100]);
  assert.deepEqual(state.launched, [100, 101]);
});

test("an invalid or missing app.json stops the node and the watch", async () => {
  const { state, supervisor } = harness();
  await supervisor.tick();
  state.install = null;
  await supervisor.tick();
  assert.deepEqual(state.terminated, [100]);
  assert.equal(supervisor.localMcpEntry(), null);
  await supervisor.tick();
  assert.deepEqual(state.launched, [100]);
  assert.equal(state.saved, null);
});

test("adopts a node that is already running instead of starting another", async () => {
  const first = harness();
  await first.supervisor.tick();
  // A new supervisor (CLI restarted) sees the saved state and the live endpoint.
  const second = harness({
    readState: async () => first.state.saved,
    readEndpoint: async () => first.state.endpoint,
    isAlive: (pid) => first.state.alive.has(pid),
  });
  await second.supervisor.tick();
  assert.deepEqual(second.state.launched, []);
  assert.equal(second.supervisor.localMcpEntry()?.url, "http://127.0.0.1:5100/mcp");
});

test("does not adopt a node started for another App install", async () => {
  const first = harness();
  await first.supervisor.tick();
  const second = harness({
    readState: async () => first.state.saved,
    readEndpoint: async () => first.state.endpoint,
    isAlive: (pid) => first.state.alive.has(pid),
    readInstall: async () => ({ ...install, appVersion: "2.0.0" }),
  });
  await second.supervisor.tick();
  assert.equal(second.state.launched.length, 1);
});

test("a node that never publishes its endpoint is stopped and retried later", async () => {
  const { state, supervisor } = harness({ readEndpoint: async () => null, sleep: async () => undefined });
  await supervisor.tick();
  assert.equal(supervisor.localMcpEntry(), null);
  assert.deepEqual(state.terminated, [100]);
  await supervisor.tick(); // still inside the backoff
  assert.deepEqual(state.launched, [100]);
});
