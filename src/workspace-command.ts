import { realpath } from "node:fs/promises";
import { addWorkspace, ensureWorkspaceRegistered, listWorkspaces, removeWorkspace } from "./runtime/workspace-registry.js";

export interface WorkspaceCommandInput {
  args: string[];
  /** grant.workspace of the device's MCP authorization, or null when MCP is not enabled. */
  primary: string | null;
  write: (text: string) => void;
}

/** `frely mcp workspace list|add <path>|remove <path>`. `args` is the normalized argv, e.g. ["mcp", "workspace", "add", "/path"]. */
export async function runWorkspaceCommand({ args, primary: primaryInput, write }: WorkspaceCommandInput): Promise<void> {
  if (!primaryInput) throw new Error("MCP is not enabled. Run frely mcp url.");
  const primary = await realpath(primaryInput);
  // The primary workspace is always registered, so nesting checks also apply to it.
  await ensureWorkspaceRegistered(primary);
  const action = args[2];
  if (action === "add") {
    const roots = await addWorkspace(args[3]!);
    write(`Added workspace ${roots[roots.length - 1]}\n${format(primary, roots)}`);
    return;
  }
  if (action === "remove") {
    const roots = await removeWorkspace(args[3]!, primary);
    write(`Removed workspace. Remaining:\n${format(primary, roots)}`);
    return;
  }
  if (action === "list") {
    const roots = await listWorkspaces();
    write(args.includes("--json")
      ? `${JSON.stringify({ primary, workspaces: ordered(primary, roots) })}\n`
      : format(primary, roots));
    return;
  }
  throw new Error("Unknown workspace command. Run frely mcp workspace.");
}

function ordered(primary: string, roots: string[]): string[] {
  return [primary, ...roots.filter((root) => root !== primary)];
}

function format(primary: string, roots: string[]): string {
  return ordered(primary, roots).map((root) => `${root === primary ? "* " : "  "}${root}${root === primary ? " (primary)" : ""}\n`).join("");
}
