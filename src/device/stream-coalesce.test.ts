import test from "node:test";
import assert from "node:assert/strict";
import { forwardCoalesced } from "./stream-coalesce.js";

type Step = { wait?: number; bytes?: number; fail?: boolean };

function readerOf(steps: Step[]) {
  let index = 0;
  return {
    async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      const step = steps[index++];
      if (!step) return { done: true, value: undefined };
      if (step.wait) await new Promise((resolve) => setTimeout(resolve, step.wait));
      if (step.fail) throw new Error("read failed");
      return { done: false, value: new Uint8Array(step.bytes ?? 1).fill(index) };
    },
  };
}

async function run(steps: Step[], options?: { maxBytes?: number; windowMs?: number }, cancelAfter = Infinity) {
  const sent: number[] = [];
  let cancelled = false;
  let completed: boolean | undefined;
  let error: string | undefined;
  try { completed = await forwardCoalesced(readerOf(steps), async (piece) => { sent.push(piece.byteLength); if (sent.length >= cancelAfter) cancelled = true; }, () => cancelled, options); }
  catch (caught) { error = (caught as Error).message; }
  return { sent, completed, error };
}

test("coalesce sends the first read at once and merges the rest into one flush at stream end", async () => {
  const { sent, completed } = await run([{ bytes: 10 }, { bytes: 20 }, { bytes: 30 }], { windowMs: 1000 });
  assert.deepEqual(sent, [10, 50]);
  assert.equal(completed, true);
});

test("coalesce flushes when the buffer reaches the byte limit", async () => {
  const { sent } = await run([{ bytes: 5 }, { bytes: 600 }, { bytes: 600 }, { bytes: 7 }], { maxBytes: 1000, windowMs: 1000 });
  assert.deepEqual(sent, [5, 1200, 7]);
});

test("coalesce flushes buffered bytes when the window expires while the next read is slow", async () => {
  const { sent } = await run([{ bytes: 5 }, { bytes: 8 }, { wait: 150, bytes: 9 }], { windowMs: 20 });
  assert.deepEqual(sent, [5, 8, 9]);
});

test("coalesce splits oversized reads into 256 KiB pieces", async () => {
  const { sent } = await run([{ bytes: 600 * 1024 }]);
  assert.deepEqual(sent, [256 * 1024, 256 * 1024, 88 * 1024]);
});

test("coalesce drops buffered bytes on cancel and reports not completed", async () => {
  const { sent, completed } = await run([{ bytes: 5 }, { bytes: 8 }, { bytes: 9 }], { windowMs: 1000 }, 1);
  assert.deepEqual(sent, [5]);
  assert.equal(completed, false);
});

test("coalesce flushes buffered bytes before rethrowing a read error", async () => {
  const { sent, error } = await run([{ bytes: 5 }, { bytes: 8 }, { fail: true }], { windowMs: 1000 });
  assert.deepEqual(sent, [5, 8]);
  assert.equal(error, "read failed");
});
