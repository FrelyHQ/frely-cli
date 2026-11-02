import { CloudToolError } from "./cloud-item.js";

const GIFT_CODE = /^fsl_[A-Za-z0-9_-]{32}$/u;

/**
 * Claims the share link a gift prompt carries (`frely item install <item> --gift <code>`) so the account can see, install and use the item.
 * A link is claimed once per account, so a repeat (for example after the login step of the same prompt) is not an error.
 */
export async function redeemGift(code: string, call: (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>, out: { write(text: string): unknown }): Promise<void> {
  if (!GIFT_CODE.test(code)) throw new Error("--gift takes the share code from the prompt (it starts with fsl_).");
  try {
    const value = await call("share_links.redeem", { code });
    out.write(`Gift claimed${typeof value.giftUnits === "number" && value.giftUnits > 0 ? ` (${value.giftUnits} Credit units added)` : ""}.\n`);
  } catch (error) {
    if (error instanceof CloudToolError && error.code === "creator_share_already_claimed") { out.write("Gift was already claimed by this account.\n"); return; }
    throw error;
  }
}
