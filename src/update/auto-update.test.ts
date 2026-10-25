import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutoUpdater, readAutoUpdate, writeAutoUpdate, type AutoUpdateDependencies } from "./auto-update.js";
import { MaintenanceGate } from "./maintenance.js";

const installation = { method: "standalone", entry: "/x/frely", platform: "linux" } as never;
function deps(over: Partial<Record<keyof AutoUpdateDependencies, unknown>> = {}, calls: string[] = []): AutoUpdateDependencies {
  return {
    inspectInstallation: async () => installation,
    latestRelease: async () => ({ version: "2.0.0", sources: [] }),
    installedVersion: async () => "2.0.0",
    prepareStandalone: async () => ({ apply: async () => { calls.push("apply"); }, restore: async () => { calls.push("restore"); }, cleanup: async () => { calls.push("cleanup"); } }),
    installPackage: async (_i: unknown, v: string) => { calls.push(`pkg ${v}`); },
    lockInstallation: async () => async () => { calls.push("unlock"); },
    ...over,
  } as unknown as AutoUpdateDependencies;
}
const updater = (gate: MaintenanceGate, d: AutoUpdateDependencies, enabled = true) => new AutoUpdater({ enabled: () => enabled, gate, deps: d, version: "1.0.0" });

test("the local switch is off until written and removable", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "frely-au-")), "cfg", "auto-update");
  assert.equal(await readAutoUpdate(path), false);
  await writeAutoUpdate(true, path);
  assert.equal(await readAutoUpdate(path), true);
  assert.equal((await readFile(path, "utf8")).trim(), "on");
  await writeAutoUpdate(false, path);
  assert.equal(await readAutoUpdate(path), false);
});

test("a disabled updater does nothing, not even a release lookup", async () => {
  const calls: string[] = [];
  assert.equal(await updater(new MaintenanceGate(), deps({ latestRelease: async () => { calls.push("lookup"); return { version: "2.0.0" }; } }), false).check(), "disabled");
  assert.deepEqual(calls, []);
});

test("an enabled idle service swaps in the newer standalone and resumes admission", async () => {
  const calls: string[] = [], gate = new MaintenanceGate();
  assert.equal(await updater(gate, deps({}, calls)).check(), "updated");
  assert.deepEqual(calls, ["apply", "cleanup", "unlock"]);
  gate.enter()(); // admission is open again
});

test("no newer version, an unsupported installation and a busy service change nothing", async () => {
  const calls: string[] = [], gate = new MaintenanceGate();
  assert.equal(await updater(gate, deps({ latestRelease: async () => ({ version: "1.0.0" }) }, calls)).check(), "current");
  assert.equal(await updater(gate, deps({ inspectInstallation: async () => ({ method: "source", platform: "linux" }) }, calls)).check(), "unsupported");
  const finish = gate.track();
  assert.equal(await updater(gate, deps({}, calls)).check(), "busy");
  finish();
  assert.deepEqual(calls, []);
});

test("a swap that does not report the target version is restored and reported as failed", async () => {
  const calls: string[] = [], gate = new MaintenanceGate();
  assert.equal(await updater(gate, deps({ installedVersion: async () => "1.0.0" }, calls)).check(), "failed");
  assert.deepEqual(calls, ["apply", "restore", "cleanup", "unlock"]);
  gate.enter()();
});

test("a package-manager installation updates without pausing admission", async () => {
  const calls: string[] = [], gate = new MaintenanceGate();
  const pm = deps({ inspectInstallation: async () => ({ method: "npm", entry: "/x", platform: "linux", manager: "npm" }),
    installPackage: async (_i: unknown, v: string) => { calls.push(`pkg ${v}`); gate.enter()(); } }, calls);
  assert.equal(await updater(gate, pm).check(), "updated");
  assert.deepEqual(calls, ["pkg 2.0.0", "unlock"]);
});
