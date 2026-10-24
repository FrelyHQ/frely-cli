import { createHash } from "node:crypto";
import { readFile, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeItemFolder } from "./cloud-item.js";
import { managedSkillRoot, type SkillHost, type SkillScope } from "./managed.js";

export const ENTRY_SKILL_ID = "frely-entry";

/** Teaches an agent with a shell to use Frely through the CLI, and when to offer FrelyMCP. */
export const ENTRY_SKILL = `---
name: frely
description: Use when the user wants to work with their Frely account or the Frely marketplace through the frely CLI (credits, API keys, plans, orders, installing a Frely Skill or Agent), or wants to connect a computer or an AI client to FrelyMCP.
---

Use the installed \`frely\` CLI. Do not rely on remembered syntax: run \`frely help --agent --json\` for the current command contract, and \`frely update\` if a command is missing.

## Sign in

Run \`frely doctor --json\` to see whether the CLI is signed in. If not, ask the user for their email, run \`frely login --email <address>\`, ask them for the 6-digit code from the email, then run \`frely login --code <code>\`. New addresses are registered by the same steps. Do not add \`--mcp\`: it opens this computer to remote clients.

## Account and marketplace

- Account operations (API keys, Credit, plans, orders, Creator items): \`frely api list\`, \`frely api describe <tool>\`, \`frely api call <tool> --json '{...}'\`. The first call needs a browser authorization the user completes; if it fails because there is no terminal, tell the user to run the command once themselves.
- Ask the user before any call that spends Credit, buys something or changes credentials. Some actions also need a one-time approval on the Frely website; give the user the link from the error.
- Install a marketplace Skill or Prompt: \`frely item install <item-id> --host <your host>\`. Install a published Agent: \`frely agent install <id> --host <your host>\`, then \`frely agent run\`. Review installed items with the frely-item-guard Skill before using them.

## What needs FrelyMCP

The steps above work without FrelyMCP. FrelyMCP is only needed to control another computer, use Cloud MCPs the user bought, drive a connected browser, or use Frely from a client with no shell (web ChatGPT or Claude).

Check whether you already have it: your tool list has Frely tools such as \`list_devices\` or \`frely_list\`; or run \`claude mcp list\` (Claude Code) or \`codex mcp list\` (Codex) and look for \`frely\`.

If the user's request needs FrelyMCP and you do not have it, say so once in this conversation, in your own words: this needs Frely's remote connection, everything else already works, and setting it up takes one browser approval. Do nothing until the user agrees, and do not raise it again if they decline or when the request does not need it. If they agree:

1. Run \`frely mcp start\`. When it prints a sign-in or approval link, send the link and keep the command running while the user approves. It prints the MCP URL.
2. Add it to your client: \`claude mcp add --transport http frely "https://mcp.frely.cloud/mcp"\` or \`codex mcp add frely --url "https://mcp.frely.cloud/mcp"\`. For any other client, give the user the URL and ask them to add it as a remote MCP server with OAuth.
3. Tell the user to finish the OAuth authorization in their browser, then check with "list my Frely devices".

Never put keys or tokens on a command line or in a file; use \`--api-key-stdin\` where the CLI offers it.
`;

export interface EntrySkillInstallResult {
  readonly name: "frely";
  readonly path: string;
}

/** Writes (or refreshes) the entry Skill; a folder Frely did not write, or one the user edited, is never overwritten. */
export async function installEntrySkill(input: {
  readonly host?: SkillHost;
  readonly scope?: SkillScope;
  readonly cwd?: string;
  readonly home?: string;
}): Promise<EntrySkillInstallResult> {
  const root = managedSkillRoot(input.host ?? "generic", input.scope ?? "global", input.cwd ?? process.cwd(), input.home ?? homedir());
  const path = join(root, "frely");
  await writeItemFolder(path, ENTRY_SKILL_ID, [{ path: "SKILL.md", contentBase64: Buffer.from(ENTRY_SKILL).toString("base64"), isScript: false }]);
  return Object.freeze({ name: "frely", path });
}

/** True when the folder holds the entry Skill exactly as Frely wrote it. */
export async function isUntouchedEntrySkill(folder: string): Promise<boolean> {
  const marker = await readFile(join(folder, ".frely-managed.json"), "utf8").then((raw) => JSON.parse(raw) as { owner?: unknown; itemId?: unknown; files?: Record<string, unknown> }, () => null);
  if (marker?.owner !== "frely-cli-cloud-item" || marker.itemId !== ENTRY_SKILL_ID || typeof marker.files?.["SKILL.md"] !== "string") return false;
  const text = await readFile(join(folder, "SKILL.md")).catch(() => null);
  return text !== null && createHash("sha256").update(text).digest("hex") === marker.files["SKILL.md"];
}

export async function removeEntrySkill(folder: string): Promise<void> {
  if (!await isUntouchedEntrySkill(folder)) throw new Error("the Skill was modified; left in place");
  await unlink(join(folder, "SKILL.md"));
  await unlink(join(folder, ".frely-managed.json"));
  await rmdir(folder).catch(() => undefined);
}
