import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { VERSION } from "../version.js";
import { requireLogin, normalizeRelayUrl } from "../auth.js";

export type DirectResult = { isError?: boolean; content?: unknown; structuredContent?: unknown; [key: string]: unknown };

export interface DirectTool {
  name: string;
  description?: string | undefined;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean | undefined; destructiveHint?: boolean | undefined } | undefined;
  _meta?: Record<string, unknown> | undefined;
}

export interface CloudReader {
  /** Every Cloud tool this login can call directly (the read-only catalog; write and paid tools stay controller-only). */
  tools(): Promise<DirectTool[]>;
  call(name: string, args: Record<string, unknown>): Promise<DirectResult>;
  close(): Promise<void>;
}

/**
 * A read-only Cloud MCP client that runs on the `frely login` token alone — no controller session, no second approval. The login's
 * token carries the Cloud audience with `cloud:read`, so writes and paid tools are invisible here; callers fall back to the
 * controller connection for those (frely_call) where an approval code guards every write.
 */
export async function openCloudReader(): Promise<CloudReader> {
  const { config, credential } = await requireLogin();
  if (credential.scheme !== "bearer") throw new Error("Run `frely login` again to renew this computer's login.");
  const origin = normalizeRelayUrl(config.relayUrl);
  const bearer = credential.value;
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${bearer}`);
      return fetch(input, { ...init, headers, redirect: "error" });
    },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  const client = new Client({ name: "frely-cli", version: VERSION });
  try {
    await client.connect(transport as unknown as Transport);
  } catch (error) {
    await client.close().catch(() => undefined);
    if (error instanceof Error && error.message === "No Frely login is stored. Run `frely login`.") throw error;
    throw new Error(`Could not reach Frely Cloud: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    async tools() {
      const all: DirectTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor });
        all.push(...(page.tools as DirectTool[]));
        cursor = page.nextCursor;
      } while (cursor && all.length < 1000);
      return all;
    },
    call: (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 }) as Promise<DirectResult>,
    close: () => client.close(),
  };
}
