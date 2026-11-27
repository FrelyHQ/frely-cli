import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export type DiagnosticLog = (line: string) => void;
export interface DiagnosticContext {
  requestId?: string;
  method?: string;
  tool?: string;
  durationMs?: number;
  inflight?: number;
  rpcErrorCode?: number;
  /** WebSocket close code received from the relay; absent when the connection dropped without a close frame. */
  closeCode?: number;
  /** Network error code of the socket (for example ECONNRESET), only values in the allow-list. */
  socketErrorCode?: string;
  ageMs?: number;
  sinceLastPingMs?: number;
  sinceLastPongMs?: number;
  sinceLastFrameMs?: number;
  outcome?: "ok" | "tool_error" | "protocol_error";
  /** Protected folders a shell command names (allow-listed labels only, never command text); see commandReachLabels. */
  reaches?: string[];
}

const methods = new Set(["initialize", "ping", "tools/list", "tools/call", "notifications/initialized", "notifications/cancelled"]);
const tools = new Set(["read", "edit_file", "process", "web_fetch", "workspace_info", "list_directory", "stat_path", "find_files", "search_files", "read_file", "read_file_lines", "write_file", "apply_patch", "create_directory", "delete_path", "move_path", "run_command", "start_process", "list_processes", "read_process", "write_process", "stop_process"]);
const root = fileURLToPath(new URL("../../", import.meta.url));
const codes = new Set(["ENOENT", "EACCES", "EPERM", "EEXIST", "ENOTDIR", "EISDIR", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ABORT_ERR", "frame_invalid", "frame_too_large", "duplicate_request", "inflight_limit"]);
const messages = new Set([
  "Duplicate Device Relay request id.", "MCP request cancelled by Relay.", "Relay MCP transport closed.",
  "Relay MCP transport is not started.", "MCP execution authorization is missing or mismatched.",
  "MCP device differs from the connected device.", "Invalid MCP JSON-RPC payload.",
  "Invalid MCP JSON-RPC version.", "Invalid MCP JSON-RPC request id.",
  "MCP command authorization was cancelled; mutation outcome may be unknown.",
  "MCP command timed out; mutation outcome may be unknown.", "MCP command output limit exceeded.",
  "MCP command could not be started.", "No Frely login is stored. Run `frely login`.",
  "Frely login expired. Run `frely login`.", "Frely login refresh is temporarily unavailable; retrying later.", "Frely request timed out.",
  "Device transport WebSocket failed.", "Device transport heartbeat timed out.",
  "MCP_AUTHORIZATION_EXPIRED", "The operation was aborted", "fetch failed",
]);

// Never serialize an error object, arbitrary error message, tool arguments or output.
// Exception messages can embed shell commands, file contents and credentials.
export function diagnostic(log: DiagnosticLog | undefined, event: string, context: DiagnosticContext = {}, error?: unknown): void {
  if (!log) return;
  try {
    log(JSON.stringify({
      timestamp: new Date().toISOString(), pid: process.pid, event,
      ...(context.requestId ? { requestId: /^[A-Za-z0-9_-]{16,96}$/u.test(context.requestId) ? context.requestId : "invalid" } : {}),
      ...(context.method ? { method: methods.has(context.method) ? context.method : "unknown" } : {}),
      ...(context.tool ? { tool: tools.has(context.tool) ? context.tool : "unknown" } : {}),
      ...(context.durationMs !== undefined ? { durationMs: Math.max(0, Math.round(context.durationMs)) } : {}),
      ...(context.inflight !== undefined ? { inflight: Math.max(0, Math.min(1_000, Math.round(context.inflight))) } : {}),
      ...(Number.isSafeInteger(context.rpcErrorCode) ? { rpcErrorCode: context.rpcErrorCode } : {}),
      ...(Number.isSafeInteger(context.closeCode) ? { closeCode: context.closeCode } : {}),
      ...(context.socketErrorCode && codes.has(context.socketErrorCode) ? { socketErrorCode: context.socketErrorCode } : {}),
      ...(context.ageMs !== undefined ? { ageMs: Math.max(0, Math.round(context.ageMs)) } : {}),
      ...(context.sinceLastPingMs !== undefined ? { sinceLastPingMs: Math.max(0, Math.round(context.sinceLastPingMs)) } : {}),
      ...(context.sinceLastPongMs !== undefined ? { sinceLastPongMs: Math.max(0, Math.round(context.sinceLastPongMs)) } : {}),
      ...(context.sinceLastFrameMs !== undefined ? { sinceLastFrameMs: Math.max(0, Math.round(context.sinceLastFrameMs)) } : {}),
      ...(context.outcome ? { outcome: context.outcome } : {}),
      ...(context.reaches?.length ? { reaches: context.reaches.filter((label) => REACH_LABELS.has(label)) } : {}),
      ...(error !== undefined ? { error: diagnosticError(error) } : {}),
    }));
  } catch { /* A diagnostic sink must never change request execution. */ }
}

export function diagnosticError(error: unknown): { name: string; message: string; code?: string; stack: string[] } {
  if (!(error instanceof Error)) return { name: "Error", message: "Non-Error exception (details withheld).", stack: [] };
  const name = ["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "DeviceRelayProtocolError"].includes(error.name) ? error.name : "Error";
  const code = "code" in error && typeof error.code === "string" && codes.has(error.code) ? error.code : undefined;
  let message = messages.has(error.message) ? error.message : "Error details withheld; inspect code and stack locations.";
  const exited = /^(MCP command exited with status (?:\d+|unknown)\.)(?:\n|$)/u.exec(error.message);
  if (exited) message = exited[1]!;
  const http = /^(?:Frely request failed with HTTP|Unexpected server response:) (\d{3})\.?$/u.exec(error.message);
  if (http) message = `HTTP ${http[1]}.`;
  // The close code and reason come from the relay, not from user data. Keep them (bounded, printable) so a
  // disconnect can be attributed; anything else in the reason is replaced.
  const websocket = /^WebSocket closed \((\d{4})(?:: ([^\r\n]{1,64}))?\)$/u.exec(error.message);
  if (websocket) {
    const reason = websocket[2] ? `: ${websocket[2].replace(/[^A-Za-z0-9 _.,:-]/gu, "?")}` : "";
    message = `WebSocket closed (${websocket[1]}${reason}).`;
  }
  const stack = (error.stack ?? "").split("\n").filter((line) => /^\s+at /u.test(line)).slice(0, 20).map((line) => {
    const frame = /(?:\(|\s)((?:file:\/\/\/|\/|[A-Za-z]:\\|node:)[^()\r\n]*):(\d+):(\d+)\)?$/u.exec(line);
    if (!frame) return "[external frame]";
    let location = frame[1]!;
    if (location.startsWith("file://")) { try { location = fileURLToPath(location); } catch { return "[external frame]"; } }
    if (location.startsWith(root)) location = location.slice(root.length);
    else if (!location.startsWith("node:")) return "[external frame]";
    if (!/^[A-Za-z0-9_./:@\\-]{1,240}$/u.test(location)) return "[external frame]";
    return `${location}:${frame[2]}:${frame[3]}`;
  });
  return { name, message, ...(code ? { code } : {}), stack };
}

const PROTECTED_FOLDERS = ["Downloads", "Documents", "Desktop", "Pictures", "Movies", "Music", "Library"] as const;
const REACH_LABELS = new Set<string>([...PROTECTED_FOLDERS, "home", "users"]);
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Which macOS-protected folders (the ones that raise a system permission prompt) a shell command spells out, as allow-listed labels:
 * "Downloads" for ~/Downloads, "home" when it points at the whole home directory, "users" for /Users itself. Never the command text.
 * Only meant to tell which command caused a prompt; a command that builds the path at run time is not seen.
 */
export function commandReachLabels(command: string, home: string = homedir()): string[] {
  const base = ["~", "\\$HOME", "\\$\\{HOME\\}", escapeRegExp(home)].join("|");
  const labels: string[] = [];
  for (const folder of PROTECTED_FOLDERS) if (new RegExp(`(?:${base})/${folder}(?=$|[/\\s"'\`;&|)<>])`, "u").test(command)) labels.push(folder);
  if (new RegExp(`(?:^|[\\s"'=])(?:${base})/?(?=$|[\\s"'\`;&|)<>])`, "u").test(command)) labels.push("home");
  if (/(?:^|[\s"'=])\/Users\/?(?=$|[\s"'`;&|)<>])/u.test(command)) labels.push("users");
  return labels;
}

export function mcpDiagnosticContext(payload: unknown): Pick<DiagnosticContext, "method" | "tool" | "reaches"> {
  if (!payload || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  const params = record.params && typeof record.params === "object" ? record.params as Record<string, unknown> : {};
  return {
    ...(typeof record.method === "string" ? { method: record.method } : {}),
    ...(record.method === "tools/call" && typeof params.name === "string" ? { tool: params.name } : {}),
    ...(record.method === "tools/call" ? shellReaches(params) : {}),
  };
}

function shellReaches(params: Record<string, unknown>): { reaches?: string[] } {
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
  const shell = params.name === "run_command" || params.name === "start_process" || (params.name === "process" && (args.action === "run" || args.action === "start"));
  if (!shell || typeof args.command !== "string") return {};
  const reaches = commandReachLabels(args.command);
  return reaches.length ? { reaches } : {};
}
