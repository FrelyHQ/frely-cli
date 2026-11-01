import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { VERSION } from "../version.js";
import { frelyMcpUrl, refreshLoginCredential, requireLogin } from "../auth.js";

export type ToolResult = { isError?: boolean; content?: unknown; structuredContent?: unknown; [key: string]: unknown };

/** The exit codes of the device commands. */
export const EXIT = { ok: 0, cli: 1, tool: 2, approval: 3, auth: 4, offline: 5, limit: 6 } as const;

/** A failure with the exit code the command ends with. */
export class ControllerError extends Error {
  constructor(message: string, readonly exitCode: number) { super(message); this.name = "ControllerError"; }
}

const MCP_TIMEOUT_MS = 15_000;

/** A FreyMCP connection as the CLI uses it: the login's own token, no separate sign-in. */
export interface LoginMcpSession {
  mcpUrl: string;
  mcpToken: string;
}

/**
 * The login's FreyMCP side of the OAuth credential. The machine's connection needs the token minted beside the login access token;
 * a login stored before the two channels merged has none and is asked to sign in again.
 */
export async function loginMcpSession(): Promise<LoginMcpSession> {
  const { config, credential } = await requireLogin();
  if (!credential.mcpToken) throw new ControllerError("This computer needs a fresh sign-in to control your Frely devices. Run `frely login` again.", EXIT.auth);
  return { mcpUrl: frelyMcpUrl(config.relayUrl), mcpToken: credential.mcpToken };
}

/** A refused FreyMCP token is replaced by refreshing the login, which mints a fresh side token for this machine. */
async function refreshLoginMcpSession(): Promise<LoginMcpSession> {
  const { config, credential } = await refreshLoginCredential();
  if (!credential.mcpToken) throw new ControllerError("This computer needs a fresh sign-in to control your Frely devices. Run `frely login` again.", EXIT.auth);
  return { mcpUrl: frelyMcpUrl(config.relayUrl), mcpToken: credential.mcpToken };
}

/** `fetch` for the FreyMCP transport: every request carries the login's MCP side token. A refused token is refreshed once and the request sent again. */
export function mcpFetch(initial: LoginMcpSession, options: { refresh?: (session: LoginMcpSession) => Promise<LoginMcpSession> } = {}): { fetch: typeof fetch; session(): LoginMcpSession } {
  let session = initial;
  const refresh = options.refresh ?? refreshLoginMcpSession;
  const send = async (input: string | URL | Request, init: RequestInit | undefined) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${session.mcpToken}`);
    return fetch(input, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(MCP_TIMEOUT_MS) });
  };
  return {
    session: () => session,
    fetch: async (input, init) => {
      let response = await send(input, init);
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        session = await refresh(session);
        response = await send(input, init);
        if (response.status === 401) throw new ControllerError("The server did not accept this computer's device connection. Run `frely login` again.", EXIT.auth);
      }
      return response;
    },
  };
}

export interface Controller {
  /** The server's own instructions (how to use the tools), printed first by `frely tools`. */
  instructions(): string | undefined;
  tools(): Promise<Array<{ name: string; description?: string | undefined; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean | undefined } | undefined }>>;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

/**
 * Opens this computer's FreyMCP connection on the login's own credential. There is no separate controller sign-in: the same
 * `frely login` that owns the account also names this machine, and the connection appears in the web console under that machine.
 */
export async function openController(): Promise<Controller> {
  const session = await loginMcpSession();
  const signed = mcpFetch(session);
  const transport = new StreamableHTTPClientTransport(new URL(session.mcpUrl), {
    fetch: signed.fetch, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  const client = new Client({ name: "frely-cli", version: VERSION });
  try { await client.connect(transport as unknown as Transport); }
  catch (error) {
    await client.close().catch(() => undefined);
    if (error instanceof ControllerError) throw error;
    throw new ControllerError(`Could not reach FrelyMCP: ${error instanceof Error ? error.message : String(error)}`, EXIT.offline);
  }
  return {
    instructions: () => client.getInstructions(),
    async tools() {
      const all: Awaited<ReturnType<Controller["tools"]>> = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor });
        all.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor && all.length < 1000);
      return all;
    },
    call: (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 }) as Promise<ToolResult>,
    close: () => client.close(),
  };
}

/** The tool's text parts joined, as a person or model would read them. */
export function resultText(result: ToolResult): string {
  const parts = Array.isArray(result.content) ? result.content as Array<{ type?: unknown; text?: unknown }> : [];
  return parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("\n");
}

/** The result as one object: its structured content, else its text when that is a JSON object. */
export function resultData(result: ToolResult): Record<string, unknown> | null {
  if (result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)) return result.structuredContent as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(resultText(result));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

export interface Outcome { exitCode: number; /** Why the command did not simply succeed: what to do next, for the output's end. */ note?: string }

/**
 * What a tool result means for the exit code. A pending approval (3) comes with where to approve and the command that waits for it; an
 * offline device (5), a quota (6) and any other tool error (2) keep the server's own words in the output.
 */
export function outcomeOf(result: ToolResult): Outcome {
  const data = resultData(result);
  if (data?.status === "pending" && (typeof data.approveUrl === "string" || typeof data.shortCode === "string")) {
    const code = typeof data.shortCode === "string" ? data.shortCode : null;
    const lines = [`Approval needed${typeof data.device === "string" ? ` on ${data.device}` : ""}.`];
    if (typeof data.approveUrl === "string") lines.push(`Approve here: ${data.approveUrl}`);
    if (code) lines.push(`After the owner approves, or to wait for it in the background: frely permission wait ${code}`);
    return { exitCode: EXIT.approval, note: lines.join("\n") };
  }
  if (result.isError !== true) return { exitCode: EXIT.ok };
  const error = (data?.error && typeof data.error === "object" ? data.error : null) as { code?: unknown; url?: unknown } | null;
  if (error && (error.code === "permission_required" || error.code === "confirmation_required") && typeof error.url === "string") {
    return { exitCode: EXIT.approval, note: `Approval needed. Approve here: ${error.url}` };
  }
  const text = resultText(result);
  if (/frely link on|device is offline|Offline:/u.test(text)) return { exitCode: EXIT.offline };
  if (error && typeof error.code === "string" && /limit|quota|insufficient/u.test(error.code)) return { exitCode: EXIT.limit };
  return { exitCode: EXIT.tool };
}
