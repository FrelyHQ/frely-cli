import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { realpath, lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureCredentialDirectory, readPrivateFile, writePrivateFile } from "../credential-file.js";

interface WorkspaceRegistry {
  version: 1;
  roots: string[];
}

export function workspaceRegistryPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "mcp-v1", "workspaces.json");
}

async function readRegistry(): Promise<WorkspaceRegistry> {
  const raw = await readPrivateFile(workspaceRegistryPath());
  if (!raw) return { version: 1, roots: [] };
  const value = JSON.parse(raw) as WorkspaceRegistry;
  if (value.version !== 1 || !Array.isArray(value.roots) || !value.roots.every((r) => typeof r === "string")) {
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

export async function ensureWorkspaceRegistered(input: string): Promise<void> {
  const path = await realpath(resolve(input));
  if (/[\x00-\x1f\x7f]/u.test(path)) throw new Error("Workspace path contains control characters.");
  
  const registry = await readRegistry();
  if (!registry.roots.includes(path)) {
    registry.roots.push(path);
    await writeRegistry(registry);
  }
}

export async function addWorkspace(input: string): Promise<string[]> {
  const path = await realpath(resolve(input));
  
  // Check if path is a directory
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Workspace must be a real directory.");
  }
  
  if (/[\x00-\x1f\x7f]/u.test(path)) throw new Error("Workspace path contains control characters.");

  const registry = await readRegistry();

  // Check for duplicates
  if (registry.roots.includes(path)) {
    throw new Error(`Workspace already registered: ${path}`);
  }

  // Check for nesting
  for (const existing of registry.roots) {
    const relExistingToNew = relative(existing, path);
    const relNewToExisting = relative(path, existing);
    
    // Check if new path is nested under existing
    if (relExistingToNew !== ".." && !relExistingToNew.startsWith(`..${sep}`)) {
      throw new Error(`Cannot register workspace ${path}; it is nested inside ${existing}.`);
    }
    
    // Check if existing is nested under new path
    if (relNewToExisting !== ".." && !relNewToExisting.startsWith(`..${sep}`)) {
      throw new Error(`Cannot register workspace ${path}; it contains the registered workspace ${existing}.`);
    }
  }

  registry.roots.push(path);
  await writeRegistry(registry);
  return registry.roots;
}

export async function removeWorkspace(input: string, primary: string): Promise<string[]> {
  const path = await realpath(resolve(input));
  
  if (/[\x00-\x1f\x7f]/u.test(path)) throw new Error("Workspace path contains control characters.");

  // The guard must not depend on the caller having normalized `primary`.
  const primaryPath = await realpath(resolve(primary)).catch(() => resolve(primary));
  if (path === primaryPath) {
    throw new Error(`Cannot remove the primary workspace (${path}). It is tied to the device's MCP authorization; run frely mcp revoke instead.`);
  }

  const registry = await readRegistry();
  const index = registry.roots.indexOf(path);
  if (index < 0) {
    throw new Error(`Workspace not registered: ${path}`);
  }

  registry.roots.splice(index, 1);
  await writeRegistry(registry);
  return registry.roots;
}
