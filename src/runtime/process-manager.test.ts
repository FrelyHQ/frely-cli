import assert from "node:assert/strict";
import test from "node:test";
import { ProcessManager } from "./process-manager.js";
import { safeEnv } from "./workspace.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("persistent process exposes cursor based output", async () => {
  const manager = new ProcessManager();
  const started = manager.start(`${process.execPath} -e "console.log('ready'); setTimeout(() => console.log('done'), 40)"`, process.cwd(), safeEnv());
  assert.equal(started.running, true);
  await sleep(100);
  const first = manager.read(started.id, 0, 0);
  assert.match(first.stdout, /ready/);
  assert.match(first.stdout, /done/);
  const second = manager.read(started.id, first.stdoutCursor, first.stderrCursor);
  assert.equal(second.stdout, "");
});
