import type { ShareLocalProviderInput, ShareLocalProviderResult } from "../provider/share.js";
import { LocalModelAuthError, type LocalEndpointProbe } from "../provider/local.js";
import { isLanBaseUrl, normalizeLocalOpenAiBaseUrl } from "../provider/state.js";

export interface ModelShareOptions {
  readonly driver: "ollama" | "openai-compatible";
  readonly url?: string;
  readonly models?: readonly string[];
  readonly name?: string;
  readonly slot?: string;
  readonly creator: boolean;
  readonly keyStdin: boolean;
  /** A driver word was typed, so the default ports are not probed. */
  readonly explicitDriver?: boolean;
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
    ...(driver === undefined ? {} : { explicitDriver: true }),
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
  /** Looks for model servers on this computer's usual ports. */
  probe?(): Promise<readonly LocalEndpointProbe[]>;
  /** A person is at the terminal and can be asked. */
  interactive?: boolean;
  /** Asks a question at the terminal and returns the answer. */
  ask?(question: string): Promise<string>;
  /** Asks for a secret at the terminal without echoing it. */
  askSecret?(question: string): Promise<string>;
}

/** Picks the endpoint to share when `--url` was not given: the one that answers, or the person's choice among several. `undefined` keeps the driver's default URL. */
async function chooseEndpoint(options: ModelShareOptions, io: ModelShareIo, deps: ModelShareDeps): Promise<string | undefined> {
  if (options.url !== undefined || options.driver !== "ollama" || options.explicitDriver || !deps.probe) return undefined;
  const found = await deps.probe();
  if (found.length === 0) return undefined;
  const describe = (item: LocalEndpointProbe) => `${item.url}  ${item.authRequired ? "(needs an API key)" : (item.models ?? []).slice(0, 3).join(", ")}`;
  if (found.length === 1) { io.write(`Found ${describe(found[0]!)}\n`); return found[0]!.url; }
  if (!deps.interactive || !deps.ask) throw new Error(`Several model servers answer here:\n${found.map((item) => `  ${describe(item)}`).join("\n")}\nRun again with --url <one of them>.`);
  io.write(`Model servers on this computer:\n${found.map((item, index) => `  ${index + 1}. ${describe(item)}`).join("\n")}\n`);
  const answer = Number((await deps.ask(`Share which one (1-${found.length})? `)).trim());
  const picked = found[answer - 1];
  if (!Number.isInteger(answer) || !picked) throw new Error("Not shared: no server was chosen.");
  return picked.url;
}

/** Shares models from this computer and returns the AccessPoints they are sold and planned through. */
export async function shareModel(options: ModelShareOptions, io: ModelShareIo, deps: ModelShareDeps): Promise<number> {
  const log = (text: string) => { if (!options.json) io.write(text); };
  let lan = false;
  const url = options.url ?? await chooseEndpoint(options, io, deps);
  if (url !== undefined) {
    const normalized = normalizeLocalOpenAiBaseUrl(url);
    if (isLanBaseUrl(normalized)) { await deps.confirmLan(normalized); lan = true; }
  }
  let key = options.keyStdin ? await deps.readSecret() : undefined;
  const run = () => deps.share({
    driver: options.driver,
    ...(url === undefined ? {} : { url }), ...(options.models ? { models: [...options.models] } : {}), ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.slot === undefined ? {} : { slot: options.slot }), creator: options.creator, accessPoints: true,
    ...(lan ? { lan: true } : {}), ...(key ? { key } : {}), ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
  }, log);
  let result: ShareLocalProviderResult;
  try { result = await run(); } catch (error) {
    if (!(error instanceof LocalModelAuthError) || key !== undefined) throw error;
    // The server wants a key: ask for it here, hidden, so it never passes through a command line, a log or an AI.
    if (!deps.interactive || !deps.askSecret || options.json) throw new Error(`${url ?? "The model server"} needs an API key. Run again with --key-stdin (pipe the key in), or in a terminal to be asked.`);
    key = await deps.askSecret(`${url ?? "This model server"} needs an API key. Paste it (nothing is shown): `);
    if (!key) throw new Error("Not shared: no key was given.");
    result = await run();
  }
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
