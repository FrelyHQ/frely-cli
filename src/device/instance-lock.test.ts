import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRelayInstanceLock, RelayInstanceBusyError } from "./instance-lock.js";

const info = { entry: "/usr/local/bin/frely", version: "0.0.0-test" };

test("a second device relay for the same data directory is refused while the first runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frely-instance-"));
  const path = join(dir, "relay-service.lock");
  try {
    const release = await acquireRelayInstanceLock(info, { path });
    await writeFile(path, JSON.stringify({ pid: 424242, startedAt: "t", entry: "/opt/other/frely", version: "0.23.1" }));
    await assert.rejects(acquireRelayInstanceLock(info, { path, waitMs: 300, isAlive: () => true }), (error: unknown) => {
      assert.ok(error instanceof RelayInstanceBusyError);
      assert.match((error as Error).message, /pid 424242.*\/opt\/other\/frely.*0\.23\.1/u);
      return true;
    });
    // The first holder's release never removes a lock another process took over.
    release();
    assert.match(await readFile(path, "utf8"), /424242/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a lock left by a process that no longer exists is taken over, and released on exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frely-instance-"));
  const path = join(dir, "relay-service.lock");
  try {
    await writeFile(path, JSON.stringify({ pid: 424242, startedAt: "t", entry: "x", version: "y" }));
    const release = await acquireRelayInstanceLock(info, { path, waitMs: 300, isAlive: () => false });
    assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
    release();
    await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a holder that is shutting down is waited for", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frely-instance-"));
  const path = join(dir, "relay-service.lock");
  try {
    await writeFile(path, JSON.stringify({ pid: 424242, startedAt: "t", entry: "x", version: "y" }));
    let exited = false;
    setTimeout(() => { exited = true; }, 300);
    const release = await acquireRelayInstanceLock(info, { path, waitMs: 5000, isAlive: () => !exited });
    release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
