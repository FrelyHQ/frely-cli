import { spawn } from "node:child_process";
import { lstat, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { intOption, parseArgs, parseTarget, requireRemote, type ParsedArgs } from "./args.js";
import { downloadToLocalFile, prepareLocalUpload, type LocalUpload } from "../local-transfer.js";
import { waitForApproval, type ApprovalRef, type ApprovalWaitOptions } from "./approval-wait.js";
import { openController, outcomeOf, resultData, resultText, ControllerError, EXIT, type Controller, type Outcome, type ToolResult } from "./client.js";

export const CONTROLLER_COMMANDS: ReadonlySet<string> = new Set(["devices", "run", "ps", "logs", "kill", "read", "ls", "grep", "edit", "put", "get", "files", "tools", "call", "permission"]);
export interface Output { out(text: string): void; err(text: string): void }

export const CONTROLLER_USAGE = `Control your Frely devices from this computer.
  frely devices [--add]                          List devices, whether they are online, and their workspaces
  frely run <device> [--cwd <dir>] [--timeout <s>] [--background] -- <command>
  frely ps <device>                              Background commands on the device
  frely logs <device> <id> [--follow]            Output of a background command
  frely kill <device> <id>                       Stop a background command
  frely read <device>:<path> [--lines a:b]       Print a file
  frely ls [<device>:<path>]                     List a folder (no argument: the workspace roots)
  frely grep <device>:<path> <text> [--regex] [--case] [--max <n>]
  frely edit <device>:<path> (--from <local file> | --patch <json file>) [--overwrite]
  frely permission request <device> --resource <name> --reason <text> --command <text> [--cwd <dir>] [--mode once|window|authorization]
  frely permission confirm <code> [A|B|C]        Finish an approval by authenticator or emailed code
  frely permission wait <short code> [--then '<command>'] [--timeout <s>]
  frely put <local file | device:path> [--json]  Share a file or image as a link (https://frely.cloud/f/<code>); prints the link first
  frely get <id> [<local path> | <device>:<path>] [--overwrite]   Fetch a shared file to this computer or a device
  frely files                                    List shared files (id, name, size, visibility, expiry, link)
  frely files rm <id>                            Delete a shared file
  frely files share <id> --scope self|team|link  Who can open the link
  frely tools [--json]                           What the server offers, with its own instructions
  frely call <tool> [--json '<object>' | --input <file>]   Any tool by name

Every command takes --json (the full result) and --out <file> (write the output there).
A device is its name or id from "frely devices". A path on this computer is not accepted where <device>:<path> is expected.
Exit codes: 0 done, 1 this CLI (usage, local file), 2 the tool or the remote command failed, 3 approval needed (the output has the link
and the "frely permission wait" command), 4 not signed in (run \`frely login\`), 5 device offline, 6 limit reached.
`;

const MAX_LOCAL_FILE = 1024 * 1024;
const isInteractive = () => process.stdin.isTTY === true && process.stderr.isTTY === true;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** What a command shows: the text a person reads, the full tool result for --json, and the remote exit status when there is one. */
interface Shown { text: string; result: ToolResult; remoteExit?: number }

async function emit(shown: Shown, outcome: Outcome, parsed: ParsedArgs, io: Output): Promise<number> {
  const body = parsed.flags.has("--json") ? JSON.stringify(shown.result, null, 2) : shown.text;
  const file = parsed.values.get("--out");
  if (file !== undefined) {
    await writeFile(file, body.endsWith("\n") ? body : body + "\n");
    io.out(`Wrote ${Buffer.byteLength(body)} bytes to ${file}\n`);
  } else io.out(body === "" || body.endsWith("\n") ? body : body + "\n");
  if (outcome.note) io.err(outcome.note + "\n");
  if (outcome.exitCode !== EXIT.ok) return outcome.exitCode;
  if (shown.remoteExit !== undefined && shown.remoteExit !== 0) { io.err(`The command ended with exit code ${shown.remoteExit}.\n`); return EXIT.tool; }
  return EXIT.ok;
}

const asText = (value: unknown): string => typeof value === "string" ? value : "";

/** The output of a `process` or `read` result as the command itself would have printed it. */
function shownOf(result: ToolResult): Shown {
  const data = resultData(result);
  if (data && (typeof data.stdout === "string" || typeof data.stderr === "string")) {
    const text = asText(data.stdout) + (asText(data.stderr) ? (asText(data.stdout) && !asText(data.stdout).endsWith("\n") ? "\n" : "") + asText(data.stderr) : "");
    const exitCode = typeof data.exitCode === "number" ? data.exitCode : undefined;
    return { text, result, ...(exitCode !== undefined ? { remoteExit: exitCode } : {}) };
  }
  if (data && typeof data.content === "string" && data.encoding === undefined) return { text: data.content, result };
  return { text: resultText(result) || (data ? JSON.stringify(data, null, 2) : ""), result };
}

let openIt: typeof openController = openController;
/** Tests replace the connection with a fake; returns the function that puts the real one back. */
export function useControllerOpener(replacement: typeof openController): () => void {
  const previous = openIt;
  openIt = replacement;
  return () => { openIt = previous; };
}

async function withController<T>(io: Output, work: (controller: Controller) => Promise<T>): Promise<T> {
  const controller = await openIt();
  try { return await work(controller); } finally { await controller.close().catch(() => undefined); }
}

const COMMON_FLAGS = ["--json"] as const;
const COMMON_VALUES = ["--out"] as const;

async function readLocal(path: string, what: string): Promise<Buffer> {
  const info = await stat(path).catch(() => { throw new ControllerError(`${what} ${path} was not found.`, EXIT.cli); });
  if (!info.isFile()) throw new ControllerError(`${what} ${path} is not a file.`, EXIT.cli);
  if (info.size > MAX_LOCAL_FILE) throw new ControllerError(`${what} ${path} is larger than 1 MiB.`, EXIT.cli);
  return readFile(path);
}

export async function runControllerCommand(args: readonly string[], io: Output): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command === undefined || rest.includes("--help") || rest.includes("-h")) { io.out(CONTROLLER_USAGE); return EXIT.ok; }
    switch (command) {
      case "permission": return await permissionCommand(rest, io);
      case "devices": return await devices(rest, io);
      case "run": return await run(rest, io);
      case "ps": return await ps(rest, io);
      case "logs": return await logs(rest, io);
      case "kill": return await kill(rest, io);
      case "read": return await readCommand(rest, io);
      case "ls": return await ls(rest, io);
      case "grep": return await grep(rest, io);
      case "edit": return await edit(rest, io);
      case "put": return await putCommand(rest, io);
      case "get": return await getCommand(rest, io);
      case "files": return await filesCommand(rest, io);
      case "tools": return await toolsCommand(rest, io);
      case "call": return await callCommand(rest, io);
      default: throw new ControllerError(`Unknown command ${command}.\n${CONTROLLER_USAGE}`, EXIT.cli);
    }
  } catch (error) {
    if (error instanceof ControllerError) { io.err(error.message + "\n"); return error.exitCode; }
    throw error;
  }
}

async function devices(args: string[], io: Output): Promise<number> {
  const parsed = parseArgs(args, { flags: [...COMMON_FLAGS, "--add"], values: COMMON_VALUES });
  return withController(io, async (controller) => {
    const result = await controller.call("list_devices", parsed.flags.has("--add") ? { addDevice: true } : {});
    const outcome = outcomeOf(result);
    const data = resultData(result);
    const list = Array.isArray(data?.devices) ? data.devices as Array<Record<string, unknown>> : null;
    let text = resultText(result);
    if (list) {
      const rows = list.map((device) => `${asText(device.name) || asText(device.id)}\t${device.online === true ? "online" : "offline"}\t${asText(device.mcp)}\t${Array.isArray(device.workspaces) ? (device.workspaces as unknown[]).join(", ") : "-"}`);
      text = ["NAME\tSTATE\tMCP\tWORKSPACES", ...rows].join("\n") + (typeof data?.setup === "string" ? `\n\n${data.setup}` : "");
    }
    return emit({ text, result }, outcome, parsed, io);
  });
}

async function toolCall(io: Output, parsed: ParsedArgs, name: string, input: Record<string, unknown>): Promise<number> {
  return withController(io, async (controller) => {
    const result = await controller.call(name, input);
    return emit(shownOf(result), outcomeOf(result), parsed, io);
  });
}

async function run(args: string[], io: Output): Promise<number> {
  const parsed = parseArgs(args, { flags: [...COMMON_FLAGS, "--background"], values: [...COMMON_VALUES, "--cwd", "--timeout"] });
  const [device] = parsed.positionals;
  if (!device || parsed.positionals.length !== 1 || parsed.rest.length === 0) throw new ControllerError("Usage: frely run <device> [--cwd <dir>] [--timeout <s>] [--background] -- <command>", EXIT.cli);
  const timeout = intOption(parsed, "--timeout", 1, 120);
  const background = parsed.flags.has("--background");
  return toolCall(io, parsed, "process", {
    device, action: background ? "start" : "run", command: parsed.rest.join(" "), ...(parsed.values.has("--cwd") ? { cwd: parsed.values.get("--cwd") } : {}),
    ...(timeout !== undefined && !background ? { timeoutMs: timeout * 1000 } : {}),
  });
}

async function ps(args: string[], io: Output): Promise<number> {
  const parsed = parseArgs(args, { flags: COMMON_FLAGS, values: COMMON_VALUES });
  if (parsed.positionals.length !== 1) throw new ControllerError("Usage: frely ps <device>", EXIT.cli);
  return toolCall(io, parsed, "process", { device: parsed.positionals[0], action: "list" });
}

async function kill(args: string[], io: Output): Promise<number> {
  const parsed = parseArgs(args, { flags: COMMON_FLAGS, values: COMMON_VALUES });
  if (parsed.positionals.length !== 2) throw new ControllerError("Usage: frely kill <device> <id>", EXIT.cli);
  return toolCall(io, parsed, "process", { device: parsed.positionals[0], action: "stop", processId: parsed.positionals[1] });
}

async function logs(args: string[], io: Output): Promise<number> {
  const parsed = parseArgs(args, { flags: [...COMMON_FLAGS, "--follow"], values: COMMON_VALUES });
  if (parsed.positionals.length !== 2) throw new ControllerError("Usage: frely logs <device> <id> [--follow]", EXIT.cli);
  const [device, processId] = parsed.positionals as [string, string];
  const follow = parsed.flags.has("--follow");
  return withController(io, async (controller) => {
    let stdoutCursor = 0, stderrCursor = 0;
    for (;;) {
      const result = await controller.call("process", { device, action: "read", processId, stdoutCursor, stderrCursor });
      const outcome = outcomeOf(result);
      const data = resultData(result);
      if (!follow || outcome.exitCode !== EXIT.ok || !data) return emit(shownOf(result), outcome, parsed, io);
      const out = asText(data.stdout), err = asText(data.stderr);
      if (out) io.out(out);
      if (err) io.err(err);
      stdoutCursor = typeof data.stdoutCursor === "number" ? data.stdoutCursor : stdoutCursor;
      stderrCursor = typeof data.stderrCursor === "number" ? data.stderrCursor : stderrCursor;
      if (data.running === false) return typeof data.exitCode === "number" && data.exitCode !== 0 ? EXIT.tool : EXIT.ok;
      await sleep(1000);
    }
  });
}

async function readCommand(args: string[], io: Output): Promise<number> {
  const parsed = parseArgs(args, { flags: COMMON_FLAGS, values: [...COMMON_VALUES, "--lines"] });
  if (parsed.positionals.length !== 1) throw new ControllerError("Usage: frely read <device>:<path> [--lines a:b]", EXIT.cli);
  const { device, path } = requireRemote(parsed.positionals[0]);
  let range: Record<string, number> = {};
  const lines = parsed.values.get("--lines");
  if (lines !== undefined) {
    const match = /^(\d+):(\d*)$/u.exec(lines);
    if (!match || Number(match[1]) < 1) throw new ControllerError("--lines must look like 10:40 (or 10: for the rest of the file).", EXIT.cli);
    range = { startLine: Number(match[1]), ...(match[2] ? { endLine: Number(match[2]) } : {}) };
  }
  return toolCall(io, parsed, "read", { device, action: "read", path, ...range });
}

async function ls(args: string[], io: Output): Promise<number> {
  const parsed = parseArgs(args, { flags: COMMON_FLAGS, values: COMMON_VALUES });
  if (parsed.positionals.length > 1) throw new ControllerError("Usage: frely ls [<device>:<path>]", EXIT.cli);
  const [target] = parsed.positionals;
  if (target !== undefined && !target.includes(":")) return toolCall(io, parsed, "read", { device: target, action: "roots" });
  const { device, path } = requireRemote(target);
  return toolCall(io, parsed, "read", { device, action: "list", path });
}

async function grep(args: string[], io: Output): Promise<number> {
  const parsed = parseArgs(args, { flags: [...COMMON_FLAGS, "--regex", "--case"], values: [...COMMON_VALUES, "--max", "--context"] });
  if (parsed.positionals.length !== 2) throw new ControllerError("Usage: frely grep <device>:<path> <text> [--regex] [--case] [--max <n>] [--context <n>]", EXIT.cli);
  const { device, path } = requireRemote(parsed.positionals[0]);
  const max = intOption(parsed, "--max", 1, 1000), context = intOption(parsed, "--context", 0, 10);
  return toolCall(io, parsed, "read", {
    device, action: "search", path, query: parsed.positionals[1], regex: parsed.flags.has("--regex"), caseSensitive: parsed.flags.has("--case"),
    ...(max !== undefined ? { maxResults: max } : {}), ...(context !== undefined ? { contextLines: context } : {}),
  });
}

async function edit(args: string[], io: Output): Promise<number> {
  const parsed = parseArgs(args, { flags: [...COMMON_FLAGS, "--overwrite"], values: [...COMMON_VALUES, "--from", "--patch"] });
  if (parsed.positionals.length !== 1) throw new ControllerError("Usage: frely edit <device>:<path> (--from <local file> | --patch <json file>) [--overwrite]", EXIT.cli);
  const { device, path } = requireRemote(parsed.positionals[0]);
  const from = parsed.values.get("--from"), patch = parsed.values.get("--patch");
  if ((from === undefined) === (patch === undefined)) throw new ControllerError("Give exactly one of --from <local file> or --patch <json file>.", EXIT.cli);
  let input: Record<string, unknown>;
  if (from !== undefined) {
    const data = await readLocal(from, "The file");
    let text: string | null = null;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { /* Sent as binary below. */ }
    input = { device, path, ...(text !== null ? { content: text } : { contentBase64: data.toString("base64") }), overwrite: parsed.flags.has("--overwrite") };
  } else {
    let edits: unknown;
    try { edits = JSON.parse((await readLocal(patch!, "The patch")).toString("utf8")); } catch (error) { if (error instanceof ControllerError) throw error; throw new ControllerError(`The patch ${patch} is not valid JSON.`, EXIT.cli); }
    if (!Array.isArray(edits) || edits.length === 0) throw new ControllerError("The patch must be a JSON array of { startLine, endLine, replacement }.", EXIT.cli);
    input = { device, path, edits };
  }
  return toolCall(io, parsed, "edit_file", input);
}

/** Test seam: replaces the HTTP upload and download of local files. Never set in production. */
let transferIo = { prepare: prepareLocalUpload, download: downloadToLocalFile };
export function useTransferIo(replacement: Partial<typeof transferIo>): () => void {
  const previous = transferIo;
  transferIo = { ...transferIo, ...replacement };
  return () => { transferIo = previous; };
}

export const SHARE_SCOPES = ["self", "team", "link"] as const;
const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const sizeText = (bytes: number | undefined) => bytes === undefined ? "-" : bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`;

/** One transfer call; a result that is not plain success is shown as the other commands show it, and the exit code is returned instead of the data. */
async function transferStep(controller: Controller, input: Record<string, unknown>, parsed: ParsedArgs, io: Output): Promise<{ data: Record<string, unknown> } | { code: number }> {
  const result = await controller.call("transfer", input);
  const outcome = outcomeOf(result);
  const data = resultData(result);
  if (outcome.exitCode !== EXIT.ok || !data) return { code: await emit(shownOf(result), outcome.exitCode !== EXIT.ok ? outcome : { exitCode: EXIT.tool, note: "The transfer service answered without data." }, parsed, io) };
  return { data };
}

/** The part of a transfer view the commands print. The presigned upload and download addresses are never part of it. */
function viewOf(data: Record<string, unknown>): Record<string, unknown> {
  const view = (data.transfer && typeof data.transfer === "object" ? data.transfer : data) as Record<string, unknown>;
  return { url: view.url ?? null, id: view.id ?? null, name: view.name ?? null, bytes: view.bytes ?? null, expiresAt: view.expiresAt ?? null, visibility: view.visibility ?? null };
}

function showView(view: Record<string, unknown>): Shown {
  const text = [asText(view.url) || asText(view.id), `id: ${asText(view.id)}`, `name: ${asText(view.name)}`, `size: ${sizeText(num(view.bytes))}`, `expires: ${asText(view.expiresAt) || "-"}`, `visibility: ${asText(view.visibility) || "-"}`].join("\n");
  return { text, result: view as ToolResult };
}

function presigned(data: Record<string, unknown>, key: "upload" | "download"): { url: string; method?: string; headers?: Record<string, string> } {
  const part = data[key] as { url?: unknown; method?: unknown; headers?: unknown } | undefined;
  if (!part || typeof part.url !== "string") throw new ControllerError(`The transfer service gave no ${key} address.`, EXIT.tool);
  const headers = part.headers && typeof part.headers === "object" ? Object.fromEntries(Object.entries(part.headers as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined;
  return { url: part.url, ...(typeof part.method === "string" ? { method: part.method } : {}), ...(headers ? { headers } : {}) };
}

/** A failure of the local file or the storage service, without the presigned address that may be in the library's message. */
function transferFailure(error: unknown, exitCode: number): ControllerError {
  if (error instanceof ControllerError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ControllerError(message.replace(/https?:\/\/\S+/gu, "<address>"), exitCode);
}

async function putCommand(args: string[], io: Output): Promise<number> {
  const parsed = parseArgs(args, { flags: COMMON_FLAGS, values: COMMON_VALUES });
  if (parsed.positionals.length !== 1) throw new ControllerError("Usage: frely put <local file | device:path> [--json]", EXIT.cli);
  const target = parseTarget(parsed.positionals[0]!);
  return withController(io, async (controller) => {
    let data: Record<string, unknown>;
    if (target.device !== null) {
      const step = await transferStep(controller, { action: "send", device: target.device, path: target.path }, parsed, io);
      if ("code" in step) return step.code;
      data = step.data;
    } else {
      let local: LocalUpload;
      try { local = await transferIo.prepare(target.path); } catch (error) { throw transferFailure(error, EXIT.cli); }
      const prepared = local;
      const link = await transferStep(controller, { action: "upload_link", name: prepared.name, bytes: prepared.bytes, sha256: prepared.sha256 }, parsed, io);
      if ("code" in link) return link.code;
      const id = asText(link.data.id) || asText((link.data.transfer as { id?: unknown } | undefined)?.id);
      if (!id) throw new ControllerError("The transfer service gave no file id.", EXIT.tool);
      const upload = presigned(link.data, "upload");
      if (upload.method !== undefined && upload.method.toUpperCase() !== "PUT") throw new ControllerError("The transfer service asked for an upload method this CLI does not use.", EXIT.tool);
      try { await local.send({ url: upload.url, ...(upload.headers ? { headers: upload.headers } : {}) }, new AbortController().signal); }
      catch (error) { throw transferFailure(error, EXIT.tool); }
      const done = await transferStep(controller, { action: "complete", id }, parsed, io);
      if ("code" in done) return done.code;
      data = done.data;
    }
    return emit(showView(viewOf(data)), { exitCode: EXIT.ok }, parsed, io);
  });
}

async function getCommand(args: string[], io: Output): Promise<number> {
  const parsed = parseArgs(args, { flags: [...COMMON_FLAGS, "--overwrite"], values: COMMON_VALUES });
  if (parsed.positionals.length < 1 || parsed.positionals.length > 2) throw new ControllerError("Usage: frely get <id> [<local path> | <device>:<path>] [--overwrite]", EXIT.cli);
  const [id, destination] = parsed.positionals as [string, string | undefined];
  const overwrite = parsed.flags.has("--overwrite");
  const target = destination === undefined ? null : parseTarget(destination);
  return withController(io, async (controller) => {
    if (target?.device) {
      const step = await transferStep(controller, { action: "receive", id, device: target.device, path: target.path, overwrite }, parsed, io);
      if ("code" in step) return step.code;
      return emit({ text: `Saved ${id} to ${target.device}:${target.path}`, result: step.data as ToolResult }, { exitCode: EXIT.ok }, parsed, io);
    }
    const link = await transferStep(controller, { action: "download_link", id }, parsed, io);
    if ("code" in link) return link.code;
    let view = viewOf(link.data);
    let bytes = num(view.bytes), sha256 = asText((link.data.transfer as { sha256?: unknown } | undefined)?.sha256 ?? link.data.sha256);
    if (bytes === undefined || !sha256) {
      const listed = await transferStep(controller, { action: "list" }, parsed, io);
      if ("code" in listed) return listed.code;
      const found = transferRows(listed.data).find((row) => row.id === id);
      view = found ? viewOf(found) : view;
      bytes = num(found?.bytes); sha256 = asText(found?.sha256);
    }
    if (bytes === undefined || !sha256) throw new ControllerError("The transfer service did not say the file's size and SHA-256, so it cannot be checked.", EXIT.tool);
    const full = resolve(target?.path ?? basename(asText(view.name) || id));
    if (!overwrite && await lstat(full).then(() => true, () => false)) throw new ControllerError(`${full} already exists. Choose another path or add --overwrite.`, EXIT.cli);
    const download = presigned(link.data, "download");
    try {
      await transferIo.download(full, { url: download.url }, { bytes, sha256 }, overwrite, new AbortController().signal);
    } catch (error) { throw transferFailure(error, EXIT.tool); }
    return emit({ text: `Saved ${full} (${sizeText(bytes)}, sha256 ${sha256})`, result: { path: full, bytes, sha256 } as ToolResult }, { exitCode: EXIT.ok }, parsed, io);
  });
}

function transferRows(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const list = [data.transfers, data.files, data.items].find(Array.isArray);
  return (list ?? []) as Array<Record<string, unknown>>;
}

async function filesCommand(args: string[], io: Output): Promise<number> {
  const [action, ...rest] = args;
  if (action === "rm" || action === "share") {
    const parsed = parseArgs(rest, { flags: COMMON_FLAGS, values: action === "share" ? [...COMMON_VALUES, "--scope"] : COMMON_VALUES });
    if (parsed.positionals.length !== 1) throw new ControllerError(action === "rm" ? "Usage: frely files rm <id>" : "Usage: frely files share <id> --scope self|team|link", EXIT.cli);
    const id = parsed.positionals[0]!;
    if (action === "rm") return toolCall(io, parsed, "transfer", { action: "delete", id });
    const scope = parsed.values.get("--scope");
    if (!scope || !(SHARE_SCOPES as readonly string[]).includes(scope)) throw new ControllerError("--scope must be self, team or link.", EXIT.cli);
    return toolCall(io, parsed, "transfer", { action: "share", id, scope });
  }
  if (action !== undefined && !action.startsWith("--")) throw new ControllerError("Usage: frely files [rm <id> | share <id> --scope self|team|link]", EXIT.cli);
  const parsed = parseArgs(args, { flags: COMMON_FLAGS, values: COMMON_VALUES });
  if (parsed.positionals.length !== 0) throw new ControllerError("Usage: frely files [rm <id> | share <id> --scope self|team|link]", EXIT.cli);
  return withController(io, async (controller) => {
    const result = await controller.call("transfer", { action: "list" });
    const outcome = outcomeOf(result);
    const data = resultData(result);
    if (outcome.exitCode !== EXIT.ok || !data) return emit(shownOf(result), outcome, parsed, io);
    const rows = transferRows(data).map((row) => `${asText(row.id)}\t${asText(row.name)}\t${sizeText(num(row.bytes))}\t${asText(row.visibility) || "-"}\t${asText(row.expiresAt) || "-"}\t${asText(row.url) || "-"}`);
    return emit({ text: ["ID\tNAME\tSIZE\tVISIBILITY\tEXPIRES\tURL", ...rows].join("\n"), result }, outcome, parsed, io);
  });
}

async function toolsCommand(args: string[], io: Output): Promise<number> {
  const parsed = parseArgs(args, { flags: COMMON_FLAGS, values: COMMON_VALUES });
  return withController(io, async (controller) => {
    const tools = await controller.tools();
    const instructions = controller.instructions() ?? "";
    const result: ToolResult = { content: [], structuredContent: { instructions, tools } };
    const text = [instructions, ...tools.map((tool) => `${tool.name}${tool.annotations?.readOnlyHint ? " [read]" : ""}  ${(tool.description ?? "").replace(/\s+/gu, " ").slice(0, 160)}`)].filter(Boolean).join("\n\n");
    return emit({ text, result: { ...result } }, { exitCode: EXIT.ok }, parsed, io);
  });
}

/** `--json` takes a JSON object here (as in frely api call); a bare --json still asks for the full result. */
function callArgs(args: string[]): { parsed: ParsedArgs; input: Record<string, unknown> | null } {
  const rest: string[] = [];
  let json: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    if (args[i] === "--json" && next !== undefined && /^\s*[{[]/u.test(next)) { json = next; i++; } else rest.push(args[i]!);
  }
  const parsed = parseArgs(rest, { flags: COMMON_FLAGS, values: [...COMMON_VALUES, "--input"] });
  if (json !== undefined && parsed.values.has("--input")) throw new ControllerError("Use --json '<object>' or --input <file>, not both.", EXIT.cli);
  return { parsed, input: json !== undefined ? parseObject(json) : null };
}

function parseObject(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ControllerError("The input is not valid JSON.", EXIT.cli); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControllerError("The input must be a JSON object.", EXIT.cli);
  return value as Record<string, unknown>;
}

async function callCommand(args: string[], io: Output): Promise<number> {
  const { parsed, input } = callArgs(args);
  const [name] = parsed.positionals;
  if (!name || parsed.positionals.length !== 1 || !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(name)) throw new ControllerError("Usage: frely call <tool> [--json '<object>' | --input <file>]", EXIT.cli);
  // A Frely account tool is named group.action (share_links.redeem): it is not a tool of a device, which would otherwise be asked for.
  if (/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u.test(name)) throw new ControllerError(`${name} is a Frely account tool, not a device tool. Run: frely api call ${name} --json '<object>'`, EXIT.cli);
  const file = parsed.values.get("--input");
  const arguments_ = input ?? (file !== undefined ? parseObject((await readLocal(file, "The input")).toString("utf8")) : {});
  return toolCall(io, parsed, name, arguments_);
}

async function permissionCommand(args: string[], io: Output): Promise<number> {
  const [action, ...rest] = args;
  if (action === "request") {
    const parsed = parseArgs(rest, { flags: [...COMMON_FLAGS, "--no-wait"], values: [...COMMON_VALUES, "--resource", "--reason", "--command", "--cwd", "--mode"] });
    const [device] = parsed.positionals;
    const resource = parsed.values.get("--resource"), reason = parsed.values.get("--reason"), command = parsed.values.get("--command");
    if (!device || parsed.positionals.length !== 1 || !resource || !reason || !command) throw new ControllerError("Usage: frely permission request <device> --resource <name> --reason <text> --command <text> [--cwd <dir>] [--mode once|window|authorization]", EXIT.cli);
    const mode = parsed.values.get("--mode");
    if (mode !== undefined && !["once", "window", "authorization"].includes(mode)) throw new ControllerError("--mode must be once, window or authorization.", EXIT.cli);
    return withController(io, async (controller) => {
      const result = await controller.call("request_permission", { device, resource, reason, command, ...(parsed.values.has("--cwd") ? { cwd: parsed.values.get("--cwd") } : {}), ...(mode ? { mode } : {}) });
      const outcome = outcomeOf(result);
      // A person at a terminal waits here for the approval; a script or an AI gets the link and the wait command, and the exit code 3.
      const code = resultData(result)?.shortCode;
      if (outcome.exitCode !== EXIT.approval || typeof code !== "string" || !isInteractive() || parsed.flags.has("--no-wait") || parsed.flags.has("--json")) return emit(shownOf(result), outcome, parsed, io);
      io.out(resultText(result) + "\n");
      io.err("Waiting for the owner to decide…\n");
      return waitForPermission(controller, { code }, 10 * 60_000, io);
    });
  }
  if (action === "confirm") {
    const parsed = parseArgs(rest, { flags: COMMON_FLAGS, values: COMMON_VALUES });
    const [code, choice] = parsed.positionals;
    if (!code || parsed.positionals.length > 2 || (choice !== undefined && !/^[ABC]$/u.test(choice))) throw new ControllerError("Usage: frely permission confirm <code> [A|B|C]", EXIT.cli);
    return toolCall(io, parsed, "confirm_permission", { code, ...(choice ? { choice } : {}) });
  }
  if (action === "wait") {
    const parsed = parseArgs(rest, { values: ["--then", "--timeout"] });
    const [reference] = parsed.positionals;
    if (!reference || parsed.positionals.length !== 1 || !/^[A-Za-z]{4}-?[A-Za-z]{4}$/u.test(reference)) throw new ControllerError("Usage: frely permission wait <approval code (ABCD-EFGH)> [--then '<command>'] [--timeout <s>]", EXIT.cli);
    const ref: ApprovalRef = { code: reference.replace("-", "").toUpperCase() };
    const timeout = intOption(parsed, "--timeout", 1, 3600) ?? 600;
    const status = await withController(io, (controller) => waitForPermission(controller, ref, timeout * 1000, io));
    const then = parsed.values.get("--then");
    if (status !== EXIT.ok || then === undefined) return status;
    // The approval of one command is bound to its exact text, so the command is run as given.
    return new Promise<number>((done, fail) => {
      const child = spawn(then, { shell: true, stdio: "inherit" });
      child.once("error", fail);
      child.once("exit", (exit) => done(exit ?? EXIT.tool));
    });
  }
  throw new ControllerError("Usage: frely permission request|confirm|wait. See frely permission --help.", EXIT.cli);
}

/** Waits until the owner decides: approved is 0, denied 2, and a request that ran out (or was revoked) or the time limit is 3, because approval is still needed. */
export async function waitForPermission(controller: Pick<Controller, "call">, ref: ApprovalRef, timeoutMs: number, io: Output, options: ApprovalWaitOptions = {}): Promise<number> {
  const outcome = await waitForApproval(controller, ref, timeoutMs, options);
  const { data } = outcome;
  switch (outcome.status) {
    case "approved": {
      const again = data?.kind === "cloud_confirmation" ? `Run the call again once, with approvalCode ${ref.code} added.` : "Run the command again unchanged.";
      io.out(`Approved${typeof data?.mode === "string" ? ` (${data.mode})` : ""}${typeof data?.expiresAt === "string" ? ` until ${data.expiresAt}` : ""}. ${again}\n`);
      return EXIT.ok;
    }
    case "denied": io.err("The owner denied this request.\n"); return EXIT.tool;
    case "used": io.err("This approval was already used for a call. Check that call's result before repeating it.\n"); return EXIT.tool;
    case "expired": case "revoked": io.err(`The request is ${outcome.status}. Ask for it again.\n`); return EXIT.approval;
    case "pending": io.err("Still waiting for the owner. Run frely permission wait again to keep waiting.\n"); return EXIT.approval;
    default: io.err(outcome.message + "\n"); return EXIT.tool;
  }
}
