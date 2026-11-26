import { noteFields } from "./bitwarden.js";

/**
 * `process` with `vaultItem`: the fields of one Bitwarden secure note become environment variables of the command, read by the service
 * that holds the unlocked vault. The values are never in the tool arguments or result: the command's output has each value replaced with
 * `***` before it is returned. A command that prints a value on purpose in another form (base64, split) is not stopped; this keeps values
 * out of normal output and off disk, it is not a credential proxy.
 */
export interface VaultEnv { env: Record<string, string>; secrets: readonly string[] }

/** Values shorter than this are not replaced in output: "1" or "yes" would garble everything and hide nothing. */
export const MIN_HIDDEN_LENGTH = 4;
const HOSTED_AGENT = "hosted-agent";

/** The environment for a `process` run or start that names a vault note, or undefined when the call has no `vaultItem`. */
export async function vaultEnvFor(tool: string, args: Record<string, unknown>, meta: unknown, read: (name: string) => Promise<Record<string, string>> = noteFields): Promise<VaultEnv | undefined> {
  if (args.vaultItem === undefined) return undefined;
  const starts = tool === "run_command" || tool === "start_process" || (tool === "process" && (args.action === "run" || args.action === "start"));
  if (!starts) throw new Error("vaultItem works only with process action run or start.");
  if (typeof args.vaultItem !== "string" || !args.vaultItem.trim() || args.vaultItem.length > 100 || /[\r\n]/u.test(args.vaultItem)) throw new Error("vaultItem must be the name of a secure note in the Bitwarden vault.");
  // The relay refuses this already; the device checks again so an Agent never reaches the owner's vault.
  if (meta && typeof meta === "object" && (meta as Record<string, unknown>)["frely/origin"] === HOSTED_AGENT) throw new Error("vaultItem is not available to Agents: only the owner's own connections can use the Bitwarden vault. Nothing was run.");
  const env = await read(args.vaultItem.trim());
  return { env, secrets: [...new Set(Object.values(env).filter((value) => value.length >= MIN_HIDDEN_LENGTH))].sort((a, b) => b.length - a.length) };
}

/** Replaces every secret in every string of a result (longest first, so one value inside another is still covered). */
export function hideSecrets<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value;
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return secrets.reduce((text, secret) => text.split(secret).join("***"), item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype) return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]));
    return item;
  };
  return walk(value) as T;
}
