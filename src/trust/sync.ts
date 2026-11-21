import { pinTrustChain, readTrust, trustDirectory, type SignedTrustRecord, type TrustAnchor, type TrustPin, type TrustRecord } from "./record.js";
import { TrustError } from "./webauthn.js";

export interface TrustScope { relayUrl: string; userId: string }
export type TrustSyncResult = { status: "pinned"; pin: TrustPin } | { status: "none" } | { status: "refused"; code: string };

/**
 * Pull the account's trust record chain and pin it. The device checks every version itself, so the relay is only a courier:
 * a refused chain (wrong origin, wrong account, rollback, fork) leaves the earlier pin untouched. An account without a chain
 * is not an error: nothing can be approved by signature until the Owner sets one up.
 */
export async function syncTrust(fetchChain: () => Promise<readonly SignedTrustRecord[]>, scope: TrustScope, anchor: TrustAnchor): Promise<TrustSyncResult> {
  const chain = await fetchChain();
  if (chain.length === 0) return { status: "none" };
  try {
    const pin = await pinTrustChain(chain, scope.userId, trustDirectory(scope), anchor);
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

/** Pulls the account's chain from the relay and pins it; best effort, a failure leaves the earlier pin. */
export type TrustRefresh = (scope: TrustScope) => Promise<unknown>;

/**
 * The pinned trust record, pulling the chain once when this device holds none yet. A chain the Owner set up after this
 * device connected is then used at once instead of failing with `no_trust_record` until the next reconnect.
 */
export async function readTrustOrRefresh(scope: TrustScope, refresh?: TrustRefresh): Promise<{ pin: TrustPin; record: TrustRecord } | undefined> {
  const directory = trustDirectory(scope);
  const held = await readTrust(directory);
  if (held || !refresh) return held;
  await refresh(scope).catch(() => undefined);
  return readTrust(directory);
}
