import { access } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { computerDir } from "./state.js";

/** Pinned open-computer-use release the CLI is built and tested against (plan computer-use D1/D7). */
export const OCU_VERSION = "0.3.6";

export interface OcuTool { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }
export interface OcuContent { type: string; text?: string; data?: string; mimeType?: string; [key: string]: unknown }
export interface OcuResult { content: OcuContent[]; isError?: boolean }

/** The part of the open-computer-use MCP server the toolset depends on; tests substitute a fake. */
export interface OcuBackend {
  listTools(): Promise<OcuTool[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<OcuResult>;
  close(): Promise<void>;
}

export function ocuBinaryPath(): string {
  if (process.env.FRELY_COMPUTER_BIN) return process.env.FRELY_COMPUTER_BIN;
  const dir = join(computerDir(), "bin", OCU_VERSION);
  if (process.platform === "darwin") return join(dir, "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse");
  return join(dir, process.platform === "win32" ? "open-computer-use.exe" : "open-computer-use");
}

export class OcuNotInstalledError extends Error {
  constructor(path: string) {
    super(`The computer-use runtime is not installed (expected ${path}). Run \`frely computer enable\` on this device to install it.`);
    this.name = "OcuNotInstalledError";
  }
}

/** Lazily started stdio client for the open-computer-use binary; restarts on the next call after it dies. */
export class StdioOcuBackend implements OcuBackend {
  private client: Client | undefined;
  private starting: Promise<Client> | undefined;

  constructor(private readonly binary: string = ocuBinaryPath()) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    this.starting ??= (async () => {
      await access(this.binary).catch(() => { throw new OcuNotInstalledError(this.binary); });
      const transport = new StdioClientTransport({ command: this.binary, args: ["mcp"], stderr: "ignore" });
      const client = new Client({ name: "frely-cli-computer", version: "1" });
      client.onclose = () => { if (this.client === client) this.client = undefined; };
      await client.connect(transport);
      this.client = client;
      return client;
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async listTools(): Promise<OcuTool[]> {
    const result = await (await this.connect()).listTools();
    return result.tools as OcuTool[];
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<OcuResult> {
    const result = await (await this.connect()).callTool({ name, arguments: args }, undefined, { ...(signal ? { signal } : {}), timeout: 60_000 });
    return { content: (result.content ?? []) as OcuContent[], ...(result.isError ? { isError: true } : {}) };
  }

  async close(): Promise<void> {
    const client = this.client; this.client = undefined;
    await client?.close().catch(() => undefined);
  }
}
