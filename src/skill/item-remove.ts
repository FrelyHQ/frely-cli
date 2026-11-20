import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { unlinkSkill } from "./agent-links.js";
import { deleteInstall, listInstalls, readInstall, untouched, type InstallRecord } from "./registry.js";

/** One folder `frely item install` wrote for a Skill, Prompt or remote MCP, and what `frely item remove` did with it. */
export interface RemovedFolder {
  readonly path: string;
  /** `removed`: folder and links gone. `kept`: the folder was edited since install, so only its record and links went. */
  readonly state: "removed" | "kept";
}

/** Install records of one item (a Skill can sit in several places: global and per project). */
export async function installsOfItem(itemId: string, home = homedir()): Promise<InstallRecord[]> {
  return (await listInstalls(home)).filter((record) => record.kind !== "entry" && record.itemId === itemId);
}

/** The install record of a folder, when `frely item install` wrote it. */
export async function installAt(folder: string, home = homedir()): Promise<InstallRecord | null> {
  const record = await readInstall(resolve(folder), home).catch(() => null);
  return record && record.kind !== "entry" ? record : null;
}

/** Removes installed folders: their links in other agents first, then the folder unless it was edited, then the record. */
export async function removeInstalls(records: readonly InstallRecord[], home = homedir()): Promise<RemovedFolder[]> {
  const out: RemovedFolder[] = [];
  for (const record of records) {
    await unlinkSkill(record.links, record.path, record.files);
    const clean = await untouched(record);
    if (clean) await rm(record.path, { recursive: true, force: true });
    await deleteInstall(record.path, home);
    out.push({ path: record.path, state: clean ? "removed" : "kept" });
  }
  return out;
}
