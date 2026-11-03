import assert from "node:assert/strict";
import test from "node:test";
import { isValidTimezone, nextCronTime, parseCron } from "./cron.js";

const next = (expr: string, zone: string, after: string): string | undefined => {
  const at = nextCronTime(parseCron(expr), zone, Date.parse(after));
  return at === undefined ? undefined : new Date(at).toISOString();
};

test("every five minutes", () => {
  assert.equal(next("*/5 * * * *", "UTC", "2026-11-03T10:02:30Z"), "2026-11-03T10:05:00.000Z");
  assert.equal(next("*/5 * * * *", "UTC", "2026-11-03T10:05:00Z"), "2026-11-03T10:10:00.000Z");
});

test("weekly on Monday 09:00 in Shanghai", () => {
  // 2026-11-03 is a Tuesday; 09:00 +08:00 is 01:00Z.
  assert.equal(next("0 9 * * 1", "Asia/Shanghai", "2026-11-03T00:00:00Z"), "2026-11-09T01:00:00.000Z");
  assert.equal(next("0 9 * * 1", "Asia/Shanghai", "2026-11-09T01:00:00Z"), "2026-11-16T01:00:00.000Z");
});

test("lists, ranges, steps and Sunday as 0 or 7", () => {
  assert.equal(next("30 8-10/2 * * 0", "UTC", "2026-11-03T00:00:00Z"), "2026-11-08T08:30:00.000Z");
  assert.equal(next("0 0 * * 7", "UTC", "2026-11-03T00:00:00Z"), "2026-11-08T00:00:00.000Z");
  assert.equal(next("0,30 12 3 11 *", "UTC", "2026-11-03T12:00:00Z"), "2026-11-03T12:30:00.000Z");
});

test("day of month and day of week combine with OR when both are restricted", () => {
  // The 15th or any Friday: 2026-11-04 is a Wednesday, the next Friday is the 6th.
  assert.equal(next("0 0 15 * 5", "UTC", "2026-11-04T00:00:00Z"), "2026-11-06T00:00:00.000Z");
});

test("daylight saving: a time in the spring gap is skipped that day, an autumn repeat runs once", () => {
  // America/New_York 2026-03-08 02:30 does not exist; the next real 02:30 is the 9th (EDT, UTC-4 => 06:30Z).
  assert.equal(next("30 2 * * *", "America/New_York", "2026-03-08T00:00:00Z"), "2026-03-09T06:30:00.000Z");
  // 2026-11-01 01:30 happens twice; the first one is EDT (05:30Z).
  assert.equal(next("30 1 * * *", "America/New_York", "2026-11-01T00:00:00Z"), "2026-11-01T05:30:00.000Z");
});

test("impossible schedules return undefined and bad ones throw", () => {
  assert.equal(next("0 0 31 2 *", "UTC", "2026-11-03T00:00:00Z"), undefined);
  assert.throws(() => parseCron("* * * *"), /five cron fields/);
  assert.throws(() => parseCron("61 * * * *"), /out of range/);
  assert.throws(() => parseCron("*/0 * * * *"), /step/);
  assert.equal(isValidTimezone("Asia/Shanghai"), true);
  assert.equal(isValidTimezone("Mars/Base"), false);
});
