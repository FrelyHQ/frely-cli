import { createHash } from "node:crypto";
import { rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { VERSION } from "../version.js";
import { unlinkSkill, type LinkOutcome } from "./agent-links.js";
import { CloudItemError, writeItemFolder } from "./cloud-item.js";
import { managedSkillRoot, type SkillHost, type SkillScope } from "./managed.js";
import { deleteInstall, listInstalls, readInstall, untouched } from "./registry.js";

export const ENTRY_SKILL_ID = "frely-entry";

/** Where Frely answers with the entry Skill this CLI is new enough for (`?cliVersion=`). */
const ENTRY_SKILL_PATH = "/api/public/entry-skill";
/** A Skill file is small; a larger answer is not an entry Skill and is refused unread. */
const MAX_ENTRY_SKILL_BYTES = 64 * 1024;
/** A refresh never holds up an install: Frely unreachable means the copy this CLI shipped with is used. */
const ENTRY_SKILL_TIMEOUT_MS = 5_000;

/** Teaches an agent with a shell to use Frely through the CLI, and when to offer FrelyMCP. */
export const ENTRY_SKILL = `---
name: frely
description: Use when the user wants to work with their Frely account or the Frely marketplace through the frely CLI (credits, API keys, plans, orders, installing a Frely Skill or Agent), or wants to connect a computer or an AI client to FrelyMCP.
---

Use the installed \`frely\` CLI. Do not rely on remembered syntax: run \`frely help --agent --json --summary\` for the grouped command index, then \`frely help --agent --json <command id or group>\` (for example \`agent\` or \`agent.run\`) for full usage, examples and confirmation notes, and \`frely update\` if a command is missing.

## Sign in

Run \`frely doctor --json\` to see whether the CLI is signed in. If not, ask the user for their email, run \`frely login --email <address>\`, ask them for the 6-digit code from the email, then run \`frely login --code <code>\`. New addresses are registered by the same steps.

## Account and marketplace

- Account operations (API keys, Credit, plans, orders, Creator items): \`frely api list\`, \`frely api describe <tool>\`, \`frely api call <tool> --json '{...}'\`. The first call needs a browser authorization the user completes; if it fails because there is no terminal, tell the user to run the command once themselves.
- Ask the user before any call that spends Credit, buys something or changes credentials. Some actions also need a one-time approval on the Frely website; give the user the link from the error.
- When a prompt carries a gift (\`gift=<code>\`), run exactly one command: \`frely item install <item> --gift <code> --host <your host> --json\`. It checks the account, claims the gift, installs and waits for the user's single confirmation on the Frely website by itself; do not run other commands first, and do not try other commands if it fails. If its output has an \`approval\` object, show \`approval.url\` alone on its own line, exactly as given, never translated or joined to other text, and \`approval.code\` on a separate line, then wait; exit code 3 means run the same command again after the user confirms. Show the \`claimedBy\` account to the user.
- Install a marketplace Skill or Prompt: \`frely item install <username/skill-name> --host <your host> --json\`; add \`--scope project --dir <project>\` to install it for one project instead of globally. The same command installs a published Agent (\`frely item install <username/name> --host <your host>\`); then use \`frely agent run\`. When an Agent needs the user's project files, add \`--read\` (optionally \`--read <dir>\`): the Agent can then read files of that directory through read-only tools that run on this computer, only the files it asks for; \`.git\`, \`.env*\`, key files and git-ignored files are never sent, and the result lists the files read. Tell the user before you add it. If the user's work is not in a git repository (a writing folder, for example), always give the directory itself: \`--read <the workspace directory>\`. Reading is all an Agent can do on this computer; it cannot write files. If \`frely agent run\` returns \`payment_required\`, the balance is too low: do not ask the user to sign in again; run \`frely api call credit_products.list --json '{}'\`, ask which amount, then \`frely api call payment_checkout.create\` with \`useImmediately\` true, give the user the returned \`checkoutUrl\`, and retry once they have paid. If the install output says Frely has not scanned a Skill, read every file in it before you use it, and tell the user if anything looks unsafe.
- Run the scripts of an installed Skill with \`frely item run <script path> [args...]\` instead of calling an interpreter yourself: it runs the script inside the Frely command sandbox. This covers paid (encrypted) scripts and plain ones; a command the Skill's own instructions give directly is not covered, so read it before you run it.
- Use a marketplace MCP without configuring it in your client: \`frely item install <username/mcp-name>\` installs a Skill that calls it through \`frely item tools|call <username/mcp-name>\`. Each call is billed or needs a pass as in any MCP client. \`frely item config <username/mcp-name>\` prints the \`mcpServers\` JSON for clients that should connect to that one MCP directly.

## What needs FrelyMCP

The steps above work without FrelyMCP. FrelyMCP is only needed to control another computer, use Cloud MCPs the user bought, drive a connected browser, or use Frely from a client with no shell (web ChatGPT or Claude).

Check whether you already have it: your tool list has Frely tools such as \`list_devices\` or \`frely_list\`; or run \`claude mcp list\` (Claude Code) or \`codex mcp list\` (Codex) and look for \`frely\`.

If the user's request needs FrelyMCP and you do not have it, say so once in this conversation, in your own words: this needs Frely's remote connection, everything else already works, and setting it up takes one browser approval. Do nothing until the user agrees, and do not raise it again if they decline or when the request does not need it. If they agree:

1. Run \`frely link on\`. When it prints a sign-in or approval link, send the link and keep the command running while the user approves. It prints the MCP URL.
2. Add it to your client: \`claude mcp add --transport http frely "https://mcp.frely.cloud/mcp"\` or \`codex mcp add frely --url "https://mcp.frely.cloud/mcp"\`. For any other client, give the user the URL and ask them to add it as a remote MCP server with OAuth.
3. Tell the user to finish the OAuth authorization in their browser, then check with "list my Frely devices".

Never put keys or tokens on a command line or in a file; use \`--api-key-stdin\` where the CLI offers it.
`;

export interface EntrySkillInstallResult {
  readonly name: "frely";
  readonly path: string;
  readonly links: readonly LinkOutcome[];
  /** Frely's revision of the text when it came from the server; absent when the copy this CLI ships with was written. */
  readonly version?: string;
}

/** Frely's current entry Skill for one CLI version. */
export interface RemoteEntrySkill {
  readonly version: string;
  readonly minCliVersion: string;
  readonly content: string;
}

function parseVersion(value: string): readonly [number, number, number] | null {
  const match = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:[-+][0-9A-Za-z.-]{1,32})?$/u.exec(value.trim());
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when this CLI is new enough for a document: `version` is at least `minimum`. */
function atLeast(version: string, minimum: string): boolean {
  const asked = parseVersion(version);
  const floor = parseVersion(minimum);
  if (asked === null || floor === null) return false;
  for (let i = 0; i < 3; i++) {
    if (asked[i]! !== floor[i]!) return asked[i]! > floor[i]!;
  }
  return true;
}

/**
 * The entry Skill Frely keeps for this CLI version, fetched so the instructions an assistant follows can change between CLI releases.
 * Every failure — no relay, older server without the endpoint, a body that is not the hash it claims, a document meant for a newer CLI —
 * answers null, and the caller writes the copy this CLI shipped with.
 */
export async function fetchEntrySkill(input: {
  readonly relayUrl: string;
  readonly cliVersion?: string;
  readonly fetchFn?: typeof fetch;
}): Promise<RemoteEntrySkill | null> {
  const cliVersion = input.cliVersion ?? VERSION;
  let url: URL;
  try { url = new URL(ENTRY_SKILL_PATH, input.relayUrl); } catch { return null; }
  url.searchParams.set("cliVersion", cliVersion);
  const fetchFn = input.fetchFn ?? fetch;
  try {
    const response = await fetchFn(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(ENTRY_SKILL_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_ENTRY_SKILL_BYTES * 2) return null;
    const payload = JSON.parse(text) as Record<string, unknown>;
    const { contentBase64, version, minCliVersion } = payload;
    if (typeof contentBase64 !== "string" || typeof version !== "string" || typeof minCliVersion !== "string") return null;
    const bytes = Buffer.from(contentBase64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ENTRY_SKILL_BYTES) return null;
    if (typeof payload.sha256 === "string" && createHash("sha256").update(bytes).digest("hex") !== payload.sha256) return null;
    if (!atLeast(cliVersion, minCliVersion)) return null;
    const content = bytes.toString("utf8");
    // The text lands in a Skill folder as-is: only a whole SKILL.md may be written there.
    if (!/^---\r?\nname: frely\r?\n/u.test(content)) return null;
    return Object.freeze({ version, minCliVersion, content });
  } catch {
    return null;
  }
}

/**
 * The entry Skill beside a freshly installed item, so one `frely item install` command is all an agent needs. A folder Frely did not
 * write, or one the user edited, is skipped, not an error: the item wins and its install never fails on the entry Skill.
 */
export async function ensureEntrySkill(input: {
  readonly host?: SkillHost;
  readonly scope?: SkillScope;
  readonly dir?: string;
  readonly cwd?: string;
  readonly home?: string;
  /** Where to ask for the current text; without it the copy this CLI ships with is written. */
  readonly relayUrl?: string;
  readonly cliVersion?: string;
  readonly fetchFn?: typeof fetch;
}): Promise<EntrySkillInstallResult | null> {
  return installEntrySkill(input).catch((error: unknown) => {
    if (error instanceof CloudItemError && (error.code === "unmanaged_item_exists" || error.code === "managed_item_modified")) return null;
    throw error;
  });
}

/**
 * Writes (or refreshes) the entry Skill, asking Frely first when `relayUrl` is given so the text is never older than this CLI's release; a
 * folder Frely did not write, or one the user edited, is never overwritten. For the project scope `dir` is the project root (default: the
 * current directory).
 */
export async function installEntrySkill(input: {
  readonly host?: SkillHost;
  readonly scope?: SkillScope;
  readonly dir?: string;
  readonly cwd?: string;
  readonly home?: string;
  readonly relayUrl?: string;
  readonly cliVersion?: string;
  readonly fetchFn?: typeof fetch;
}): Promise<EntrySkillInstallResult> {
  const home = input.home ?? homedir();
  const project = resolve(input.cwd ?? process.cwd(), input.dir ?? ".");
  const path = join(managedSkillRoot(input.host ?? "generic", input.scope ?? "global", project, home), "frely");
  const remote = input.relayUrl === undefined ? null : await fetchEntrySkill({
    relayUrl: input.relayUrl,
    ...(input.cliVersion === undefined ? {} : { cliVersion: input.cliVersion }),
    ...(input.fetchFn === undefined ? {} : { fetchFn: input.fetchFn }),
  });
  const written = await writeItemFolder(path, ENTRY_SKILL_ID, "entry", [{ path: "SKILL.md", contentBase64: Buffer.from(remote?.content ?? ENTRY_SKILL).toString("base64"), isScript: false }], home, undefined, input.host ? { host: input.host } : {});
  return Object.freeze({ name: "frely", path, links: written.linkOutcomes, ...(remote === null ? {} : { version: remote.version }) });
}

/** Every entry Skill Frely wrote, in any host and scope, that is still exactly as written. */
export async function untouchedEntrySkills(home = homedir()): Promise<string[]> {
  const found: string[] = [];
  for (const record of await listInstalls(home)) if (record.kind === "entry" && await untouched(record)) found.push(record.path);
  return found;
}

export async function removeEntrySkill(folder: string, home = homedir()): Promise<void> {
  const record = await readInstall(folder, home);
  if (!record || record.kind !== "entry" || !await untouched(record)) throw new Error("the Skill was modified; left in place");
  await unlinkSkill(record.links, folder, record.files);
  for (const path of Object.keys(record.files)) await unlink(join(folder, path));
  await rmdir(folder).catch(() => undefined);
  await deleteInstall(folder, home);
}
