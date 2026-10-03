import { addManualEntry, loadManualEntries, LocalMcpHub, removeManualEntry, resolveCommand, type LocalMcpEntry, type ManualLocalMcpEntry } from "./runtime/local-mcp.js";

export interface LocalMcpCommandInput {
  /** Normalized argv, e.g. ["mcp", "local", "add", "notes", "--url", "http://127.0.0.1:8123/mcp"]. */
  args: string[];
  write: (text: string) => void;
}

/** `frely mcp local list|add|remove`. Turning a server on for remote clients happens on the web connections page. */
export async function runLocalMcpCommand({ args, write }: LocalMcpCommandInput): Promise<void> {
  const action = args[2];
  if (action === "list") {
    const hub = new LocalMcpHub();
    await hub.refresh();
    const entries = hub.snapshot();
    if (args.includes("--json")) { write(`${JSON.stringify({ servers: entries.map(describe) })}\n`); return; }
    if (entries.length === 0) { write("No local MCP servers found. Servers listening only on 127.0.0.1 are discovered automatically; add others with frely mcp local add.\n"); return; }
    write(entries.map((entry) => `${entry.name}  ${entry.transport}  ${entry.source}  ${target(entry)}\n`).join(""));
    write("Turn a server on for remote clients on the Frely connections page; every server is off until then.\n");
    return;
  }
  if (action === "add") {
    const entry = await parseAdd(args.slice(3));
    const count = await verify(entry);
    await addManualEntry(entry);
    write(`Added local MCP ${entry.name} (${count} tools). Turn it on for remote clients on the Frely connections page.\n`);
    return;
  }
  if (action === "remove") {
    if (!args[3] || args.length > 4) throw new Error("Usage: frely mcp local remove <name>");
    await removeManualEntry(args[3]);
    write(`Removed local MCP ${args[3]}. Discovered servers cannot be removed; stop the program or leave it off.\n`);
    return;
  }
  throw new Error("Unknown local MCP command. Run frely mcp local.");
}

/** `add <name> --url <url> [--header K=V]...` or `add <name> [--env K=V]... -- <command> [args...]`. */
export async function parseAdd(args: readonly string[]): Promise<ManualLocalMcpEntry> {
  const name = args[0];
  if (!name || name.startsWith("-")) throw new Error("Usage: frely mcp local add <name> --url <http://127.0.0.1:port/path> | -- <command> [args...]");
  const separator = args.indexOf("--");
  const options = separator === -1 ? args.slice(1) : args.slice(1, separator);
  const rest = separator === -1 ? [] : args.slice(separator + 1);
  const pairs = (flag: string): Record<string, string> | undefined => {
    const result: Record<string, string> = {};
    for (let i = 0; i < options.length; i++) {
      if (options[i] !== flag) continue;
      const value = options[++i] ?? "";
      const at = value.indexOf("=");
      if (at < 1) throw new Error(`${flag} needs KEY=VALUE.`);
      result[value.slice(0, at)] = value.slice(at + 1);
    }
    return Object.keys(result).length > 0 ? result : undefined;
  };
  const urlAt = options.indexOf("--url");
  const known = new Set(["--url", "--header", "--env"]);
  for (let i = 0; i < options.length; i++) {
    if (!known.has(options[i]!)) throw new Error(`Unsupported local MCP option ${options[i]}. Run frely mcp local.`);
    i++;
  }
  if (urlAt !== -1) {
    if (rest.length > 0 || pairs("--env")) throw new Error("--url cannot be combined with a command or --env.");
    const url = options[urlAt + 1];
    if (!url) throw new Error("--url needs an address.");
    const headers = pairs("--header");
    return { name, transport: "http", url, ...(headers ? { headers } : {}) };
  }
  if (rest.length === 0) throw new Error("Give either --url <address> or -- <command> [args...].");
  if (pairs("--header")) throw new Error("--header only applies to --url servers.");
  const env = pairs("--env");
  return { name, transport: "stdio", command: await resolveCommand(rest[0]!), args: rest.slice(1), ...(env ? { env } : {}), path: process.env.PATH ?? "" };
}

/** Connects once with the candidate entry so a typo or a dead server is rejected before it is saved. */
async function verify(candidate: ManualLocalMcpEntry): Promise<number> {
  const entry = { ...candidate, source: "manual" } as LocalMcpEntry;
  if ((await loadManualEntries()).some((item) => item.name === entry.name)) throw new Error(`A local MCP named ${entry.name} already exists. Remove it first.`);
  const hub = new LocalMcpHub({ loadManual: async () => [entry], discovery: { listPorts: async () => [] } });
  try {
    await hub.refresh();
    const listed = await hub.list([entry.name], entry.name) as { tools: unknown[] };
    return listed.tools.length;
  } finally {
    await hub.close();
  }
}

/** Never prints header or environment values; they may be secrets. */
function describe(entry: LocalMcpEntry): Record<string, unknown> {
  return entry.transport === "http"
    ? { name: entry.name, transport: "http", source: entry.source, url: entry.url, headers: Object.keys(entry.headers ?? {}) }
    : { name: entry.name, transport: "stdio", source: entry.source, command: entry.command, args: entry.args, env: Object.keys(entry.env ?? {}) };
}

function target(entry: LocalMcpEntry): string {
  return entry.transport === "http" ? entry.url : [entry.command, ...entry.args].join(" ");
}
