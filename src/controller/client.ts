import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { VERSION } from "../version.js";
import { createDpopProof, dpopKeyFromPem } from "./dpop.js";
import { controllerLogin, requestControllerLogin, ControllerError, EXIT, readSession, refreshSession, type ControllerSession } from "./session.js";

export type ToolResult = { isError?: boolean; content?: unknown; structuredContent?: unknown; [key: string]: unknown };

/**
 * `fetch` for the FrelyMCP transport: every request carries the DPoP access token and a fresh proof for that request. A refused token is
 * renewed once (another process may have renewed it already) and the request sent again; a request is only ever replayed when the server
 * refused it before running anything.
 */
export function dpopFetch(initial: ControllerSession, options: { refresh?: (session: ControllerSession) => Promise<ControllerSession>; now?: () => number } = {}): { fetch: typeof fetch; session(): ControllerSession } {
  let session = initial;
  const refresh = options.refresh ?? refreshSession;
  const now = options.now ?? Date.now;
  const send = (input: string | URL | Request, init: RequestInit | undefined) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(init?.headers);
    headers.set("authorization", `DPoP ${session.accessToken}`);
    headers.set("dpop", createDpopProof(dpopKeyFromPem(session.privateKeyPem), { method, url, accessToken: session.accessToken }));
    return fetch(url, { ...init, headers, redirect: "error" });
  };
  return {
    session: () => session,
    fetch: async (input, init) => {
      if (session.expiresAt - 30_000 <= now()) session = await refresh(session);
      let response = await send(input, init);
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        session = await refresh(session);
        response = await send(input, init);
        if (response.status === 401) throw new ControllerError("The server did not accept this computer's controller authorization. Run the command again to approve it in your browser.", EXIT.auth);
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
 * Opens a controller connection, signing the computer in first when there is no session. A terminal waits for the owner's approval; any other
 * caller is shown the approval link and ends with the "approval needed" exit code, and running the command again continues from that request.
 */
export async function openController(options: { interactive: boolean; login?: typeof controllerLogin; request?: typeof requestControllerLogin } = { interactive: false }): Promise<Controller> {
  let session = await readSession();
  if (!session) session = await (options.interactive ? (options.login ?? controllerLogin)() : (options.request ?? requestControllerLogin)());
  const signed = dpopFetch(session);
  const transport = new StreamableHTTPClientTransport(new URL(session.mcpUrl), {
    fetch: signed.fetch, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  const client = new Client({ name: "frely-cli-controller", version: VERSION });
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
