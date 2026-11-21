import assert from "node:assert/strict";
import test from "node:test";
import { FairRwScheduler } from "./scheduler.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("parallel reads may overlap", async () => {
  const scheduler = new FairRwScheduler(2);
  let active = 0;
  let peak = 0;
  const read = () => scheduler.read(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(20);
    active -= 1;
  });
  await Promise.all([read(), read()]);
  assert.equal(peak, 2);
});

test("queued write blocks later reads", async () => {
  const scheduler = new FairRwScheduler(4);
  const events: string[] = [];
  const first = scheduler.read(async () => {
    events.push("read1:start");
    await sleep(20);
    events.push("read1:end");
  });
  const write = scheduler.write(async () => {
    events.push("write:start");
    await sleep(5);
    events.push("write:end");
  });
  const second = scheduler.read(async () => {
    events.push("read2");
  });
  await Promise.all([first, write, second]);
  assert.deepEqual(events, ["read1:start", "read1:end", "write:start", "write:end", "read2"]);
});

test("a queued job leaves the queue when its signal aborts, and the jobs behind it still run", async () => {
  const scheduler = new FairRwScheduler(1);
  let release!: () => void;
  const first = scheduler.read(() => new Promise<void>((resolve) => { release = resolve; }));
  const controller = new AbortController();
  let ran = false;
  const cancelled = scheduler.write(async () => { ran = true; }, controller.signal);
  const behind = scheduler.read(async () => "behind");
  controller.abort(new Error("cancelled by relay"));
  await assert.rejects(cancelled, /cancelled by relay/u);
  release();
  await first;
  assert.equal(await behind, "behind");
  assert.equal(ran, false);
});

test("an aborted signal does not affect a job that already started", async () => {
  const scheduler = new FairRwScheduler(1);
  const controller = new AbortController();
  const started = scheduler.read(async () => { await sleep(10); return "done"; }, controller.signal);
  await sleep(1);
  controller.abort();
  assert.equal(await started, "done");
});
