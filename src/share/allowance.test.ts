import assert from "node:assert/strict";
import test from "node:test";
import { ALLOWANCE_NOTE, relayAllowanceLines, remainingAllowanceLine } from "./allowance.js";

test("the remaining allowance is whole MiB and never negative", () => {
  assert.equal(remainingAllowanceLine(5 * 1048576), "5 MiB of relay allowance left this week (UTC).");
  assert.equal(remainingAllowanceLine(1048576 * 2.9), "2 MiB of relay allowance left this week (UTC).");
  assert.equal(remainingAllowanceLine(-10), "0 MiB of relay allowance left this week (UTC).");
});

test("both lines are printed when the usage is known, in the same words as service share", async () => {
  assert.deepEqual(await relayAllowanceLines(async () => 2048 * 1048576), ["2048 MiB of relay allowance left this week (UTC).", "Relayed traffic counts against your weekly relay allowance."]);
  assert.equal(ALLOWANCE_NOTE, "Relayed traffic counts against your weekly relay allowance.");
});

test("when the usage cannot be fetched only the note is printed, and the failure is not raised", async () => {
  assert.deepEqual(await relayAllowanceLines(async () => { throw new Error("HTTP 500"); }), [ALLOWANCE_NOTE]);
  assert.deepEqual(await relayAllowanceLines(async () => Number.NaN), [ALLOWANCE_NOTE]);
});
