import { homedir } from "node:os";
import { resolve } from "node:path";
import { CLOUD_SKILL_ID, CloudItemError, installCloudItem, latestItemVersion, type CloudItemInstallResult, type CloudToolCaller } from "./cloud-item.js";
import { listInstalls, readInstall } from "./registry.js";

/** One installed item and whether Frely serves a newer version of it. */
export interface ItemUpdateStatus {
  readonly path: string;
  readonly itemId: string;
  /** The installed version, or null for a folder installed by an older CLI that did not record it. */
  readonly installed: number | null;
  readonly latest: number;
  readonly state: "current" | "available" | "unknown";
}

/**
 * Compares every item `frely item install` wrote with what Frely serves now. It reads only; nothing on disk changes. An update is applied
 * only by `updateCloudItem`, which the person runs for one folder.
 */
export async function checkItemUpdates(input: { readonly call: CloudToolCaller; readonly home?: string }): Promise<ItemUpdateStatus[]> {
  const records = (await listInstalls(input.home ?? homedir())).filter((record) => record.kind !== "entry" && CLOUD_SKILL_ID.test(record.itemId));
  const statuses: ItemUpdateStatus[] = [];
  for (const record of records) {
    const latest = await latestItemVersion(input.call, record.itemId);
    const installed = record.itemVersion ?? null;
    statuses.push({ path: record.path, itemId: record.itemId, installed, latest, state: installed === null ? "unknown" : installed < latest ? "available" : "current" });
  }
  return statuses;
}

/** Installs the current version into the folder Frely wrote earlier. A folder edited since install is refused, like a reinstall. */
export async function updateCloudItem(input: { readonly folder: string; readonly call: CloudToolCaller; readonly home?: string; readonly env?: NodeJS.ProcessEnv }): Promise<CloudItemInstallResult> {
  const home = input.home ?? homedir();
  const record = await readInstall(resolve(input.folder), home);
  if (!record || record.kind === "entry" || !CLOUD_SKILL_ID.test(record.itemId)) throw new CloudItemError("item_invalid", "This folder was not installed by frely item install.");
  return installCloudItem({ skillId: record.itemId, call: input.call, target: record.path, home, ...(input.env ? { env: input.env } : {}) });
}
