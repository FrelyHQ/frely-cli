// A Frely instance is the relay this computer is logged in to: the hosted one (https://frely.cloud) or a private deployment. Every address
// the CLI derives from "which Frely am I talking to" (model gateway, MCP, approval page, installer host, passkey relying party) comes from
// `resolveInstanceEndpoints`, so there is one code path and no hostname checks elsewhere.
//
// A private relay publishes `GET <relay>/.well-known/frely` so the CLI does not have to guess those addresses. The document is read once per
// login and kept with the login, and it only ever applies to the relay it was fetched from.

export const DEFAULT_RELAY_ORIGIN = "https://frely.cloud";
export const DISCOVERY_PATH = "/.well-known/frely";
export const DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_DISCOVERY_BYTES = 16 * 1024;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

export interface DiscoveryDocument {
  gatewayBaseUrl?: string;
  /** The full FreyMCP endpoint, path included. */
  mcpBaseUrl?: string;
  approvalOrigin?: string;
  setupBaseUrl?: string;
  passkeyRpId?: string;
}

export interface InstanceEndpoints {
  /** The relay origin this record belongs to; credentials for it are never sent anywhere this record does not name. */
  relayOrigin: string;
  /** Where model calls and gateway API keys go. */
  gatewayUrl: string;
  /** The FreyMCP endpoint the machine's side token is for. */
  mcpUrl: string;
  /** The only origin whose passkey signatures count as approvals from this instance's owner. */
  approvalOrigin: string;
  /** Where install.sh / install.ps1 are served. */
  setupUrl: string;
  /** The WebAuthn relying party id of this instance's trust records. */
  rpId: string;
}

/**
 * Instances the CLI knows without asking. Their addresses are fixed here and a discovery document cannot change them: the hosted relay's
 * approval origin and relying party are what a device trusts whatever a (possibly compromised) relay answers.
 */
const BUILT_IN_INSTANCES: ReadonlyMap<string, InstanceEndpoints> = new Map([[DEFAULT_RELAY_ORIGIN, {
  relayOrigin: DEFAULT_RELAY_ORIGIN,
  gatewayUrl: "https://api.frely.cloud",
  mcpUrl: "https://mcp.frely.cloud/mcp",
  approvalOrigin: "https://approve.frely.cloud",
  setupUrl: DEFAULT_RELAY_ORIGIN,
  rpId: "frely.cloud",
}]]);

export const HOSTED_INSTANCE: InstanceEndpoints = BUILT_IN_INSTANCES.get(DEFAULT_RELAY_ORIGIN)!;

/** True when the CLI already knows this relay's addresses, so there is nothing to discover. */
export const isBuiltInInstance = (relayOrigin: string): boolean => BUILT_IN_INSTANCES.has(relayOrigin);

const isLoopback = (url: URL): boolean => LOOPBACK_HOSTS.includes(url.hostname);

/** An https URL, or http on loopback, without credentials, query or fragment. */
function cleanUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (!(url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url)))) return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  return url;
}

const withoutTrailingSlash = (url: URL): string => url.toString().replace(/\/+$/u, "");

/** A relying party id must be the host of the approval origin or a parent domain of it (WebAuthn). */
function validRpId(value: unknown, approval: URL): value is string {
  if (typeof value !== "string" || !/^[a-z0-9.-]{1,253}$/u.test(value)) return false;
  return approval.hostname === value || approval.hostname.endsWith(`.${value}`);
}

/** Keeps the fields that are valid; anything else, unknown fields included, is dropped so a bad field never turns into an address. */
export function parseDiscovery(value: unknown): DiscoveryDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const out: DiscoveryDocument = {};
  const gateway = cleanUrl(input.gatewayBaseUrl);
  if (gateway) out.gatewayBaseUrl = withoutTrailingSlash(gateway);
  const mcp = cleanUrl(input.mcpBaseUrl);
  if (mcp) out.mcpBaseUrl = mcp.toString();
  const setup = cleanUrl(input.setupBaseUrl);
  if (setup) out.setupBaseUrl = withoutTrailingSlash(setup);
  const approval = cleanUrl(input.approvalOrigin);
  if (approval && approval.pathname === "/") {
    out.approvalOrigin = approval.origin;
    if (validRpId(input.passkeyRpId, approval)) out.passkeyRpId = input.passkeyRpId;
  }
  return out;
}

/** The relay's own address for anything it does not publish: model calls, approval and installers on the relay, the device MCP path. */
function derivedEndpoints(relayOrigin: string, discovered: DiscoveryDocument): InstanceEndpoints {
  const relay = new URL(relayOrigin);
  const approvalOrigin = discovered.approvalOrigin ?? relay.origin;
  return {
    relayOrigin: relay.origin,
    gatewayUrl: discovered.gatewayBaseUrl ?? relay.origin,
    mcpUrl: discovered.mcpBaseUrl ?? `${relay.origin}/mcp/devices`,
    approvalOrigin,
    setupUrl: discovered.setupBaseUrl ?? relay.origin,
    rpId: discovered.passkeyRpId ?? new URL(approvalOrigin).hostname,
  };
}

/**
 * The addresses of one instance. `relayOrigin` is the normalized origin of the relay the login belongs to; `discovered` is the document that
 * same relay published (never another instance's). A built-in instance ignores it, any other relay's own address fills what it leaves out.
 */
export function resolveInstanceEndpoints(relayOrigin: string, discovered?: DiscoveryDocument): InstanceEndpoints {
  return BUILT_IN_INSTANCES.get(relayOrigin) ?? derivedEndpoints(relayOrigin, parseDiscovery(discovered));
}

/** Reads the relay's discovery document. Any failure (offline, 404, redirect, not JSON, too large) is `undefined`: the relay's own addresses apply. */
export async function fetchDiscovery(relayOrigin: string, fetchFn: typeof fetch = fetch, timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<DiscoveryDocument | undefined> {
  try {
    const response = await fetchFn(`${relayOrigin}${DISCOVERY_PATH}`, { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return undefined;
    const text = await response.text();
    if (text.length > MAX_DISCOVERY_BYTES) return undefined;
    const document = parseDiscovery(JSON.parse(text));
    return Object.keys(document).length > 0 ? document : undefined;
  } catch { return undefined; }
}

/** The trust anchor of an instance: the only relying party and approval origin its trust records may name. */
export const trustAnchor = (instance: InstanceEndpoints): { rpId: string; approvalOrigins: readonly string[] } => ({ rpId: instance.rpId, approvalOrigins: [instance.approvalOrigin] });

/**
 * Whether the CLI may send an API key or read a manifest at this URL: https on the instance's relay host, a subdomain of it, or a host the
 * instance's own endpoints name; http only on loopback (development). Pass the instance the user is logged in to, plus the hosted one.
 */
export function isInstanceUrl(value: string | URL, instances: readonly InstanceEndpoints[]): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.hash) return false;
  if (isLoopback(url)) return url.protocol === "http:" || url.protocol === "https:";
  if (url.protocol !== "https:") return false;
  return instances.some((instance) => {
    const relayHost = new URL(instance.relayOrigin).hostname;
    if (url.hostname === relayHost || url.hostname.endsWith(`.${relayHost}`)) return true;
    return [instance.gatewayUrl, instance.mcpUrl, instance.approvalOrigin, instance.setupUrl].some((address) => new URL(address).host === url.host);
  });
}
