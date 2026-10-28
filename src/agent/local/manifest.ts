import { parse } from "yaml";

/** What `frely.yaml` says about running the repository on this computer (the `local:` section). */
export interface LocalManifest {
  /** Display name; the repository name when the file has none. */
  name: string | undefined;
  /** Runs once after the download, inside the sandbox. */
  setup: string | undefined;
  /** Starts the Agent, inside the sandbox. */
  run: string;
  /** Extra sites the Agent needs beyond Frely's API. Each one needs the owner's approval. */
  network: readonly string[];
}

export class ManifestError extends Error {
  constructor(message: string) { super(message); this.name = "ManifestError"; }
}

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_COMMAND_CHARS = 500;
const MAX_NETWORK_HOSTS = 20;
/** A plain lower-case DNS name with at least one dot. No wildcards, ports, IP literals or `localhost`. */
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/u;

export function isApprovableHost(value: unknown): value is string {
  return typeof value === "string" && HOST.test(value) && !/^\d+(?:\.\d+)+$/u.test(value) && !value.endsWith(".localhost") && !value.endsWith(".local");
}

const asObject = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function command(value: unknown, field: string, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new ManifestError(`frely.yaml: local.${field} is required.`);
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_COMMAND_CHARS || /[\0\r\n]/u.test(value)) {
    throw new ManifestError(`frely.yaml: local.${field} must be one line of at most ${MAX_COMMAND_CHARS} characters.`);
  }
  return value.trim();
}

/** Reads the `local:` section of a repository's `frely.yaml`. Throws ManifestError with a sentence the person can act on. */
export function parseManifest(text: string): LocalManifest {
  if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) throw new ManifestError("frely.yaml is larger than 64 KiB.");
  let document: unknown;
  try { document = parse(text, { maxAliasCount: 0 }); } catch (error) { throw new ManifestError(`frely.yaml is not valid YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`); }
  const root = asObject(document);
  if (!root) throw new ManifestError("frely.yaml must be a mapping.");
  const local = asObject(root.local);
  if (!local) throw new ManifestError("frely.yaml has no local: section, so this repository cannot run on this computer. It needs local.run (and optionally local.setup).");
  const name = root.name === undefined ? undefined : typeof root.name === "string" && root.name.trim() !== "" && root.name.length <= 100 && !/[\0\r\n]/u.test(root.name) ? root.name.trim() : (() => { throw new ManifestError("frely.yaml: name must be a short single line."); })();
  const hosts = local.network ?? [];
  if (!Array.isArray(hosts) || hosts.length > MAX_NETWORK_HOSTS) throw new ManifestError(`frely.yaml: local.network must be a list of at most ${MAX_NETWORK_HOSTS} site names.`);
  const network: string[] = [];
  for (const host of hosts) {
    if (!isApprovableHost(host)) throw new ManifestError(`frely.yaml: local.network entry ${JSON.stringify(host)} is not an exact site name such as pypi.org (no wildcards, ports or addresses).`);
    if (!network.includes(host)) network.push(host);
  }
  return { name, setup: command(local.setup, "setup", false), run: command(local.run, "run", true)!, network };
}
