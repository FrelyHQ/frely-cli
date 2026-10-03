import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../version.js";
import { loadManualEntries } from "../runtime/local-mcp.js";
import { StdioOcuBackend } from "./ocu.js";
import { ComputerToolset } from "./toolset.js";

/** Name `frely computer enable` registers in the local MCP list; the web page turns it on by this name. */
export const COMPUTER_MCP_NAME = "computer";

/** The local key of the two-key rule: computer use works only while its entry is in the local MCP list. */
export async function computerEntryRegistered(): Promise<boolean> {
  return (await loadManualEntries().catch(() => [])).some((entry) => entry.name === COMPUTER_MCP_NAME && entry.transport === "stdio");
}

export function createComputerToolset(): ComputerToolset {
  return new ComputerToolset({ backend: new StdioOcuBackend(), isLocallyEnabled: computerEntryRegistered });
}

/** MCP server over the guarded toolset. Local MCP forwarding starts it as a stdio server (`frely computer mcp`). */
export function createComputerMcpServer(toolset: ComputerToolset): Server {
  const server = new Server({ name: "frely-computer", version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await toolset.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await toolset.call(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>, extra.signal);
    return { content: result.content, ...(result.isError ? { isError: true } : {}) } as { content: { type: "text"; text: string }[]; isError?: boolean };
  });
  server.onclose = () => { void toolset.close(); };
  return server;
}

export async function runComputerMcpServer(transport: Transport = new StdioServerTransport(), toolset: ComputerToolset = createComputerToolset()): Promise<void> {
  await createComputerMcpServer(toolset).connect(transport);
}
