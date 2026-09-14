import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { requireLogin, openVerificationUrl } from "./auth.js";
import { credentialStore } from "./credential-store.js";
import { ensureCredentialDirectory, readPrivateFile, writePrivateFile } from "./credential-file.js";
import { ensureDevice, relayFetch } from "./device/control.js";
import { identityFromPrivateKey } from "./device/identity.js";

export const MCP_DEFAULT_DAYS = 90;
export const MCP_MAX_DAYS = 180;
const SERVICE = "frely-cli-mcp-authorization-v1";
const ENDPOINT = "/api/user/device-relay/mcp";
export interface McpAuthorizationView {
  id: string; deviceId: string; keyThumbprint: string; workspace: string; days: number;
  approvalDeadline: string; approvedAt: string | null; expiresAt: string | null;
  status: "pending" | "active" | "expired" | "revoked";
}
export interface McpMetadata { version: 1; relayUrl: string; userId: string; grant: McpAuthorizationView }
interface McpSecret { version: 1; privateKeyPem: string; metadata: McpMetadata }
export interface McpAuthorization extends McpMetadata { mcpUrl: string; sign(message: string): string }
export function parseMcpDays(input?: string | number): number {
  const value = input === undefined ? MCP_DEFAULT_DAYS : typeof input === "string" && /^\d{1,3}$/u.test(input) ? Number(input) : input;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MCP_MAX_DAYS) throw new Error("MCP authorization must be 1 to 180 whole days.");
  return value;
}
export function mcpMetadataPath(): string { return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "mcp-v1", "authorization.json"); }
export async function inspectMcpMetadata(): Promise<McpMetadata | null> {
  const raw = await readPrivateFile(mcpMetadataPath());
  if (!raw) return null;
  const value = JSON.parse(raw) as McpMetadata;
  if (value.version !== 1 || typeof value.relayUrl !== "string" || typeof value.userId !== "string") throw new Error("MCP configuration is invalid.");
  value.grant = validateView(value.grant);
  return value;
}
async function writeMetadata(metadata: McpMetadata): Promise<void> {
  const path = mcpMetadataPath();
  await ensureCredentialDirectory(dirname(path), true);
  await writePrivateFile(path, JSON.stringify(metadata) + "\n");
}
const account = (metadata: McpMetadata) => `${new URL(metadata.relayUrl).origin}|${metadata.userId}|${metadata.grant.id}`;

export async function loadMcpAuthorization(): Promise<McpAuthorization | null> {
  const metadata = await inspectMcpMetadata();
  if (!metadata) return null;
  const raw = await credentialStore.getPassword(SERVICE, account(metadata));
  if (!raw) throw new Error("MCP secure credential is unavailable. Run frely mcp renew; no replacement key was generated.");
  const value = JSON.parse(raw) as McpSecret;
  if (value.version !== 1 || JSON.stringify(value.metadata) !== JSON.stringify(metadata) || typeof value.privateKeyPem !== "string") throw new Error("MCP credential does not match its authorization.");
  const identity = identityFromPrivateKey(value.privateKeyPem);
  if (identity.keyThumbprint !== metadata.grant.keyThumbprint) throw new Error("MCP private key does not match its authorization.");
  return { ...metadata, mcpUrl: new URL(`/mcp/${metadata.grant.deviceId}`, metadata.relayUrl).toString(), sign: (message) => identity.signMessage(message) };
}

export async function requireMcpAuthorization(workspace?: string): Promise<McpAuthorization> {
  const authorization = await loadMcpAuthorization();
  if (!authorization) throw new Error("MCP is not enabled. Run frely mcp setup.");
  assertMcpActive(authorization.grant);
  if (workspace !== undefined && await realpath(resolve(workspace)) !== authorization.grant.workspace) throw new Error("Workspace differs from the approved MCP workspace. Run frely mcp setup for the new workspace.");
  const auth = await requireLogin();
  if (authorization.relayUrl !== auth.config.relayUrl || authorization.userId !== auth.user.id) throw new Error("MCP authorization belongs to a different account.");
  const response = await relayFetch(auth.config.relayUrl, auth.credential, `${ENDPOINT}?requestId=${authorization.grant.id}`, { method: "GET" });
  const current = await readView(response);
  assertMcpActive(current);
  if (JSON.stringify(current) !== JSON.stringify(authorization.grant)) throw new Error("MCP authorization changed. Run frely mcp renew.");
  return authorization;
}

export async function setupMcpAuthorization(workspaceInput: string, daysInput?: string | number, renew = false,
  notify?: (value: { verificationUri: string; keyThumbprint: string; days: number }) => void | Promise<void>): Promise<McpAuthorization> {
  const days = parseMcpDays(daysInput);
  const workspace = await realpath(resolve(workspaceInput));
  if (/[\x00-\x1f\x7f]/u.test(workspace)) throw new Error("MCP workspace contains control characters.");
  const auth = await requireLogin();
  const old = await inspectMcpMetadata();
  if (!renew && old?.relayUrl === auth.config.relayUrl && old.userId === auth.user.id && old.grant.workspace === workspace
    && old.grant.status === "active" && Date.parse(old.grant.expiresAt ?? "") > Date.now()) return requireMcpAuthorization(workspace);
  // Secure storage belongs to MCP setup, not basic login, status, Network or installation.
  const probe = "probe:" + randomUUID();
  await credentialStore.setPassword(SERVICE, probe, probe);
  try { if (await credentialStore.getPassword(SERVICE, probe) !== probe) throw new Error("MCP secure storage readback failed."); }
  finally { if (!await credentialStore.deletePassword(SERVICE, probe)) throw new Error("MCP secure storage deletion failed."); }
  const device = await ensureDevice();
  const privateKeyPem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const identity = identityFromPrivateKey(privateKeyPem);
  const issuedAt = new Date().toISOString();
  const nonce = randomBytes(24).toString("base64url");
  const signature = identity.signMessage(JSON.stringify(["frely.mcp.request.v2", device.deviceId, identity.keyThumbprint, days, workspace, issuedAt, nonce]));
  const response = await relayFetch(auth.config.relayUrl, auth.credential, ENDPOINT, { method: "POST", body: JSON.stringify({ action: "request",
    deviceId: device.deviceId, publicKeySpki: identity.publicKeySpki, keyThumbprint: identity.keyThumbprint,
    days, workspace, issuedAt, nonce, signature }) });
  const pending = await readView(response);
  if (pending.status !== "pending" || pending.days !== days || pending.workspace !== workspace || pending.deviceId !== device.deviceId || pending.keyThumbprint !== identity.keyThumbprint) throw new Error("MCP approval response does not match this request.");
  let metadata: McpMetadata = { version: 1, relayUrl: auth.config.relayUrl, userId: auth.user.id, grant: pending };
  const save = () => credentialStore.setPassword(SERVICE, account(metadata), JSON.stringify({ version: 1, privateKeyPem, metadata } satisfies McpSecret));
  await save(); // Preserve the generated key before asking the user to approve it.
  const verificationUri = new URL(`/device?mcp_request=${pending.id}`, auth.config.relayUrl).toString();
  await notify?.({ verificationUri, keyThumbprint: identity.keyThumbprint, days });
  openVerificationUrl(verificationUri);
  while (Date.now() < Date.parse(pending.approvalDeadline)) {
    const result = await relayFetch(auth.config.relayUrl, auth.credential, `${ENDPOINT}?requestId=${pending.id}`, { method: "GET" });
    const current = await readView(result);
    if (current.id !== pending.id || current.deviceId !== device.deviceId || current.keyThumbprint !== identity.keyThumbprint || current.workspace !== workspace || current.days !== days) throw new Error("MCP authorization binding changed.");
    if (current.status === "active") {
      metadata = { ...metadata, grant: current };
      await save();
      await writeMetadata(metadata);
      if (old && old.grant.id !== current.id) await credentialStore.deletePassword(SERVICE, account(old));
      const enabled = await loadMcpAuthorization();
      if (!enabled) throw new Error("MCP authorization could not be loaded.");
      return enabled;
    }
    if (current.status !== "pending") throw new Error("MCP approval was denied or expired.");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("MCP approval expired. Run frely mcp setup.");
}

export async function revokeMcpAuthorization(): Promise<void> {
  const metadata = await inspectMcpMetadata();
  if (!metadata) return;
  const auth = await requireLogin();
  if (metadata.relayUrl !== auth.config.relayUrl || metadata.userId !== auth.user.id) throw new Error("MCP authorization belongs to another account.");
  const response = await relayFetch(auth.config.relayUrl, auth.credential, ENDPOINT, { method: "POST", body: JSON.stringify({ action: "revoke", requestId: metadata.grant.id }) });
  if (!response.ok) throw new Error("Remote MCP revocation was not confirmed.");
  // Retain metadata on cleanup failure so status/cleanup remain possible.
  await credentialStore.deletePassword(SERVICE, account(metadata));
  await unlink(mcpMetadataPath());
}
export function assertMcpActive(view: McpAuthorizationView, now = Date.now()): void {
  if (view.status !== "active" || !view.expiresAt || !Number.isFinite(Date.parse(view.expiresAt)) || Date.parse(view.expiresAt) <= now) {
    throw new Error("MCP_AUTHORIZATION_EXPIRED: run frely mcp renew. Basic features remain available.");
  }
}
function validateView(input: unknown): McpAuthorizationView {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("MCP authorization response is invalid.");
  const value = input as McpAuthorizationView;
  if (!/^mca_[a-f0-9]{32}$/u.test(value.id) || !/^drd_[a-f0-9]{32}$/u.test(value.deviceId) || typeof value.workspace !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(value.keyThumbprint) || !["pending", "active", "expired", "revoked"].includes(value.status)
    || !Number.isFinite(Date.parse(value.approvalDeadline))) throw new Error("MCP authorization response is invalid.");
  parseMcpDays(value.days);
  if (value.approvedAt !== null || value.expiresAt !== null) {
    if (typeof value.approvedAt !== "string" || typeof value.expiresAt !== "string"
      || Date.parse(value.expiresAt) - Date.parse(value.approvedAt) !== value.days * 86_400_000) throw new Error("MCP authorization dates are invalid.");
  }
  return { id: value.id, deviceId: value.deviceId, workspace: value.workspace, keyThumbprint: value.keyThumbprint,
    days: value.days, approvalDeadline: value.approvalDeadline, approvedAt: value.approvedAt, expiresAt: value.expiresAt, status: value.status };
}
async function readView(response: Response): Promise<McpAuthorizationView> {
  if (!response.ok) throw new Error(`MCP authorization request failed (HTTP ${response.status}).`);
  return validateView(await response.json());
}
