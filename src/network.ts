import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { CredentialStore } from "./credential-store.js";
import { VERSION } from "./version.js";
import { NetworkError } from "./network-errors.js";
import { NetworkFiles, type NetworkHost } from "./network-files.js";
import { NetworkHttp, normalizeNetworkOrigin, isRecord, UUID_PATTERN } from "./network-http.js";
import { NetworkSessions } from "./network-session.js";
import { DEFAULT_NETWORK_ORIGIN, NETWORK_HOSTS, parseNetworkArgs, parseCapability, parseUseInput,
  parsePendingGrant, publicPendingGrant, networkServerError } from "./network-contract.js";
export { NetworkError, publicNetworkError } from "./network-errors.js";

export interface NetworkDeps {
  store?: CredentialStore;
  fetch?: typeof fetch;
  home?: string;
  now?: () => number;
  uuid?: () => string;
  timeoutMs?: number;
  allowLoopback?: boolean;
}

export async function runNetwork(args: string[], deps: NetworkDeps = {}): Promise<Record<string, unknown>> {
  const { command, flags } = parseNetworkArgs(args);
  if (command === "help") return { commands: ["network setup [--host chatgpt|claude-code|opencode|generic] [--network <origin>] --json",
    "network status --json", "network find --capability <capability> --json",
    "network use --capability <capability> --input-json <json> [--request-id <uuid>] --json", "network logout --json"] };
  const cap = ["find", "use"].includes(command) ? parseCapability(flags) : undefined;
  const input = command === "use" ? parseUseInput(flags, cap!) : undefined;
  const id = command === "use" ? (flags["--request-id"] ?? (deps.uuid ?? randomUUID)()).toLowerCase() : undefined;
  if (id && !UUID_PATTERN.test(id)) throw new NetworkError("REQUEST_ID_INVALID");
  const task = flags["--task"] ?? (cap ? `Assess ${cap} using the supplied target and source evidence.` : "");
  if (command === "use" && (!task.trim() || task.length > 4000)) throw new NetworkError("TASK_INVALID");
  if (Number(process.versions.node.split(".")[0]) < 22) throw new NetworkError("NODE_VERSION_UNSUPPORTED");
  const files = new NetworkFiles(deps.home ?? homedir());
  let unlock: (() => Promise<void>) | undefined;
  try {
    unlock = await files.lock();
    const config = await files.readConfig();
    const origin = normalizeNetworkOrigin(flags["--network"] ?? config?.origin ?? DEFAULT_NETWORK_ORIGIN,
      deps.allowLoopback ?? process.env.FRELY_NETWORK_ALLOW_LOOPBACK === "1");
    const host = flags["--host"] ?? config?.host ?? "generic";
    if (!(NETWORK_HOSTS as readonly string[]).includes(host)) throw new NetworkError("HOST_UNSUPPORTED");
    const store = deps.store ?? (await import("./credential-store.js")).credentialStore;
    const now = deps.now ?? Date.now;
    const http = new NetworkHttp(deps.fetch ?? fetch, deps.timeoutMs ?? 30_000);
    const sessions = new NetworkSessions(origin, store, http, now);
    const state = await sessions.read();
    if (command === "logout") return await sessions.logout(state);
    if (command === "setup") {
      const response = await http.request(origin, "/SKILL.md");
      if (response.status !== 200) throw new NetworkError("SKILL_DOWNLOAD_FAILED");
      const metadata = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(response.text)?.[1];
      if (!metadata || !/^name:\s*frely-network\s*$/mu.test(metadata) || !/^description:\s*\S/mu.test(metadata)) throw new NetworkError("SKILL_INVALID");
      const installed = await files.installSkill(host as NetworkHost, response.text);
      await files.writeConfig({ version: 1, origin, host: host as NetworkHost });
      const resolved = await sessions.resolve(state);
      if (resolved.kind === "ready") return { ...resolved.view, origin, host, cliVersion: VERSION, ...installed };
      if (resolved.kind === "pending") return { ...publicPendingGrant(resolved.value), origin, host, cliVersion: VERSION, ...installed };
      const start = await http.request(origin, "/api/network/device/start", { body: { clientName: "Frely CLI", host } });
      const value = http.parse(start);
      if (start.status !== 201) throw networkServerError(value);
      const pending = parsePendingGrant(value, origin);
      if (Date.parse(pending.expiresAt) <= now() || Date.parse(pending.expiresAt) > now() + 3_600_000) throw new NetworkError("NETWORK_RESPONSE_INVALID");
      await sessions.save(pending);
      return { ...publicPendingGrant(pending), origin, host, cliVersion: VERSION, ...installed };
    }
    const resolved = await sessions.resolve(state);
    if (command === "status") {
      if (resolved.kind === "ready") return { ...resolved.view, origin };
      if (resolved.kind === "pending") return { ...publicPendingGrant(resolved.value), origin };
      return { status: "setup_required", origin, ...(resolved.reason ? { code: resolved.reason } : {}), recovery: "Run frely network setup --json." };
    }
    if (resolved.kind !== "ready") throw new NetworkError("NETWORK_SETUP_REQUIRED", {
      recovery: "Run frely network setup --json and approve the browser request.",
      ...(resolved.kind === "pending" ? { verificationUri: resolved.value.verificationUri, userCode: resolved.value.userCode } : {}),
    });
    const token = resolved.credential.accessToken;
    const response = await http.request(origin, `/api/network/capabilities/${command}`, {
      token, ...(id ? { requestId: id } : {}),
      body: command === "find" ? { capabilities: [cap] } : { requestId: id, capabilities: [cap], task, input },
    });
    const value = http.parse(response, [token]);
    if (response.status !== 200) {
      if (response.status === 401) await sessions.remove();
      throw networkServerError(value);
    }
    if (value.paymentMode !== "platform_demo") throw new NetworkError("NETWORK_RESPONSE_INVALID");
    if (command === "find") {
      if (!Array.isArray(value.capabilities)) throw new NetworkError("NETWORK_RESPONSE_INVALID");
      return { capabilities: value.capabilities, paymentMode: "platform_demo" };
    }
    if (value.requestId !== id || value.status !== "succeeded" || !isRecord(value.evidence) ||
        value.result === undefined || !Number.isSafeInteger(value.remainingCalls) || Number(value.remainingCalls) < 0) throw new NetworkError("NETWORK_RESPONSE_INVALID");
    return { requestId: id, status: "succeeded", paymentMode: "platform_demo", result: value.result, evidence: value.evidence, remainingCalls: value.remainingCalls };
  } catch (error) {
    const known = error instanceof NetworkError ? error : new NetworkError("NETWORK_CLIENT_FAILED");
    throw id ? new NetworkError(known.code, { ...known.details, requestId: id }) : known;
  } finally { if (unlock) await unlock(); }
}
