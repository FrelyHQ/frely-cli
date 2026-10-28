/** What the relay returns for a service session (`POST /api/user/device-relay/services`, action session). */
export interface ServiceGrant {
  readonly id: string;
  readonly serviceShareId: string;
  readonly expiresAt: string;
  readonly node: string;
  readonly bandwidthBytesPerSecond: number;
  readonly remainingBytes: number;
  readonly frpc: {
    readonly serverAddr: string;
    readonly serverPort: number;
    readonly user: string;
    readonly token: string;
    readonly proxyName: "svc";
    readonly proxyType: "stcp";
    readonly secretKey: string;
    readonly allowUsers: readonly string[];
  };
}

export type ServiceType = "mcp" | "a2a";

/** A registered service as `register` and `list` return it. The local port is never part of it. */
export interface ServiceShareRecord { readonly id: string; readonly deviceId: string; readonly type: ServiceType; readonly label: string; readonly createdAt: string }

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:]{2,45}\])$/u;
const SECRET = /^[A-Za-z0-9_-]{20,128}$/u;
const VISITOR = /^[A-Za-z0-9_.-]{1,80}$/u;
export const SERVICE_SHARE_ID = /^svcs_[0-9a-f]{24}$/u;

/** Checks the grant's shape before anything of it reaches a process or a file; throws on anything unexpected. */
export function parseServiceGrant(value: unknown): ServiceGrant {
  const fail = (): never => { throw new Error("Frely returned an invalid service session."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const grant = value as Record<string, unknown>, frpc = grant.frpc as Record<string, unknown> | undefined;
  if (typeof grant.id !== "string" || !/^frps_[0-9a-f]{24}$/u.test(grant.id)) return fail();
  if (typeof grant.serviceShareId !== "string" || !SERVICE_SHARE_ID.test(grant.serviceShareId)) return fail();
  if (typeof grant.expiresAt !== "string" || !Number.isFinite(Date.parse(grant.expiresAt)) || typeof grant.node !== "string" || grant.node.length < 1 || grant.node.length > 64) return fail();
  if (typeof grant.bandwidthBytesPerSecond !== "number" || !Number.isFinite(grant.bandwidthBytesPerSecond) || grant.bandwidthBytesPerSecond < 0) return fail();
  if (typeof grant.remainingBytes !== "number" || !Number.isFinite(grant.remainingBytes) || grant.remainingBytes < 0) return fail();
  if (!frpc || typeof frpc !== "object" || Array.isArray(frpc)) return fail();
  const { serverAddr, serverPort, user, token, proxyName, proxyType, secretKey, allowUsers } = frpc;
  if (typeof serverAddr !== "string" || !HOST.test(serverAddr)) return fail();
  if (typeof serverPort !== "number" || !Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) return fail();
  if (user !== grant.id || typeof token !== "string" || !/^frs_[A-Za-z0-9_-]{20,64}$/u.test(token)) return fail();
  if (proxyName !== "svc" || proxyType !== "stcp") return fail();
  if (typeof secretKey !== "string" || !SECRET.test(secretKey)) return fail();
  if (!Array.isArray(allowUsers) || allowUsers.length < 1 || allowUsers.length > 4 || allowUsers.some((entry) => typeof entry !== "string" || !VISITOR.test(entry) || entry === "*")) return fail();
  return {
    id: grant.id, serviceShareId: grant.serviceShareId, expiresAt: grant.expiresAt, node: grant.node,
    bandwidthBytesPerSecond: grant.bandwidthBytesPerSecond, remainingBytes: grant.remainingBytes,
    frpc: { serverAddr, serverPort, user, token, proxyName, proxyType, secretKey, allowUsers: [...allowUsers] as string[] },
  };
}

/** Checks a `register` / `list` row. */
export function parseServiceRecord(value: unknown): ServiceShareRecord {
  const fail = (): never => { throw new Error("Frely returned an invalid service."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !SERVICE_SHARE_ID.test(row.id) || typeof row.deviceId !== "string" || row.deviceId.length > 64) return fail();
  if (row.type !== "mcp" && row.type !== "a2a") return fail();
  if (typeof row.label !== "string" || row.label.length < 1 || row.label.length > 60) return fail();
  return { id: row.id, deviceId: row.deviceId, type: row.type, label: row.label, createdAt: typeof row.createdAt === "string" ? row.createdAt : "" };
}

/**
 * The frpc config for a service: exactly one stcp proxy that points at a port on loopback. `localIP` is fixed here and the port comes
 * from the author's own command line; the relay never supplies a target. No client plugin, no admin port and no other proxy type are written.
 * The stcp key and `allowUsers` (Frely's visitor) come from the grant.
 */
export function serviceFrpcConfigToml(grant: ServiceGrant, localPort: number): string {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error("Invalid local port.");
  const q = (text: string): string => JSON.stringify(text);
  return [
    `serverAddr = ${q(grant.frpc.serverAddr.replace(/^\[|\]$/gu, ""))}`,
    `serverPort = ${grant.frpc.serverPort}`,
    `user = ${q(grant.frpc.user)}`,
    `loginFailExit = true`,
    `metadatas.token = ${q(grant.frpc.token)}`,
    `transport.tls.enable = true`,
    `log.to = "console"`,
    `log.level = "warn"`,
    ``,
    `[[proxies]]`,
    `name = "svc"`,
    `type = "stcp"`,
    `secretKey = ${q(grant.frpc.secretKey)}`,
    `allowUsers = [${grant.frpc.allowUsers.map(q).join(", ")}]`,
    `localIP = "127.0.0.1"`,
    `localPort = ${localPort}`,
    ``,
  ].join("\n");
}
