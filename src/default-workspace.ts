import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The folder a new device shares when `--workspace` is not given: `~/Frely`. The home directory itself is no longer the default. */
export const DEFAULT_WORKSPACE_NAME = "Frely";

export const defaultWorkspacePath = (home: string = homedir()): string => join(home, DEFAULT_WORKSPACE_NAME);

/** Creates the default workspace when it is missing and returns its real path. */
export async function ensureDefaultWorkspace(home: string = homedir()): Promise<string> {
  const path = defaultWorkspacePath(home);
  await mkdir(path, { recursive: true });
  return realpath(path);
}
