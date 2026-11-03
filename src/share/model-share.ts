import type { ShareLocalProviderInput, ShareLocalProviderResult } from "../provider/share.js";
import { isLanBaseUrl, normalizeLocalOpenAiBaseUrl } from "../provider/state.js";

export interface ModelShareOptions {
  readonly driver: "ollama" | "openai-compatible";
  readonly url?: string;
  readonly models?: readonly string[];
  readonly name?: string;
  readonly slot?: string;
  readonly creator: boolean;
  readonly keyStdin: boolean;
  readonly maxConcurrent?: number;
  readonly json: boolean;
}

export const MODEL_SHARE_USAGE = "frely service share model [ollama|openai-compatible] [--url <http://host:port/v1>] [--models <a,b>] [--name <text>] [--slot <slot-id> | --creator] [--key-stdin] [--max-concurrent <n>] [--json]";

/** `frely service share model ...` (also `--type model`); `args` are what follows `share`, with the type word already removed. */
export function parseModelShareArguments(args: readonly string[]): ModelShareOptions {
  let driver: string | undefined, url: string | undefined, models: string[] | undefined, name: string | undefined, slot: string | undefined, maxConcurrent: number | undefined;
  let creator = false, keyStdin = false, json = false;
  const take = (i: number, arg: string, flag: string): string => {
    const inline = arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : args[i + 1];
    if (inline === undefined || inline === "" || (!arg.includes("=") && inline.startsWith("-"))) throw new Error(`${flag} needs a value.\n${MODEL_SHARE_USAGE}`);
    return inline;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = arg.split("=")[0]!;
    const skip = !arg.includes("=");
    if (flag === "--url") { url = take(i, arg, flag); if (skip) i++; }
    else if (flag === "--models") { models = take(i, arg, flag).split(",").map((item) => item.trim()).filter(Boolean); if (skip) i++; }
    else if (flag === "--name") { name = take(i, arg, flag); if (skip) i++; }
    else if (flag === "--slot") { slot = take(i, arg, flag); if (skip) i++; }
    else if (flag === "--max-concurrent") {
      const text = take(i, arg, flag); if (skip) i++;
      maxConcurrent = Number(text);
      if (!/^\d+$/u.test(text) || maxConcurrent < 1 || maxConcurrent > 64) throw new Error("--max-concurrent must be 1 to 64.");
    }
    else if (arg === "--creator") creator = true;
    else if (arg === "--key-stdin") keyStdin = true;
    else if (arg === "--json") json = true;
    else if (!arg.startsWith("-") && driver === undefined) driver = arg;
    else throw new Error(`${arg.startsWith("-") ? "Unknown option" : "Unexpected argument"} ${arg}.\n${MODEL_SHARE_USAGE}`);
  }
  if (driver !== undefined && driver !== "ollama" && driver !== "openai-compatible") throw new Error(`The driver must be ollama or openai-compatible.\n${MODEL_SHARE_USAGE}`);
  if (creator && slot) throw new Error("Use either --slot or --creator, not both.");
  return {
    driver: driver === "openai-compatible" ? "openai-compatible" : "ollama",
    ...(url === undefined ? {} : { url }), ...(models?.length ? { models } : {}), ...(name === undefined ? {} : { name }), ...(slot === undefined ? {} : { slot }),
    creator, keyStdin, ...(maxConcurrent === undefined ? {} : { maxConcurrent }), json,
  };
}

/** Whether `args` (after `share`) ask for a model share: `model ...` or `--type model`. Returns the arguments without the type word. */
export function modelShareArguments(args: readonly string[]): string[] | undefined {
  if (args[0] === "model") return args.slice(1);
  const at = args.findIndex((arg) => arg === "--type" || arg.startsWith("--type="));
  if (at < 0) return undefined;
  const inline = args[at]!.startsWith("--type=");
  const type = inline ? args[at]!.slice(7) : args[at + 1];
  if (type !== "model") return undefined;
  return args.filter((_, index) => index !== at && (inline || index !== at + 1));
}

export interface ModelShareIo { write(text: string): void }

export interface ModelShareDeps {
  share(input: ShareLocalProviderInput, log: (text: string) => void): Promise<ShareLocalProviderResult>;
  /** The owner confirms a network address in a terminal; throws when they do not. */
  confirmLan(baseUrl: string): Promise<void>;
  readSecret(): Promise<string>;
}

/** Shares models from this computer and returns the AccessPoints they are sold and planned through. */
export async function shareModel(options: ModelShareOptions, io: ModelShareIo, deps: ModelShareDeps): Promise<number> {
  const log = (text: string) => { if (!options.json) io.write(text); };
  let lan = false;
  if (options.url !== undefined) {
    const normalized = normalizeLocalOpenAiBaseUrl(options.url);
    if (isLanBaseUrl(normalized)) { await deps.confirmLan(normalized); lan = true; }
  }
  const key = options.keyStdin ? await deps.readSecret() : undefined;
  const result = await deps.share({
    driver: options.driver,
    ...(options.url === undefined ? {} : { url: options.url }), ...(options.models ? { models: [...options.models] } : {}), ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.slot === undefined ? {} : { slot: options.slot }), creator: options.creator, accessPoints: true,
    ...(lan ? { lan: true } : {}), ...(key ? { key } : {}), ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
  }, log);
  if (options.json) {
    io.write(`${JSON.stringify({ share: result.provider.providerId, models: result.provider.models, slot: result.slot, resumed: result.resumed, accessPoints: result.accessPoints, ...(result.accessPointNote ? { note: result.accessPointNote } : {}) })}\n`);
    return 0;
  }
  io.write(`Models: ${result.provider.models.join(", ")}\n`);
  if (result.accessPoints.length > 0) {
    for (const item of result.accessPoints) io.write(`AccessPoint: ${item.name}  (${item.model})\n`);
    io.write("Each AccessPoint is priced 0 and callable by you right now. Set a price and put it in a Plan in Frely > Access Points to sell it. This computer must stay online while others use it.\n");
  } else {
    io.write("No AccessPoint was made for these models. They are still callable by you under your own call names (<your username>/<model>).\n");
  }
  if (result.accessPointNote) io.write(`${result.accessPointNote}\n`);
  return 0;
}
