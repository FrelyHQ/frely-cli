import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { changeWorkspaces, readWorkspaceState, type WorkspaceOperation, type WorkspaceState } from "./runtime/workspace-registry.js";

export interface WorkspaceCommandInput {
  args: string[];
  /** grant.workspace of the device's MCP authorization (the launch workspace), or null when MCP is not enabled. */
  primary: string | null;
  write: (text: string) => void;
  /** Called before a change that is not read-only; throws to refuse it (the owner's confirmation). */
  confirm?: (change: { action: WorkspaceOperation; path: string }) => Promise<void>;
}

/** `frely link workspace list|add <path> [--primary]|remove <path>`. `args` is the normalized argv, e.g. ["link", "workspace", "add", "/path"]. */
export async function runWorkspaceCommand({ args, primary: primaryInput, write, confirm }: WorkspaceCommandInput): Promise<void> {
  if (!primaryInput) throw new Error("MCP is not enabled. Run frely link on.");
  const launch = await realpath(primaryInput);
  const action = args[2];
  if (action === "list") {
    const state = await readWorkspaceState(launch);
    write(args.includes("--json") ? `${JSON.stringify({ primary: state.primary, workspaces: state.workspaces })}\n` : format(state));
    return;
  }
  if (action === "add" || action === "remove") {
    const path = resolve(args[3]!);
    // `add --primary` registers the folder if needed and makes it the primary workspace.
    const change: WorkspaceOperation = action === "add" && args.includes("--primary") ? "primary" : action;
    await confirm?.({ action: change, path });
    const state = await changeWorkspaces(change, path, launch);
    const done = change === "add" ? "Added workspace" : change === "remove" ? "Removed workspace" : "Primary workspace is now";
    write(`${done} ${change === "primary" ? state.primary : await realpath(path).catch(() => path)}\n${format(state)}`);
    return;
  }
  throw new Error("Unknown workspace command. Run frely link workspace.");
}

function format(state: WorkspaceState): string {
  return state.workspaces.map((root) => `${root === state.primary ? "* " : "  "}${root}${root === state.primary ? " (primary)" : ""}\n`).join("");
}
