import { relative, resolve, isAbsolute, sep } from "node:path";
import { Workspace } from "./workspace.js";

export function resolveWorkspace(
  workspaces: Map<string, Workspace>,
  input: string,
): { workspace: Workspace; relativeInput: string } {
  if (workspaces.size === 1) {
    // Single workspace: backward compatible behavior
    const workspace = workspaces.values().next().value as Workspace;
    return { workspace, relativeInput: input };
  }

  // Multiple workspaces: require absolute path
  if (!isAbsolute(input) || input === ".") {
    const roots = Array.from(workspaces.keys()).join("\n  ");
    throw new Error(
      `Multiple workspaces are registered; give an absolute path under one of:\n  ${roots}`,
    );
  }

  // Find which workspace contains this path
  let matchedWorkspace: Workspace | null = null;
  let matchedRoot: string | null = null;

  for (const [root, workspace] of workspaces) {
    const rel = relative(root, input);
    // If rel doesn't start with "..", the input is inside this root
    if (rel !== ".." && !rel.startsWith(`..${sep}`)) {
      matchedWorkspace = workspace;
      matchedRoot = root;
      break;
    }
  }

  if (!matchedWorkspace || !matchedRoot) {
    const roots = Array.from(workspaces.keys()).join("\n  ");
    throw new Error(
      `${input} is not inside any registered workspace:\n  ${roots}`,
    );
  }

  const relativeInput = relative(matchedRoot, input);
  return { workspace: matchedWorkspace, relativeInput };
}
