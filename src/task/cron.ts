/**
 * Five-field cron (`minute hour day-of-month month day-of-week`) evaluated in an IANA time zone, backed by croner.
 * As in classic cron, when both day-of-month and day-of-week are restricted a day matches if either does.
 * This file only enforces the product rules (exactly five fields, valid zone); scheduling math is croner's.
 */
import { Cron } from "croner";

export interface CronSpec {
  readonly expression: string;
}

export function parseCron(expression: string): CronSpec {
  const normalized = expression.trim();
  if (normalized.split(/\s+/u).length !== 5) throw new Error("A schedule needs five cron fields: minute hour day-of-month month day-of-week.");
  try {
    new Cron(normalized, { paused: true });
  } catch (error) {
    throw new Error(`Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { expression: normalized };
}

export function isValidTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); return true; } catch { return false; }
}

/** The first run strictly after `afterMs`, or undefined when the schedule never runs again (for example `0 0 31 2 *`). */
export function nextCronTime(spec: CronSpec, timezone: string, afterMs: number): number | undefined {
  const next = new Cron(spec.expression, { timezone, paused: true }).nextRun(new Date(afterMs));
  return next === null ? undefined : next.getTime();
}
