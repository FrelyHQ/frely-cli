/** What the relay returns for a share session (`POST /api/user/device-relay/shares`, action create). */
export interface ShareGrant {
  readonly id: string;
  readonly url: string;
  readonly expiresAt: string;
  readonly node: string;
  readonly bandwidthBytesPerSecond: number;
  readonly remainingBytes: number;
  readonly frpc: {
    readonly serverAddr: string;
    readonly serverPort: number;
    readonly user: string;
    readonly token: string;
    readonly proxyName: string;
    readonly subdomain: string;
  };
}

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:]{2,45}\])$/u;

/** Checks the grant's shape before anything of it reaches a process or a file; throws on anything unexpected. */
export function parseShareGrant(value: unknown): ShareGrant {
  const fail = (): never => { throw new Error("Frely returned an invalid share session."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const grant = value as Record<string, unknown>, frpc = grant.frpc as Record<string, unknown> | undefined;
  if (typeof grant.id !== "string" || !/^frps_[0-9a-f]{24}$/u.test(grant.id)) return fail();
  if (typeof grant.url !== "string" || typeof grant.expiresAt !== "string" || typeof grant.node !== "string") return fail();
  if (typeof grant.bandwidthBytesPerSecond !== "number" || typeof grant.remainingBytes !== "number") return fail();
  if (!frpc || typeof frpc !== "object") return fail();
  const { serverAddr, serverPort, user, token, proxyName, subdomain } = frpc;
  if (typeof serverAddr !== "string" || !HOST.test(serverAddr)) return fail();
  if (typeof serverPort !== "number" || !Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) return fail();
  if (user !== grant.id || typeof token !== "string" || !/^frs_[A-Za-z0-9_-]{20,64}$/u.test(token)) return fail();
  if (proxyName !== "share" || typeof subdomain !== "string" || !/^s[0-9a-f]{14}$/u.test(subdomain)) return fail();
  let link: URL;
  try { link = new URL(grant.url); } catch { return fail(); }
  if (link.protocol !== "https:" || !link.hostname.startsWith(`${subdomain}.`)) return fail();
  return { id: grant.id, url: grant.url, expiresAt: grant.expiresAt, node: grant.node, bandwidthBytesPerSecond: grant.bandwidthBytesPerSecond, remainingBytes: grant.remainingBytes, frpc: { serverAddr, serverPort, user, token, proxyName, subdomain } };
}

/**
 * The frpc config for a share: one http proxy that points at the local gateway on loopback. No client plugin, no admin port and no
 * other proxy type are ever written, and `localIP` is fixed here, never taken from the relay.
 */
export function frpcConfigToml(grant: ShareGrant, gatewayPort: number): string {
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) throw new Error("Invalid gateway port.");
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
    `name = ${q(grant.frpc.proxyName)}`,
    `type = "http"`,
    `localIP = "127.0.0.1"`,
    `localPort = ${gatewayPort}`,
    `subdomain = ${q(grant.frpc.subdomain)}`,
    ``,
  ].join("\n");
}
