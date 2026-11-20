import { pinTrustChain, readTrust, trustDirectory, type SignedTrustRecord, type TrustPin } from "./record.js";
import { TrustError } from "./webauthn.js";

export interface TrustScope { relayUrl: string; userId: string }
export type TrustSyncResult = { status: "pinned"; pin: TrustPin } | { status: "none" } | { status: "refused"; code: string };

/**
 * Pull the account's trust record chain and pin it. The device checks every version itself, so the relay is only a courier:
 * a refused chain (wrong origin, wrong account, rollback, fork) leaves the earlier pin untouched. An account without a chain
 * is not an error: nothing can be approved by signature until the Owner sets one up.
 */
export async function syncTrust(fetchChain: () => Promise<readonly SignedTrustRecord[]>, scope: TrustScope): Promise<TrustSyncResult> {
  const chain = await fetchChain();
  if (chain.length === 0) return { status: "none" };
  try {
    const pin = await pinTrustChain(chain, scope.userId, trustDirectory(scope));
    return pin ? { status: "pinned", pin } : { status: "none" };
  } catch (error) {
    if (error instanceof TrustError) return { status: "refused", code: error.code };
    throw error;
  }
}

/** What this device holds for the account; `undefined` before the first pin. */
export async function heldTrust(scope: TrustScope): Promise<TrustPin | undefined> {
  return (await readTrust(trustDirectory(scope)))?.pin;
}
