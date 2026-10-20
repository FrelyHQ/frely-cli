import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../version.js";
import { COMPUTER_MCP_NAME, computerLocallyVetoed } from "./builtin.js";
import { ocuBinaryPath, StdioOcuBackend } from "./ocu.js";
import { installOcuRuntime } from "./runtime.js";
import { ComputerToolset } from "./toolset.js";

export { COMPUTER_MCP_NAME };

/** The local key of the two-key rule: computer use is on unless `frely computer disable` vetoed it; checked on every list and call. */
export async function computerLocallyEnabled(): Promise<boolean> {
  return !(await computerLocallyVetoed());
}

/** The runtime is installed on first use (pinned download, checksum verified), so turning computer use on from the web is enough. */
export function createComputerToolset(): ComputerToolset {
  return new ComputerToolset({ backend: new StdioOcuBackend(ocuBinaryPath(), installOcuRuntime), isLocallyEnabled: computerLocallyEnabled });
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
