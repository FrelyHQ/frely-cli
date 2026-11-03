/**
 * Five-field cron (`minute hour day-of-month month day-of-week`) evaluated in an IANA time zone.
 * Fields take `*`, numbers, `a-b` ranges, `a,b` lists and `/step`. Day of week is 0-7 (0 and 7 are Sunday).
 * As in classic cron, when both day-of-month and day-of-week are restricted a day matches if either does.
 */
export interface CronSpec {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  readonly anyDay: boolean;
  readonly anyWeekday: boolean;
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

export function parseCron(expression: string): CronSpec {
  const parts = expression.trim().split(/\s+/u);
  if (parts.length !== 5) throw new Error("A schedule needs five cron fields: minute hour day-of-month month day-of-week.");
  const sets = parts.map((part, index) => parseField(part, FIELDS[index]!));
  const weekdays = new Set([...sets[4]!].map((value) => value % 7));
  return {
    minutes: sets[0]!, hours: sets[1]!, days: sets[2]!, months: sets[3]!, weekdays,
    anyDay: parts[2] === "*" || parts[2]!.startsWith("*/") && parts[2]!.endsWith("/1"),
    anyWeekday: parts[4] === "*",
  };
}

function parseField(text: string, field: { name: string; min: number; max: number }): Set<number> {
  const out = new Set<number>();
  for (const item of text.split(",")) {
    const [rangeText, stepText, extra] = item.split("/");
    if (extra !== undefined || rangeText === undefined || rangeText === "") throw new Error(`Invalid ${field.name} field: ${JSON.stringify(text)}.`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in ${field.name} field: ${JSON.stringify(text)}.`);
    let from: number;
    let to: number;
    if (rangeText === "*") { from = field.min; to = field.max; }
    else if (rangeText.includes("-")) {
      const [a, b, more] = rangeText.split("-");
      if (more !== undefined) throw new Error(`Invalid ${field.name} field: ${JSON.stringify(text)}.`);
      from = Number(a); to = Number(b);
    } else {
      from = Number(rangeText);
      to = stepText === undefined ? from : field.max;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < field.min || to > field.max || from > to) throw new Error(`Value out of range in ${field.name} field: ${JSON.stringify(text)}.`);
    for (let value = from; value <= to; value += step) out.add(value);
  }
  return out;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let found = formatters.get(timezone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timezone, found);
  }
  return found;
}

export function isValidTimezone(timezone: string): boolean {
  try { formatter(timezone); return true; } catch { return false; }
}

interface Local { year: number; month: number; day: number; hour: number; minute: number }

function localParts(timezone: string, utcMs: number): Local {
  const values: Record<string, number> = {};
  for (const part of formatter(timezone).formatToParts(new Date(utcMs))) if (part.type !== "literal") values[part.type] = Number(part.value);
  return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute! };
}

function offsetMs(timezone: string, utcMs: number): number {
  const local = localParts(timezone, utcMs);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - Math.floor(utcMs / 60_000) * 60_000;
}

/** The instant a wall-clock time occurs in `timezone`, or undefined when that time does not exist (a daylight-saving gap). */
function zonedToUtc(timezone: string, local: Local): number | undefined {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  let guess = naive - offsetMs(timezone, naive);
  guess = naive - offsetMs(timezone, guess);
  const back = localParts(timezone, guess);
  return back.year === local.year && back.month === local.month && back.day === local.day && back.hour === local.hour && back.minute === local.minute ? guess : undefined;
}

function dayMatches(spec: CronSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.has(month)) return false;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const byDay = spec.days.has(day);
  const byWeekday = spec.weekdays.has(weekday);
  if (spec.anyDay && spec.anyWeekday) return true;
  if (spec.anyDay) return byWeekday;
  if (spec.anyWeekday) return byDay;
  return byDay || byWeekday;
}

/** The first matching minute strictly after `afterMs`, or undefined when none exists within five years (for example `0 0 31 2 *`). */
export function nextCronTime(spec: CronSpec, timezone: string, afterMs: number): number | undefined {
  const start = localParts(timezone, afterMs);
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day));
  const hours = [...spec.hours].sort((a, b) => a - b);
  const minutes = [...spec.minutes].sort((a, b) => a - b);
  for (let step = 0; step < 366 * 5; step += 1, cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();
    if (!dayMatches(spec, year, month, day)) continue;
    let best: number | undefined;
    for (const hour of hours) {
      for (const minute of minutes) {
        const at = zonedToUtc(timezone, { year, month, day, hour, minute });
        if (at !== undefined && at > afterMs && (best === undefined || at < best)) best = at;
      }
    }
    if (best !== undefined) return best;
  }
  return undefined;
}
