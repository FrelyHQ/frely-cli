const MIB = 1024 * 1024;

/** Said wherever traffic is relayed through Frely: shares, services and local models all count against one weekly allowance. */
export const ALLOWANCE_NOTE = "Relayed traffic counts against your weekly relay allowance.";

export function remainingAllowanceLine(remainingBytes: number): string {
  return `${Math.floor(Math.max(0, remainingBytes) / MIB)} MiB of relay allowance left this week (UTC).`;
}

/**
 * The two lines `frely service share` and `frely provider share` print: what is left of this week's relay allowance, then the note.
 * When the amount cannot be fetched only the note is printed; the share itself never fails because of it.
 */
export async function relayAllowanceLines(fetchRemainingBytes: () => Promise<number>): Promise<string[]> {
  try {
    const remaining = await fetchRemainingBytes();
    if (Number.isFinite(remaining)) return [remainingAllowanceLine(remaining), ALLOWANCE_NOTE];
  } catch {
    // Fall through to the note alone.
  }
  return [ALLOWANCE_NOTE];
}
