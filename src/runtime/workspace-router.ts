import { relative, isAbsolute, sep } from "node:path";
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

  requireAbsolute(workspaces, input);
  const [root] = containingRoots(workspaces, input);
  if (!root) {
    const roots = Array.from(workspaces.keys()).join("\n  ");
    throw new Error(
      `${input} is not inside any registered workspace:\n  ${roots}`,
    );
  }
  return { workspace: workspaces.get(root)!, relativeInput: within(root, input) };
}

/**
 * Resolves two paths (e.g. move_path's from/to) to one workspace. Each path prefers its
 * deepest root; when those differ, the deepest root containing both is used so a move
 * between a nested workspace and its parent still works.
 */
export function resolveWorkspacePair(
  workspaces: Map<string, Workspace>,
  from: string,
  to: string,
): { workspace: Workspace; relativeFrom: string; relativeTo: string } {
  const a = resolveWorkspace(workspaces, from);
  const b = resolveWorkspace(workspaces, to);
  if (a.workspace === b.workspace) return { workspace: a.workspace, relativeFrom: a.relativeInput, relativeTo: b.relativeInput };
  const toRoots = new Set(containingRoots(workspaces, to));
  const shared = containingRoots(workspaces, from).find((root) => toRoots.has(root));
  if (!shared) throw new Error("move_path: source and destination must be in the same workspace.");
  return { workspace: workspaces.get(shared)!, relativeFrom: within(shared, from), relativeTo: within(shared, to) };
}

function requireAbsolute(workspaces: Map<string, Workspace>, input: string): void {
  if (!isAbsolute(input) || input === ".") {
    const roots = Array.from(workspaces.keys()).join("\n  ");
    throw new Error(
      `Multiple workspaces are registered; give an absolute path under one of:\n  ${roots}`,
    );
  }
}

/** Roots that contain `input`, deepest first, so nested workspaces win over their parents. */
function containingRoots(workspaces: Map<string, Workspace>, input: string): string[] {
  return Array.from(workspaces.keys())
    .filter((root) => {
      const rel = relative(root, input);
      return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    })
    .sort((a, b) => b.length - a.length);
}

/** Path of `input` relative to `root`; the root itself is ".". */
function within(root: string, input: string): string {
  return relative(root, input) || ".";
}
