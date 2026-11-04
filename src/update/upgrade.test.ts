import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MaintenanceGate } from "./maintenance.js";
import { removeLegacyAutoUpdate, Upgrader, upgradeStatus, type UpgradeDependencies } from "./upgrade.js";

const installation = { method: "standalone", entry: "/x/frely", platform: "linux" } as never;
function deps(over: Partial<Record<keyof UpgradeDependencies, unknown>> = {}, calls: string[] = []): UpgradeDependencies {
  return {
    inspectInstallation: async () => installation,
    latestRelease: async () => ({ version: "2.0.0", sources: [] }),
    installedVersion: async () => "2.0.0",
    prepareStandalone: async (...args: unknown[]) => { calls.push(`signing ${JSON.stringify(args[5])}`); return { apply: async () => { calls.push("apply"); }, restore: async () => { calls.push("restore"); }, cleanup: async () => { calls.push("cleanup"); } }; },
    lockInstallation: async () => async () => { calls.push("unlock"); },
    removeStaleWindowsExecutables: async () => { calls.push("stale"); },
    ...over,
  } as unknown as UpgradeDependencies;
}
const upgrader = (gate: MaintenanceGate, d: UpgradeDependencies, extra: Record<string, unknown> = {}) => new Upgrader({ gate, restart: () => {}, deps: d, version: "1.0.0", ...extra });

test("an idle standalone installation is swapped after requiring the release signature, and admission reopens", async () => {
  const calls: string[] = [], gate = new MaintenanceGate();
  assert.equal(await upgrader(gate, deps({}, calls)).runOnce(), "updated");
  assert.deepEqual(calls, ['signing {"required":true}', "apply", "cleanup", "unlock", "stale"]);
  assert.equal(upgradeStatus().state, "updated");
  gate.enter()();
});

test("no newer version, an unsupported installation, a package manager and a busy service change nothing", async () => {
  const calls: string[] = [], gate = new MaintenanceGate();
  assert.equal(await upgrader(gate, deps({ latestRelease: async () => ({ version: "1.0.0" }) }, calls)).runOnce(), "current");
  assert.equal(await upgrader(gate, deps({ inspectInstallation: async () => ({ method: "source", platform: "linux", entry: "/x/frely" }) }, calls)).runOnce(), "unsupported");
  assert.equal(await upgrader(gate, deps({ inspectInstallation: async () => ({ method: "npm", platform: "linux", entry: "/x/frely", manager: "npm", prefix: "/p" }) }, calls)).runOnce(), "manual");
  const finish = gate.track();
  assert.equal(await upgrader(gate, deps({}, calls)).runOnce(), "busy");
  finish();
  assert.deepEqual(calls, []);
});

test("a swap that does not report the target version is restored and reported as failed", async () => {
  const calls: string[] = [], gate = new MaintenanceGate();
  assert.equal(await upgrader(gate, deps({ installedVersion: async () => "1.0.0" }, calls)).runOnce(), "failed");
  assert.deepEqual(calls.slice(1), ["apply", "restore", "cleanup", "unlock", "stale"]);
  gate.enter()();
});

test("a failing signature check stops before anything is swapped", async () => {
  const calls: string[] = [], gate = new MaintenanceGate();
  const d = deps({ prepareStandalone: async () => { throw new Error("No release signing key is configured; the update was refused."); } }, calls);
  assert.equal(await upgrader(gate, d).runOnce(), "failed");
  assert.deepEqual(calls, ["unlock", "stale"]);
});

test("on Windows the service is restarted by a helper after the swap", async () => {
  const gate = new MaintenanceGate();
  let helper = 0, restarted = 0;
  const win = { method: "standalone", entry: "C:\\f\\frely.exe", platform: "win32" } as never;
  const up = new Upgrader({ gate, restart: () => { restarted++; }, deps: deps({ inspectInstallation: async () => win }), version: "1.0.0", windowsRestart: () => { helper++; } });
  assert.equal(await up.runOnce(), "updated");
  assert.deepEqual([helper, restarted], [1, 1]);
});

test("leftover automatic-update files from older versions are deleted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "frely-legacy-"));
  await writeFile(join(directory, "auto-update"), "on\n"); await writeFile(join(directory, "auto-update-remote"), "on\n");
  await removeLegacyAutoUpdate(directory);
  await assert.rejects(readFile(join(directory, "auto-update")));
  await assert.rejects(readFile(join(directory, "auto-update-remote")));
});
