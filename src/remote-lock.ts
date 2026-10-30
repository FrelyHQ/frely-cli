import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The local key of the three-state remote link: while this marker exists the state is `false` and only `frely link on` on this computer lifts it. */
export function remoteLockPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "remote", "local-lock");
}

export async function remoteLocked(): Promise<boolean> {
  return access(remoteLockPath()).then(() => true, () => false);
}

export async function setRemoteLock(locked: boolean): Promise<void> {
  const path = remoteLockPath();
  if (!locked) { await rm(path, { force: true }); return; }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, "remote control is turned off on this computer (frely link off)\n", { mode: 0o600 });
}

export type RemoteState = "null" | "true" | "false";

/** `false` wins over everything; `true` needs an active authorization; otherwise the default `null`. */
export function remoteState(input: { locked: boolean; authorized: boolean }): RemoteState {
  return input.locked ? "false" : input.authorized ? "true" : "null";
}
