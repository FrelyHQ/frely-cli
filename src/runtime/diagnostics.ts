import { fileURLToPath } from "node:url";

export type DiagnosticLog = (line: string) => void;
export interface DiagnosticContext {
  requestId?: string;
  method?: string;
  tool?: string;
  durationMs?: number;
  rpcErrorCode?: number;
  outcome?: "ok" | "tool_error" | "protocol_error";
}

const methods = new Set(["initialize", "ping", "tools/list", "tools/call", "notifications/initialized", "notifications/cancelled"]);
const tools = new Set(["workspace_info", "list_directory", "stat_path", "find_files", "search_files", "read_file", "read_file_lines", "write_file", "apply_patch", "create_directory", "delete_path", "move_path", "run_command", "start_process", "list_processes", "read_process", "write_process", "stop_process"]);
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
      ...(Number.isSafeInteger(context.rpcErrorCode) ? { rpcErrorCode: context.rpcErrorCode } : {}),
      ...(context.outcome ? { outcome: context.outcome } : {}),
      ...(error !== undefined ? { error: diagnosticError(error) } : {}),
    }));
  } catch { /* A diagnostic sink must never change request execution. */ }
}

export function diagnosticError(error: unknown): { name: string; message: string; code?: string; stack: string[] } {
  if (!(error instanceof Error)) return { name: "Error", message: "Non-Error exception (details withheld).", stack: [] };
  const name = ["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "DeviceRelayProtocolError"].includes(error.name) ? error.name : "Error";
  const code = "code" in error && typeof error.code === "string" && codes.has(error.code) ? error.code : undefined;
  let message = messages.has(error.message) ? error.message : "Error details withheld; inspect code and stack locations.";
  if (/^MCP command exited with status (?:\d+|unknown)\.$/u.test(error.message)) message = error.message;
  const http = /^(?:Frely request failed with HTTP|Unexpected server response:) (\d{3})\.?$/u.exec(error.message);
  if (http) message = `HTTP ${http[1]}.`;
  const websocket = /^WebSocket closed \((\d{4})(?:: ([a-z_]+))?\)$/u.exec(error.message);
  if (websocket) {
    const reason = websocket[2] && ["hard_lifetime", "device_revoked", "revocation_check_failed", "connection_replaced", "frame_invalid"].includes(websocket[2]) ? `: ${websocket[2]}` : "";
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

export function mcpDiagnosticContext(payload: unknown): Pick<DiagnosticContext, "method" | "tool"> {
  if (!payload || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  const params = record.params && typeof record.params === "object" ? record.params as Record<string, unknown> : {};
  return {
    ...(typeof record.method === "string" ? { method: record.method } : {}),
    ...(record.method === "tools/call" && typeof params.name === "string" ? { tool: params.name } : {}),
  };
}
