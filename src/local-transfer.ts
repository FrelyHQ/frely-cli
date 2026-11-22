import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { transferDownload, transferPrepare, transferUpload, type TransferTarget } from "./runtime/transfer.js";
import { Workspace } from "./runtime/workspace.js";

/**
 * Upload and download of a file on this computer over presigned URLs, for `frely put` / `frely get`. It sits outside src/controller
 * (which may not import runtime code) and reuses the device-side helpers: https only, public addresses pinned, no redirects, SHA-256.
 * The file's own folder is the workspace, so the helpers' symlink and credential-folder protections apply to it as on a device.
 */
export interface LocalUpload { name: string; bytes: number; sha256: string; send(target: TransferTarget, signal: AbortSignal): Promise<void> }

export async function prepareLocalUpload(path: string): Promise<LocalUpload> {
  const full = resolve(path);
  const workspace = await Workspace.open(dirname(full));
  const prepared = await transferPrepare(workspace, basename(full));
  return { ...prepared, send: async (target, signal) => { await transferUpload(workspace, basename(full), target, prepared, signal); } };
}

export async function downloadToLocalFile(path: string, target: TransferTarget, expected: { bytes: number; sha256: string }, overwrite: boolean, signal: AbortSignal): Promise<void> {
  const full = resolve(path);
  await mkdir(dirname(full), { recursive: true });
  await transferDownload(await Workspace.open(dirname(full)), basename(full), target, expected, overwrite, signal);
}
