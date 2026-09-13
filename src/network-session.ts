import type { CredentialStore } from "./credential-store.js";
import { NetworkError } from "./network-errors.js";
import { NetworkHttp, isRecord, UUID_PATTERN } from "./network-http.js";
import { ACCESS_TOKEN_PATTERN, NETWORK_SERVICE, parsePendingGrant, parseSessionView, validExpiry, networkServerError,
  type NetworkState, type PendingGrant, type StoredNetworkSession, type NetworkSessionView } from "./network-contract.js";

export type ResolvedNetworkSession = { kind: "none"; reason?: string } |
  { kind: "pending"; value: PendingGrant } | { kind: "ready"; credential: StoredNetworkSession; view: NetworkSessionView };

/** Keep Network credentials separate from the Frely account and device-relay sessions. */
export class NetworkSessions {
  constructor(private readonly origin: string, private readonly store: CredentialStore,
    private readonly http: NetworkHttp, private readonly now: () => number) {}
  async save(value: Exclude<NetworkState, null>): Promise<void> {
    try { await this.store.setPassword(NETWORK_SERVICE, this.origin, JSON.stringify(value)); }
    catch { throw new NetworkError("CREDENTIAL_STORE_FAILED"); }
  }
  async remove(): Promise<void> {
    try { await this.store.deletePassword(NETWORK_SERVICE, this.origin); }
    catch { throw new NetworkError("CREDENTIAL_STORE_FAILED"); }
  }
  async read(): Promise<NetworkState> {
    let text: string | null;
    try { text = await this.store.getPassword(NETWORK_SERVICE, this.origin); }
    catch { throw new NetworkError("CREDENTIAL_STORE_FAILED"); }
    if (!text) return null;
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new NetworkError("CREDENTIAL_STATE_INVALID"); }
    if (!isRecord(value) || value.version !== 1 || !validExpiry(value.expiresAt)) throw new NetworkError("CREDENTIAL_STATE_INVALID");
    if (value.kind === "pending") return parsePendingGrant({ ...value, paymentMode: "platform_demo" }, this.origin);
    if (value.kind !== "session" || typeof value.accessToken !== "string" || !ACCESS_TOKEN_PATTERN.test(value.accessToken) ||
        typeof value.sessionId !== "string" || !UUID_PATTERN.test(value.sessionId)) throw new NetworkError("CREDENTIAL_STATE_INVALID");
    return { version: 1, kind: "session", accessToken: value.accessToken, expiresAt: value.expiresAt, sessionId: value.sessionId };
  }
  async resolve(state: NetworkState): Promise<ResolvedNetworkSession> {
    if (!state) return { kind: "none" };
    if (Date.parse(state.expiresAt) <= this.now()) { await this.remove(); return { kind: "none", reason: "AUTHORIZATION_EXPIRED" }; }
    if (state.kind === "pending") {
      const response = await this.http.request(this.origin, "/api/network/device/token", { body: { deviceCode: state.deviceCode } });
      const value = this.http.parse(response, [state.deviceCode]);
      if (response.status === 202) {
        if (value.status !== "awaiting_wallet" || !Number.isSafeInteger(value.intervalSeconds) || Number(value.intervalSeconds) < 1) throw new NetworkError("NETWORK_RESPONSE_INVALID");
        return { kind: "pending", value: state };
      }
      if (response.status !== 200) {
        const error = networkServerError(value);
        if (["DEVICE_EXPIRED", "DEVICE_CONSUMED", "DEVICE_REJECTED"].includes(error.code)) { await this.remove(); return { kind: "none", reason: error.code }; }
        throw error;
      }
      const view = parseSessionView(value);
      if (typeof value.accessToken !== "string" || !ACCESS_TOKEN_PATTERN.test(value.accessToken) || Date.parse(view.expiresAt) <= this.now()) throw new NetworkError("NETWORK_RESPONSE_INVALID");
      state = { version: 1, kind: "session", accessToken: value.accessToken, expiresAt: view.expiresAt, sessionId: view.sessionId };
      await this.save(state);
    }
    const response = await this.http.request(this.origin, "/api/network/session", { token: state.accessToken });
    const value = this.http.parse(response, [state.accessToken]);
    if (response.status === 401) { await this.remove(); return { kind: "none", reason: networkServerError(value).code }; }
    if (response.status !== 200) throw networkServerError(value);
    const view = parseSessionView(value);
    if (view.sessionId !== state.sessionId || Date.parse(view.expiresAt) <= this.now()) throw new NetworkError("NETWORK_RESPONSE_INVALID");
    return { kind: "ready", credential: state, view };
  }
  async logout(state: NetworkState): Promise<Record<string, unknown>> {
    if (state?.kind === "session") {
      let revoked = false;
      try {
        const response = await this.http.request(this.origin, "/api/network/session", { method: "DELETE", token: state.accessToken });
        const value = this.http.parse(response, [state.accessToken]);
        revoked = response.status === 200 && value.status === "revoked";
      } catch { /* Report an unconfirmed revocation as a failure. */ }
      await this.remove();
      if (!revoked) throw new NetworkError("REVOCATION_UNCONFIRMED", { remoteRevocation: false,
        recovery: "The local credential was removed. The remote session expires at its original expiry." });
      return { status: "logged_out", remoteRevocation: true, origin: this.origin };
    }
    await this.remove();
    return { status: "logged_out", remoteRevocation: false, origin: this.origin, pendingGrantExpiresAt: state?.expiresAt ?? null };
  }
}
