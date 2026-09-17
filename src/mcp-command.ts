/**
 * Keep the public device-MCP entry client-neutral. Legacy commands still parse,
 * but are not advertised as separate ways to connect a particular AI client.
 */
export function normalizeMcpArgs(input: readonly string[]): string[] {
  const args = [...input];
  if (args[0] !== "mcp") return args;
  if (args.slice(1).some((arg) => arg === "--help" || arg === "-h") || args[1] === "help") return ["mcp", "help"];
  if (!args[1] || args[1].startsWith("-")) args.splice(1, 0, "setup");
  const action = args[1]!;
  const valueOptions: Record<string, readonly string[]> = {
    setup: ["--workspace", "--days"], renew: ["--workspace", "--days"],
    url: [], chatgpt: [], status: [], revoke: [],
    serve: ["--workspace", "--service-config-home", "--service-credential-store"],
    stdio: ["--workspace"],
  };
  const flags: Record<string, readonly string[]> = {
    url: ["--json"], chatgpt: ["--json"], status: ["--json"],
    serve: ["--provider-only"],
  };
  if (action === "service") {
    if (!args[2]) args.push("status");
    if (!["start", "stop", "uninstall", "status"].includes(args[2]!)) throw new Error("Use frely mcp service start|stop|uninstall. Inspect status with frely doctor.");
    if (args.slice(3).some((arg) => arg !== "--json") || (args.length > 3 && args[2] !== "status")) throw new Error("Unsupported MCP service option. Run frely mcp --help.");
    return args;
  }
  if (!Object.hasOwn(valueOptions, action)) throw new Error("Unknown device MCP command. Run frely mcp --help.");
  const seen = new Set<string>();
  for (let i = 2; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) throw new Error("Duplicate MCP option. Run frely mcp --help.");
    seen.add(arg);
    if (valueOptions[action]!.includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("An MCP option is missing its value. Run frely mcp --help.");
    } else if (!(flags[action] ?? []).includes(arg)) {
      throw new Error("Unsupported MCP option. Run frely mcp --help.");
    }
  }
  return args;
}
