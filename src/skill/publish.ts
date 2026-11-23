import { crc32, deflateRawSync } from "node:zlib";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { CloudItemError, type CloudToolCaller } from "./cloud-item.js";

/** The zero-cost Creator tier's limits (relay `CLOUD_SKILL_FREE_LIMITS`); checked here so a package fails before it is uploaded. */
export const PUBLISH_LIMITS = Object.freeze({ maxFiles: 64, maxFileBytes: 64 * 1024, maxTotalBytes: 128 * 1024, maxZipBytes: 256 * 1024 });
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
/** Never part of a published Skill: project configuration, caches and dependency trees stay on the author's computer. */
const EXCLUDED_NAMES = new Set(["skills-config", "node_modules", "__MACOSX"]);

export interface PackagedSkill {
  readonly files: readonly { readonly path: string; readonly content: Buffer }[];
  readonly name: string;
  readonly description: string | undefined;
  readonly totalBytes: number;
}

export interface PublishedItem {
  readonly installName: string;
  readonly version: number;
  readonly created: boolean;
  readonly unchanged: boolean;
  readonly hasScripts: boolean;
  readonly fileCount: number;
  readonly notices: readonly string[];
}

/** Reads a Skill folder into the files that get published: dotfiles, `skills-config`, `node_modules` and symlinks are never included. */
export async function packageSkillFolder(folder: string): Promise<PackagedSkill> {
  const root = resolve(folder);
  const info = await lstat(root).catch(() => null);
  if (info === null || !info.isDirectory()) throw new CloudItemError("input_invalid", `${folder} is not a folder.`);
  const files: { path: string; content: Buffer }[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith(".") || EXCLUDED_NAMES.has(entry.name)) continue;
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new CloudItemError("input_invalid", `${path} is a symbolic link; replace it with the real file before publishing.`);
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else if (entry.isFile()) files.push({ path, content: await readFile(join(directory, entry.name)) });
    }
  };
  await walk(root, "");
  const entry = files.find((file) => file.path === "SKILL.md");
  if (entry === undefined) throw new CloudItemError("input_invalid", "The folder has no SKILL.md at its top level.");
  const totalBytes = files.reduce((sum, file) => sum + file.content.length, 0);
  if (files.length > PUBLISH_LIMITS.maxFiles) throw new CloudItemError("input_invalid", `The Skill has ${files.length} files; the limit is ${PUBLISH_LIMITS.maxFiles}.`);
  const big = files.find((file) => file.content.length > PUBLISH_LIMITS.maxFileBytes);
  if (big !== undefined) throw new CloudItemError("input_invalid", `${big.path} is ${big.content.length} bytes; a file may be at most ${PUBLISH_LIMITS.maxFileBytes}.`);
  if (totalBytes > PUBLISH_LIMITS.maxTotalBytes) throw new CloudItemError("input_invalid", `The Skill is ${totalBytes} bytes in total; the limit is ${PUBLISH_LIMITS.maxTotalBytes}.`);
  const { name, description } = readFrontmatter(entry.content.toString("utf8"));
  return { files, name, description, totalBytes };
}

function readFrontmatter(text: string): { name: string; description: string | undefined } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  let data: unknown;
  try { data = match === null ? null : parse(match[1]!); } catch { data = null; }
  const record = data !== null && typeof data === "object" ? data as Record<string, unknown> : null;
  if (record === null || typeof record.name !== "string" || record.name.trim() === "") throw new CloudItemError("input_invalid", "SKILL.md needs frontmatter with a name.");
  return { name: record.name.trim(), description: typeof record.description === "string" && record.description.trim() !== "" ? record.description.trim() : undefined };
}

/** A zip archive of the files (deflate, fixed timestamp), readable by any unzip tool. */
export function buildZip(files: readonly { readonly path: string; readonly content: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const dosTime = 0, dosDate = (1 << 5) | 1; // 1980-01-01 00:00: the archive is reproducible
  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const data = deflateRawSync(file.content);
    const crc = crc32(file.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(file.content.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8); head.writeUInt16LE(8, 10);
    head.writeUInt16LE(dosTime, 12); head.writeUInt16LE(dosDate, 14); head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20); head.writeUInt32LE(file.content.length, 24); head.writeUInt16LE(name.length, 28); head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** A `--premium` entry is an exact file or a folder prefix ending in `/`; it must match something in the package. */
function checkPremiumPaths(premium: readonly string[], files: readonly { readonly path: string }[]): void {
  for (const entry of premium) {
    if (entry === "SKILL.md") throw new CloudItemError("input_invalid", "SKILL.md is always free: it tells the agent how to fetch the paid part.");
    const matches = entry.endsWith("/") ? files.some((file) => file.path.startsWith(entry)) : files.some((file) => file.path === entry);
    if (!matches) throw new CloudItemError("input_invalid", `--premium ${entry} matches no file of the package.`);
  }
}

/** Publishes a Skill folder as a new version of `slug` (default: the SKILL.md name). The same slug again is a new version. */
export async function publishSkillFolder(input: { readonly folder: string; readonly slug?: string; readonly premium?: readonly string[]; readonly call: CloudToolCaller }): Promise<PublishedItem & { readonly slug: string }> {
  const packaged = await packageSkillFolder(input.folder);
  const slug = input.slug ?? packaged.name;
  if (!SLUG.test(slug)) throw new CloudItemError("input_invalid", `The slug "${slug}" must be 1-40 lowercase letters, digits or hyphens; pass --slug <slug>.`);
  const premium = input.premium ?? [];
  checkPremiumPaths(premium, packaged.files);
  const zip = buildZip(packaged.files);
  if (zip.length > PUBLISH_LIMITS.maxZipBytes) throw new CloudItemError("input_invalid", `The package is ${zip.length} bytes zipped; the limit is ${PUBLISH_LIMITS.maxZipBytes}.`);
  const result = await input.call("skills.publish", {
    kind: "skill", slug, displayName: packaged.name.slice(0, 120),
    ...(packaged.description === undefined ? {} : { description: packaged.description.slice(0, 1000) }),
    packageBase64: zip.toString("base64"), ...(premium.length === 0 ? {} : { premiumPaths: premium }),
  });
  const installName = typeof result.installName === "string" ? result.installName : slug;
  return {
    slug, installName, version: Number(result.version), created: result.created === true, unchanged: result.unchanged === true,
    hasScripts: result.hasScripts === true, fileCount: Number(result.fileCount ?? packaged.files.length),
    notices: Array.isArray(result.notices) ? result.notices.filter((value): value is string => typeof value === "string") : [],
  };
}

