/** How an eight-letter approval code is shown to people: ABCD-EFGH. Anything else is shown as it came. */
export function formatApprovalCode(code: string): string {
  return /^[A-HJ-NP-Z]{8}$/u.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** The approval code in a `/device?g=` link, shown as ABCD-EFGH, or null when the link carries none. */
export function approvalCodeOfLink(link: string): string | null {
  try { const code = new URL(link).searchParams.get("g"); return code ? formatApprovalCode(code) : null; } catch { return null; }
}
