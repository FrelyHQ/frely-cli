import { NetworkError } from "./network-errors.js";
import { isRecord, UUID_PATTERN } from "./network-http.js";
export const NETWORK_SERVICE = "frely-network";
export const DEFAULT_NETWORK_ORIGIN = "https://network.frely.cloud";
export const NETWORK_HOSTS = ["chatgpt", "claude-code", "opencode", "generic"] as const;
const CAPABILITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
export type Capability = string;
export interface PendingGrant {
  version: 1; kind: "pending"; deviceCode: string; userCode: string;
  verificationUri: string; expiresAt: string; intervalSeconds: number;
}
export interface StoredNetworkSession { version: 1; kind: "session"; accessToken: string; expiresAt: string; sessionId: string; }
export interface NetworkSessionView {
  status: "ready"; sessionId: string; walletAddress: string; chainId: number; expiresAt: string;
  paymentMode: "platform_demo"; remainingCalls: number;
}
export type NetworkState = PendingGrant | StoredNetworkSession | null;
export const validExpiry = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT/u.test(value) && Number.isFinite(Date.parse(value));
export const ACCESS_TOKEN_PATTERN = /^fn_[A-Za-z0-9_-]{43}$/u;
export function parseNetworkArgs(args: string[]): { command: string; flags: Record<string, string> } {
  const command = args[1] ?? "help";
  const allowed: Record<string, string[]> = {
    setup: ["--host", "--network"], status: ["--network"], logout: ["--network"],
    find: ["--network", "--capability"], use: ["--network", "--capability", "--input-json", "--task", "--request-id"], help: [],
  };
  if (!Object.hasOwn(allowed, command)) throw new NetworkError("NETWORK_COMMAND_UNKNOWN");
  const flags: Record<string, string> = {};
  for (let index = 2; index < args.length; index++) {
    const flag = args[index]!;
    if (Object.hasOwn(flags, flag)) throw new NetworkError("DUPLICATE_ARGUMENT");
    if (flag === "--json") { flags[flag] = "true"; continue; }
    if (!allowed[command]!.includes(flag)) throw new NetworkError("UNKNOWN_ARGUMENT");
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new NetworkError("ARGUMENT_VALUE_REQUIRED");
    flags[flag] = value;
  }
  return { command, flags };
}
export function parseCapability(flags: Record<string, string>): Capability {
  const value = flags["--capability"];
  if (!value || !CAPABILITY_PATTERN.test(value)) throw new NetworkError("CAPABILITY_NOT_SUPPORTED");
  return value;
}
export function parseUseInput(flags: Record<string, string>, cap: Capability): Record<string, unknown> {
  const text = flags["--input-json"];
  if (!text || Buffer.byteLength(text) > 8192) throw new NetworkError("INPUT_JSON_INVALID");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new NetworkError("INPUT_JSON_INVALID"); }
  if (!isRecord(value)) throw new NetworkError("INPUT_JSON_INVALID");
  if (cap === "web3.address-risk") {
    if (typeof value.address !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(value.address)) throw new NetworkError("INVALID_ADDRESS");
    if (value.chainId === undefined) throw new NetworkError("TARGET_CHAIN_REQUIRED");
    if (String(value.chainId) !== "1") throw new NetworkError("UNSUPPORTED_TARGET_CHAIN");
    if (Object.keys(value).some((key) => !["address", "chainId"].includes(key))) throw new NetworkError("INPUT_JSON_INVALID");
    return { address: value.address.toLowerCase(), chainId: "1" };
  }
  if (cap === "web3.url-risk") {
    if (typeof value.url !== "string" || value.url.length > 2048 || Object.keys(value).some((key) => key !== "url")) throw new NetworkError("INVALID_URL");
    let url: URL;
    try { url = new URL(value.url); } catch { throw new NetworkError("INVALID_URL"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw new NetworkError("INVALID_URL");
    return { url: url.toString() };
  }
  return value;
}
export function parsePendingGrant(value: Record<string, unknown>, origin: string): PendingGrant {
  if (typeof value.deviceCode !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.deviceCode) || typeof value.userCode !== "string" ||
      !/^[A-F0-9]{4}(?:-[A-F0-9]{4}){5}$/u.test(value.userCode) || value.verificationUri !== `${origin}/connect/#code=${value.userCode}` ||
      !validExpiry(value.expiresAt) || value.paymentMode !== "platform_demo" || !Number.isSafeInteger(value.intervalSeconds) ||
      Number(value.intervalSeconds) < 1 || Number(value.intervalSeconds) > 300) throw new NetworkError("NETWORK_RESPONSE_INVALID");
  return { version: 1, kind: "pending", deviceCode: value.deviceCode, userCode: value.userCode,
    verificationUri: String(value.verificationUri), expiresAt: value.expiresAt, intervalSeconds: Number(value.intervalSeconds) };
}
export function parseSessionView(value: Record<string, unknown>): NetworkSessionView {
  if (value.status !== "ready" || typeof value.sessionId !== "string" || !UUID_PATTERN.test(value.sessionId) ||
      typeof value.walletAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(value.walletAddress) ||
      !Number.isSafeInteger(value.chainId) || Number(value.chainId) < 1 || !validExpiry(value.expiresAt) ||
      value.paymentMode !== "platform_demo" || !Number.isSafeInteger(value.remainingCalls) || Number(value.remainingCalls) < 0) throw new NetworkError("NETWORK_RESPONSE_INVALID");
  return { status: "ready", sessionId: value.sessionId, walletAddress: value.walletAddress, chainId: Number(value.chainId),
    expiresAt: value.expiresAt, paymentMode: "platform_demo", remainingCalls: Number(value.remainingCalls) };
}
const PUBLIC_CODES = new Set([
  "SESSION_REQUIRED", "SESSION_EXPIRED", "DEVICE_EXPIRED", "DEVICE_CONSUMED", "DEVICE_REJECTED", "RATE_LIMITED", "DEMO_LIMIT_EXCEEDED",
  "REQUEST_IN_PROGRESS", "REQUEST_OUTCOME_UNKNOWN", "REQUEST_RESULT_EXPIRED", "IDEMPOTENCY_CONFLICT", "NETWORK_ONBOARDING_NOT_CONFIGURED",
  "BROKER_NOT_READY", "NO_PROVIDER", "NO_VERIFIED_PROVIDER", "IDENTITY_VERIFICATION_FAILED", "PROVIDER_REQUEST_FAILED", "PROVIDER_RESPONSE_INVALID",
  "PROVIDER_TARGET_MISMATCH", "CAPABILITY_NOT_SUPPORTED", "INVALID_REQUEST", "NETWORK_REQUEST_FAILED", "PROTOCOL_NOT_SUPPORTED",
]);
export function networkServerError(value: Record<string, unknown>): NetworkError {
  return new NetworkError(typeof value.code === "string" && PUBLIC_CODES.has(value.code) ? value.code : "NETWORK_SERVICE_ERROR");
}
export function publicPendingGrant(value: PendingGrant): Record<string, unknown> {
  return { status: "awaiting_wallet", verificationUri: value.verificationUri, userCode: value.userCode,
    expiresAt: value.expiresAt, intervalSeconds: value.intervalSeconds, paymentMode: "platform_demo" };
}
