export class NetworkError extends Error {
  constructor(readonly code: string, readonly details: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.name = "NetworkError";
  }
}

/** Expose bounded, client-owned fields rather than upstream messages or stack traces. */
export function publicNetworkError(error: unknown): Record<string, unknown> {
  if (!(error instanceof NetworkError)) return { status: "error", code: "NETWORK_CLIENT_FAILED" };
  const result: Record<string, unknown> = { status: "error", code: error.code };
  for (const name of ["requestId", "verificationUri", "userCode", "recovery", "remoteRevocation"]) {
    if (error.details[name] !== undefined) result[name] = error.details[name];
  }
  return result;
}
