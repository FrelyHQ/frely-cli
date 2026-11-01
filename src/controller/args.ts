import { ControllerError, EXIT } from "./client.js";

export interface Target { device: string | null; path: string }

/**
 * `device:path`, written like scp. A single letter followed by `:\` or `:/` is a Windows drive on this computer, and a path without a colon
 * names no device; the caller decides whether that is allowed.
 */
export function parseTarget(value: string): Target {
  if (/^[A-Za-z]:[\\/]/u.test(value)) return { device: null, path: value };
  const colon = value.indexOf(":");
  if (colon <= 0) return { device: null, path: value };
  return { device: value.slice(0, colon), path: value.slice(colon + 1) || "." };
}

export function requireRemote(value: string | undefined, what = "a path"): { device: string; path: string } {
  if (!value) throw new ControllerError(`Give ${what} as <device>:<path>.`, EXIT.cli);
  const target = parseTarget(value);
  if (!target.device) throw new ControllerError(`"${value}" names no device. Write it as <device>:<path>.`, EXIT.cli);
  return { device: target.device, path: target.path };
}

export interface ParsedArgs { positionals: string[]; flags: Set<string>; values: Map<string, string>; /** Everything after `--`. */ rest: string[] }

/** Splits arguments into positionals, flags and `--name value` options; anything else starting with `--` is an error. */
export function parseArgs(args: readonly string[], spec: { flags?: readonly string[]; values?: readonly string[] }): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], flags: new Set(), values: new Map(), rest: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") { parsed.rest = args.slice(i + 1); break; }
    if (!arg.startsWith("--")) { parsed.positionals.push(arg); continue; }
    if (spec.flags?.includes(arg)) { parsed.flags.add(arg); continue; }
    if (spec.values?.includes(arg)) {
      const value = args[++i];
      if (value === undefined) throw new ControllerError(`${arg} needs a value.`, EXIT.cli);
      if (parsed.values.has(arg)) throw new ControllerError(`${arg} was given twice.`, EXIT.cli);
      parsed.values.set(arg, value);
      continue;
    }
    throw new ControllerError(`Unknown option ${arg}.`, EXIT.cli);
  }
  return parsed;
}

export function intOption(parsed: ParsedArgs, name: string, min: number, max: number): number | undefined {
  const raw = parsed.values.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new ControllerError(`${name} must be a whole number from ${min} to ${max}.`, EXIT.cli);
  return value;
}
