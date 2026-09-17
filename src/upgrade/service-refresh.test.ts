import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installationProbe, ServiceRefresh, type InstalledCandidate, type RefreshProbe } from "./service-refresh.js";
import { acquireMaintenance, MaintenanceGate, serveMaintenance } from "./maintenance.js";

function fixture() {
  const gate = new MaintenanceGate(), controller = new AbortController();
  let installed: InstalledCandidate = { fingerprint: "new", version: "2.0.0" };
  let verified = true, restarts = 0, verifies = 0, reads = 0;
  const probe: RefreshProbe = {
    read: async () => { reads++; return installed; },
    verify: async () => { verifies++; return verified; },
  };
  const refresh = new ServiceRefresh({ probe, gate, signal: controller.signal, currentVersion: "1.0.0", restart: () => { restarts++; } });
  return { gate, controller, refresh, probe, setInstalled: (value: InstalledCandidate) => { installed = value; },
    setVerified: (value: boolean) => { verified = value; }, counts: () => ({ restarts, verifies, reads }) };
}

test("external update waits for two stable observations and restarts once with admission closed", async () => {
  const f = fixture();
  await f.refresh.check();
  assert.equal(f.counts().restarts, 0);
  f.gate.enter()();
  await f.refresh.check();
  assert.equal(f.counts().restarts, 1);
  assert.throws(() => f.gate.enter(), /preparing an upgrade/);
  await f.refresh.check();
  assert.equal(f.counts().restarts, 1);
});

test("active calls and managed processes defer external refresh without blocking their control calls", async () => {
  const f = fixture();
  const finish = f.gate.enter();
  await f.refresh.check(); await f.refresh.check();
  assert.equal(f.counts().verifies, 0);
  f.gate.enter()(); // New calls remain usable while existing work finishes.
  finish();
  let running = 1;
  f.gate.registerProcesses(() => running);
  await f.refresh.check();
  assert.equal(f.counts().restarts, 0);
  f.gate.enter()(); // read_process/stop_process must remain accessible.
  running = 0;
  await f.refresh.check();
  assert.equal(f.counts().restarts, 1);
});

test("unchanged version, incomplete installs and failed startup retain the running service", async () => {
  const f = fixture();
  f.setInstalled({ fingerprint: "same", version: "1.0.0" });
  await f.refresh.check(); await f.refresh.check();
  assert.equal(f.counts().verifies, 0);
  f.setInstalled({ fingerprint: "new-a", version: "2.0.0" }); await f.refresh.check();
  f.setInstalled({ fingerprint: "new-b", version: "2.0.0" }); await f.refresh.check();
  assert.equal(f.counts().restarts, 0);
  f.setVerified(false); await f.refresh.check();
  assert.equal(f.counts().restarts, 0);
  f.gate.enter()();
  const read = f.probe.read;
  f.probe.read = async () => { throw new Error("ENOENT during replacement"); };
  await f.refresh.check();
  f.probe.read = read; f.setVerified(true);
  await f.refresh.check();
  assert.equal(f.counts().restarts, 0);
  await f.refresh.check();
  assert.equal(f.counts().restarts, 1);
});

test("manual stop during candidate verification prevents automatic restart", async () => {
  const f = fixture();
  await f.refresh.check();
  let verified!: (result: boolean) => void;
  f.probe.verify = () => new Promise((resolve) => { verified = resolve; });
  const pending = f.refresh.check();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.throws(() => f.gate.enter());
  f.controller.abort();
  verified(true);
  await pending;
  assert.equal(f.counts().restarts, 0);
  f.gate.enter()();
  const reads = f.counts().reads;
  await f.refresh.check();
  assert.equal(f.counts().reads, reads);
});

test("a concurrent explicit upgrade keeps ownership of maintenance", async () => {
  const f = fixture();
  f.gate.pause();
  await f.refresh.check(); await f.refresh.check();
  assert.equal(f.counts().restarts, 0);
  assert.throws(() => f.gate.enter()); // Automatic refresh must not release the explicit upgrader's gate.
  f.gate.resume();
  await f.refresh.check();
  assert.equal(f.counts().restarts, 1);
});

test("verification errors resume admission; overlapping ticks never start two probes", async () => {
  const f = fixture();
  await f.refresh.check();
  let fail!: (error: Error) => void;
  f.probe.verify = () => new Promise((_resolve, reject) => { fail = reject; });
  const pending = f.refresh.check();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const reads = f.counts().reads;
  await f.refresh.check();
  assert.equal(f.counts().reads, reads);
  fail(new Error("package was replaced"));
  await pending;
  assert.equal(f.counts().restarts, 0);
  f.gate.enter()();
});

test("local maintenance reports busy instead of crashing when automatic refresh owns the gate", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp("/tmp/frely-refresh-"), path = join(root, "m.sock");
  const gate = new MaintenanceGate();
  const close = await serveMaintenance(gate, path);
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  gate.pause();
  await assert.rejects(acquireMaintenance(process.pid, path), /busy/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.throws(() => gate.enter());
  gate.resume();
  const release = await acquireMaintenance(process.pid, path);
  release();
});

test("real package replacement waits for complete dependency loading and preserves unrelated state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "frely-refresh-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, "node_modules", "frely-cli"), entry = join(pkg, "dist", "index.js");
  await mkdir(dirname(entry), { recursive: true });
  const metadata = (version: string) => writeFile(join(pkg, "package.json"), JSON.stringify({ name: "frely-cli", version, type: "module" }));
  await metadata("1.0.0");
  await writeFile(entry, 'console.log("1.0.0");\n');
  const state = join(root, "device-state.json");
  await writeFile(state, '{"deviceId":"unchanged","authorizationId":"unchanged","workspace":"/original"}\n');
  const probe = installationProbe({ method: "npm", entry, prefix: root, platform: process.platform });
  const gate = new MaintenanceGate();
  let restarted = false;
  const refresh = new ServiceRefresh({ probe, gate, signal: new AbortController().signal,
    currentVersion: "1.0.0", restart: () => { restarted = true; } });
  await refresh.check(); await refresh.check();
  assert.equal(restarted, false);
  await metadata("2.0.0");
  await writeFile(entry, 'import "./dependency.js"; console.log("2.0.0");\n');
  await refresh.check(); await refresh.check();
  assert.equal(restarted, false); // A manifest alone is not a usable installation.
  gate.enter()();
  await writeFile(join(dirname(entry), "dependency.js"), "export {};\n");
  await refresh.check(); await refresh.check();
  assert.equal(restarted, true);
  assert.equal(await readFile(state, "utf8"), '{"deviceId":"unchanged","authorizationId":"unchanged","workspace":"/original"}\n');
});

test("probe rejects a replacement that changes again before switching", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "frely-refresh-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, "dist", "index.js");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"frely-cli","version":"2.0.0"}');
  await writeFile(entry, 'console.log("2.0.0");');
  const probe = installationProbe({ method: "npm", entry, platform: process.platform });
  const candidate = await probe.read();
  await writeFile(entry, 'console.log("3.0.0");');
  assert.equal(await probe.verify(candidate), false);
});
