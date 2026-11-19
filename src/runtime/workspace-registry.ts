import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { realpath, lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureCredentialDirectory, readPrivateFile, writePrivateFile } from "../credential-file.js";

interface WorkspaceRegistry {
  version: 1;
  roots: string[];
  /** Set once the owner changes the list: `roots` is then the whole ordered list and its first entry is the primary workspace. Before that the launch workspace of the MCP authorization comes first. */
  ordered?: boolean;
  /** Bumped by every change, so a change made from a stale listing is refused instead of overwriting a newer one. */
  rev?: number;
}

export function workspaceRegistryPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "mcp-v1", "workspaces.json");
}

async function readRegistry(): Promise<WorkspaceRegistry> {
  const raw = await readPrivateFile(workspaceRegistryPath());
  if (!raw) return { version: 1, roots: [] };
  const value = JSON.parse(raw) as WorkspaceRegistry;
  if (value.version !== 1 || !Array.isArray(value.roots) || !value.roots.every((r) => typeof r === "string")
    || (value.ordered !== undefined && typeof value.ordered !== "boolean") || (value.rev !== undefined && !Number.isSafeInteger(value.rev))) {
    throw new Error("Workspace registry is corrupted.");
  }
  return value;
}

async function writeRegistry(registry: WorkspaceRegistry): Promise<void> {
  const path = workspaceRegistryPath();
  await ensureCredentialDirectory(dirname(path), true);
  await writePrivateFile(path, JSON.stringify(registry) + "\n");
}

export async function listWorkspaces(): Promise<string[]> {
  const registry = await readRegistry();
  return registry.roots;
}

/** The relay drops a capability report over 4 KB, so the report carries at most this many workspaces, none longer than the path limit. */
const REPORTED_WORKSPACES_MAX = 8;
const REPORTED_PATH_MAX = 150;

/** The workspaces this device serves for the relay's capability report: the primary one first, then the other registered roots. A broken registry reports only the primary. */
export async function reportedWorkspaces(primary?: string): Promise<string[]> {
  return (await reportedWorkspaceInfo(primary)).workspaces;
}

/** `truncated` tells the web the list is not complete, so it never writes it back as a full configuration. */
export async function reportedWorkspaceInfo(primary?: string): Promise<{ workspaces: string[]; truncated: boolean }> {
  const first = primary ? await realpath(resolve(primary)).then((value) => value, () => resolve(primary)) : undefined;
  const state = first ? await readWorkspaceState(first).catch(() => null) : null;
  const all = state ? state.workspaces : first ? [first] : await listWorkspaces().then((value) => value, () => [] as string[]);
  const fits = all.filter((root) => root.length <= REPORTED_PATH_MAX);
  const workspaces = fits.slice(0, REPORTED_WORKSPACES_MAX);
  return { workspaces, truncated: workspaces.length < all.length };
}

export async function ensureWorkspaceRegistered(input: string): Promise<void> {
  const path = await realpath(resolve(input));
  if (/[\x00-\x1f\x7f]/u.test(path)) throw new Error("Workspace path contains control characters.");
  
  const registry = await readRegistry();
  if (!registry.roots.includes(path)) {
    registry.roots.push(path);
    await writeRegistry(registry);
  }
}

export type WorkspaceOperation = "add" | "remove" | "primary";

export interface WorkspaceState {
  /** The first workspace in the list; the launch workspace of the MCP authorization until the owner changes the list. */
  primary: string;
  /** Every workspace the device serves, primary first; never truncated (unlike the capability report). */
  workspaces: string[];
  rev: number;
}

export class WorkspaceConflictError extends Error {
  constructor() { super("The workspace configuration changed since it was read. Read it again and retry."); }
}

/** Changes run one at a time in this process; `expectedRev` guards against a stale listing from another reader. */
let queue: Promise<unknown> = Promise.resolve();

async function realDirectory(input: string): Promise<string> {
  const path = await realpath(resolve(input));
  if (/[\x00-\x1f\x7f]/u.test(path)) throw new Error("Workspace path contains control characters.");
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Workspace must be a real directory.");
  return path;
}

/** The primary workspace is simply the first one in the list, so it always exists. */
function stateOf(registry: WorkspaceRegistry, fallback: string): WorkspaceState {
  const workspaces = registry.ordered === true && registry.roots.length > 0
    ? [...registry.roots]
    : fallback ? [fallback, ...registry.roots.filter((root) => root !== fallback)] : [...registry.roots];
  return { primary: workspaces[0] ?? fallback, workspaces, rev: registry.rev ?? 0 };
}

/** The full, untruncated configuration. `fallbackPrimary` is the launch workspace of the MCP authorization. */
export async function readWorkspaceState(fallbackPrimary: string): Promise<WorkspaceState> {
  const fallback = await realpath(resolve(fallbackPrimary)).catch(() => resolve(fallbackPrimary));
  return stateOf(await readRegistry(), fallback);
}

/**
 * The one place a workspace changes: add, remove, or move one to the front ("primary"). Add and primary validate the directory; remove
 * never touches the disk. Returns the configuration that is now in effect.
 */
export function changeWorkspaces(op: WorkspaceOperation, input: string, fallbackPrimary: string | undefined, expectedRev?: number): Promise<WorkspaceState> {
  const run = queue.then(async () => {
    const registry = await readRegistry();
    const fallback = fallbackPrimary === undefined ? (registry.roots[0] ?? "") : await realpath(resolve(fallbackPrimary)).catch(() => resolve(fallbackPrimary));
    if (expectedRev !== undefined && expectedRev !== (registry.rev ?? 0)) throw new WorkspaceConflictError();
    // The first change fixes the order the owner now sees (the launch workspace first, as before); from then on the list is the order.
    registry.roots = stateOf(registry, fallback).workspaces;
    registry.ordered = true;
    if (op === "remove") {
      const path = await realpath(resolve(input)).catch(() => resolve(input));
      if (/[\x00-\x1f\x7f]/u.test(path)) throw new Error("Workspace path contains control characters.");
      const index = registry.roots.indexOf(path);
      if (index < 0) throw new Error(`Workspace not registered: ${path}`);
      // Removing the first one promotes the next; the last workspace cannot go, so a primary always exists.
      if (registry.roots.length === 1) throw new Error(`Cannot remove the only workspace (${path}). Add another one first.`);
      registry.roots.splice(index, 1);
    } else {
      const path = await realDirectory(input);
      const index = registry.roots.indexOf(path);
      if (op === "add") {
        // Nested workspaces are allowed; requests route to the deepest matching root (see workspace-router).
        if (index >= 0) throw new Error(`Workspace already registered: ${path}`);
        registry.roots.push(path);
      } else {
        // `add --primary`: the path moves to (or is put at) the front, which is what makes it the primary workspace.
        if (index >= 0) registry.roots.splice(index, 1);
        registry.roots.unshift(path);
      }
    }
    registry.rev = (registry.rev ?? 0) + 1;
    await writeRegistry(registry);
    return stateOf(registry, fallback);
  });
  queue = run.catch(() => undefined);
  return run;
}

export async function addWorkspace(input: string, fallbackPrimary?: string): Promise<string[]> {
  await changeWorkspaces("add", input, fallbackPrimary);
  return listWorkspaces();
}

export async function removeWorkspace(input: string, primary: string): Promise<string[]> {
  await changeWorkspaces("remove", input, primary);
  return listWorkspaces();
}
