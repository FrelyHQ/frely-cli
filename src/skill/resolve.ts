import { CloudToolError } from "./cloud-item.js";

type Call = (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** What a name is for the signed-in account (the server's items.resolve / items.claim_install answer). */
export interface ResolvedItem {
  readonly kind: "skill" | "agent" | "remote_mcp" | "github_skill";
  readonly id: string;
  readonly name: string;
  readonly version: number | null;
  /** A listed public GitHub Skill: the repository and the exact commit Frely's page shows. Frely holds no files for it. */
  readonly github?: { readonly login: string; readonly repo: string; readonly commitSha: string; readonly license: string | null; readonly hasScripts: boolean };
  /** An Agent's manifest as this account sees it. */
  readonly manifest?: unknown;
  /** Only after items.claim_install: the account that claimed and installs. */
  readonly claimedBy?: { readonly id: string; readonly email: string | null };
  readonly gift?: Readonly<Record<string, unknown>>;
  /** Only for a remote MCP after items.claim_install: the product key and address, made under the same approval. */
  readonly connect?: Record<string, unknown>;
}

const KINDS = new Set(["skill", "agent", "remote_mcp", "github_skill"]);

function asResolved(value: Record<string, unknown>): ResolvedItem {
  if (typeof value.kind !== "string" || !KINDS.has(value.kind) || typeof value.id !== "string" || typeof value.name !== "string") throw new CloudToolError("invalid_operation_output");
  return value as unknown as ResolvedItem;
}

/** A server that predates these tools answers `tool_unavailable_or_forbidden`; the caller then keeps the older name-by-name lookup. */
const unavailable = (error: unknown): boolean => error instanceof CloudToolError && error.code === "tool_unavailable_or_forbidden";

/** Read-only: what `username/name[@version]` is for this account. `null` only when the server has no such tool; a name the account cannot see throws item_not_found. */
export async function resolveItem(name: string, call: Call): Promise<ResolvedItem | null> {
  try { return asResolved(await call("items.resolve", { name })); }
  catch (error) {
    if (unavailable(error)) return null;
    if (error instanceof CloudToolError && error.code === "item_not_found") throw new ItemNotFoundError(name, false);
    throw error;
  }
}

/**
 * The one approval an install may need: claim the gift (if any) and resolve the item, with the owner's confirmation on the web showing the
 * account, the item and the gift. `call` waits for that confirmation. `null` when the server has no such tool.
 */
export async function claimInstall(name: string, gift: string | undefined, call: Call): Promise<ResolvedItem | null> {
  try { return asResolved(await call("items.claim_install", { name, ...(gift === undefined ? {} : { gift }) })); }
  catch (error) {
    if (unavailable(error)) return null;
    if (error instanceof CloudToolError && error.code === "item_not_found") throw new ItemNotFoundError(name, gift !== undefined);
    // The server claimed the gift first and the lookup still failed: the gift is spent, so do not say it was not claimed.
    if (error instanceof CloudToolError && error.code === "item_not_found_after_claim") throw new ItemNotFoundError(name, true, true);
    throw error;
  }
}

export class ItemNotFoundError extends Error {
  constructor(name: string, readonly hadGift: boolean, readonly giftClaimed = false) {
    super(`This account sees no Skill, Prompt, Agent or MCP named ${name}.${giftClaimed ? " The gift was claimed; run the command again to install it." : hadGift ? " The gift was not claimed." : " If you have a gift code, run the command again with --gift <code>."}`);
    this.name = "ItemNotFoundError";
  }
}
