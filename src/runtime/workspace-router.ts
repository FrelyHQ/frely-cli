import { relative, isAbsolute, sep } from "node:path";
import { Workspace } from "./workspace.js";

/** An absolute path outside every registered workspace and every approved `path:` directory. */
export class OutsideWorkspaceError extends Error {
  constructor(readonly input: string) {
    super(`${input} is not inside any registered workspace.`);
  }
}

/**
 * `granted` holds the directories of the `path:` grants the owner approved for this call. They are not registered
 * workspaces: they only catch absolute paths no registered workspace contains, and never count toward the
 * "single workspace" rule, so relative paths and in-workspace paths behave exactly as before.
 */
export function resolveWorkspace(
  workspaces: Map<string, Workspace>,
  input: string,
  granted: ReadonlyMap<string, Workspace> = new Map(),
): { workspace: Workspace; relativeInput: string } {
  if (isAbsolute(input) && granted.size > 0 && containingRoots(workspaces, input).length === 0) {
    const [root] = containingRoots(granted, input);
    if (root) return { workspace: granted.get(root)!, relativeInput: within(root, input) };
  }
  if (workspaces.size === 1) {
    if (isAbsolute(input) && containingRoots(workspaces, input).length === 0) throw new OutsideWorkspaceError(input);
    // Single workspace: backward compatible behavior
    const workspace = workspaces.values().next().value as Workspace;
    return { workspace, relativeInput: input };
  }

  requireAbsolute(workspaces, input);
  const [root] = containingRoots(workspaces, input);
  if (!root) throw new OutsideWorkspaceError(input);
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
  granted: ReadonlyMap<string, Workspace> = new Map(),
): { workspace: Workspace; relativeFrom: string; relativeTo: string } {
  const a = resolveWorkspace(workspaces, from, granted);
  const b = resolveWorkspace(workspaces, to, granted);
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
function containingRoots(workspaces: ReadonlyMap<string, Workspace>, input: string): string[] {
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
