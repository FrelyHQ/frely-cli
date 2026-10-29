import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { intOption, parseArgs, requireRemote, type ParsedArgs } from "./args.js";
import { waitForApproval, type ApprovalRef, type ApprovalWaitOptions } from "./approval-wait.js";
import { openController, outcomeOf, resultData, resultText, type Controller, type Outcome, type ToolResult } from "./client.js";
import { controllerLogin, controllerLogout, ControllerError, EXIT, readSession } from "./session.js";

export const CONTROLLER_COMMANDS: ReadonlySet<string> = new Set(["devices", "run", "ps", "logs", "kill", "read", "ls", "grep", "edit", "tools", "call", "permission", "controller"]);

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
  frely tools [--json]                           What the server offers, with its own instructions
  frely call <tool> [--json '<object>' | --input <file>]   Any tool by name
  frely controller login|logout|status           This computer's authorization to control your devices

Every command takes --json (the full result) and --out <file> (write the output there).
A device is its name or id from "frely devices". A path on this computer is not accepted where <device>:<path> is expected.
Exit codes: 0 done, 1 this CLI (usage, local file), 2 the tool or the remote command failed, 3 approval needed (the output has the link
and the "frely permission wait" command), 4 not authorized (run frely controller login), 5 device offline, 6 limit reached.
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
  const controller = await openIt({ interactive: isInteractive() });
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
      case "controller": return await controllerCommand(rest, io);
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
      case "tools": return await toolsCommand(rest, io);
      case "call": return await callCommand(rest, io);
      default: throw new ControllerError(`Unknown command ${command}.\n${CONTROLLER_USAGE}`, EXIT.cli);
    }
  } catch (error) {
    if (error instanceof ControllerError) { io.err(error.message + "\n"); return error.exitCode; }
    throw error;
  }
}

async function controllerCommand(args: string[], io: Output): Promise<number> {
  const action = args[0];
  if (action === "login") {
    const session = await controllerLogin({ notify: (text) => io.err(text) });
    io.out(`This computer can now control your Frely devices (FrelyMCP ${session.mcpUrl}).\n`);
    return EXIT.ok;
  }
  if (action === "logout") {
    io.out(await controllerLogout() ? "This computer no longer controls your Frely devices.\n" : "This computer was not authorized as a controller.\n");
    return EXIT.ok;
  }
  if (action === "status") {
    const session = await readSession();
    io.out(session ? `Authorized to control your devices: yes\nFrelyMCP: ${session.mcpUrl}\n` : "Authorized to control your devices: no. Run frely controller login.\n");
    return EXIT.ok;
  }
  throw new ControllerError("Usage: frely controller login|logout|status", EXIT.cli);
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
    if (!reference || parsed.positionals.length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/u.test(reference)) throw new ControllerError("Usage: frely permission wait <six-letter short code | confirmationId> [--then '<command>'] [--timeout <s>]", EXIT.cli);
    const ref: ApprovalRef = /^[A-Za-z]{6}$/u.test(reference) ? { code: reference.toUpperCase() } : { confirmationId: reference };
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
      const again = "confirmationId" in ref ? "Run the call again once, with the same confirmationId." : "Run the command again unchanged.";
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
