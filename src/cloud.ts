import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { credentialStore } from "./credential-store.js";
import { inspectAuth, normalizeRelayUrl, openVerificationUrl } from "./auth.js";
import { VERSION } from "./version.js";

const SERVICE = "frely-cli-cloud-v1";
const SCOPE = "openid profile offline_access cloud:read cloud:write cloud:execute cloud:publish";
export const CLOUD_USAGE = `Frely Cloud — call your Frely application.
  frely cloud list [--group <name>]
  frely cloud describe <tool>
  frely cloud call <tool> [--json '<object>' | --input <file>]
  frely cloud login
  frely cloud logout

Results are JSON. Cloud authorization is separate from device MCP.
Calls may create resources or incur usage. Failed writes are never replayed automatically.
`;
interface StoredCloud {
  version: 1;
  resource: string;
  redirectUrl: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
}

async function cloudIdentity() {
  const account = await inspectAuth();
  const origin = normalizeRelayUrl(account.relayUrl);
  const resource = origin + "/mcp";
  return { origin, resource, userId: account.user?.id, key: resource + "|" + (account.user?.id ?? "cloud") };
}

export async function logoutCloud(): Promise<void> {
  const identity = await cloudIdentity();
  const raw = await credentialStore.getPassword(SERVICE, identity.key);
  if (!raw) return;
  const stored = JSON.parse(raw) as StoredCloud;
  if (stored.resource !== identity.resource) throw new Error("Cloud credential resource mismatch.");
  if (stored.tokens && stored.client) {
    const token = stored.tokens.refresh_token ?? stored.tokens.access_token;
    const response = await fetch(identity.origin + "/api/auth/oauth2/revoke", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: identity.origin },
      body: new URLSearchParams({ client_id: stored.client.client_id, token,
        token_type_hint: stored.tokens.refresh_token ? "refresh_token" : "access_token" }),
    });
    if (!response.ok) throw new Error("Cloud authorization revocation failed. Try again.");
  }
  await credentialStore.deletePassword(SERVICE, identity.key);
}

async function connectCloud() {
  const identity = await cloudIdentity();
  const raw = await credentialStore.getPassword(SERVICE, identity.key);
  let stored: StoredCloud = raw ? JSON.parse(raw) as StoredCloud : { version: 1, resource: identity.resource, redirectUrl: "" };
  if (stored.version !== 1 || stored.resource !== identity.resource) throw new Error("Cloud credentials are invalid. Run frely cloud logout.");
  const state = randomUUID();
  let verifier = "";
  let listener: HttpServer | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((error: Error) => void) | undefined;
  let pendingCode: Promise<string> | undefined;
  const closeListener = async () => {
    if (timer) clearTimeout(timer);
    if (listener?.listening) await new Promise<void>(resolve => listener!.close(() => resolve()));
  };
  const listen = async (port: number) => {
    listener = createServer((request, response) => {
      const url = new URL(request.url ?? "/", stored.redirectUrl || "http://127.0.0.1");
      if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
        response.writeHead(400); response.end("Invalid authorization callback."); return;
      }
      const code = url.searchParams.get("code");
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      if (!code || url.searchParams.has("error")) {
        response.writeHead(400); response.end("Authorization was not completed.");
        rejectCode?.(new Error("Cloud authorization was declined.")); return;
      }
      response.end("Frely Cloud is authorized. You can close this window.");
      resolveCode?.(code);
    });
    await new Promise<void>((resolve, reject) => {
      listener!.once("error", reject);
      listener!.listen(port, "127.0.0.1", resolve);
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Cloud callback could not start.");
    return "http://127.0.0.1:" + address.port + "/callback";
  };
  if (!stored.redirectUrl) stored.redirectUrl = await listen(0);
  const callback = new URL(stored.redirectUrl);
  if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" || callback.pathname !== "/callback" || !callback.port || callback.username || callback.password || callback.search || callback.hash) {
    await closeListener(); throw new Error("Stored Cloud callback is invalid.");
  }
  const save = () => credentialStore.setPassword(SERVICE, identity.key, JSON.stringify(stored));
  const provider: OAuthClientProvider = {
    redirectUrl: stored.redirectUrl,
    clientMetadata: { client_name: "Frely CLI Cloud", redirect_uris: [stored.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: SCOPE },
    state: () => state,
    clientInformation: () => stored.client,
    saveClientInformation: async client => { stored.client = client; await save(); },
    tokens: () => stored.tokens,
    saveTokens: async tokens => {
      // This checks account selection; signature/audience verification remains on the server.
      if (identity.userId) {
        let subject: unknown;
        try { subject = (JSON.parse(Buffer.from(tokens.access_token.split(".")[1] ?? "", "base64url").toString()) as { sub?: unknown }).sub; } catch { /* Rejected below. */ }
        if (subject !== identity.userId) throw new Error("Cloud authorization used another account. Use the account shown by frely whoami.");
      }
      stored.tokens = tokens;
      stored.expiresAt = Date.now() + (tokens.expires_in ?? 600) * 1000;
      await save();
    },
    saveCodeVerifier: value => { verifier = value; },
    codeVerifier: () => { if (!verifier) throw new Error("Cloud PKCE verifier is missing."); return verifier; },
    redirectToAuthorization: async url => {
      if (url.origin !== identity.origin) throw new Error("Unexpected Cloud authorization server.");
      if (!listener) await listen(Number(callback.port));
      pendingCode = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
      // Attach immediately so a callback rejection never becomes an unhandled promise.
      pendingCode.catch(() => undefined);
      timer = setTimeout(() => rejectCode?.(new Error("Cloud authorization timed out.")), 300000);
      process.stderr.write("Authorize Frely Cloud in your browser:\n" + url.toString() + "\n");
      openVerificationUrl(url.toString());
    },
    validateResourceURL: async (_serverUrl, resource) => {
      if (resource !== undefined && resource !== identity.resource) throw new Error("Cloud resource mismatch.");
      return new URL(identity.resource);
    },
    invalidateCredentials: async scope => {
      if (scope === "all" || scope === "client") delete stored.client;
      if (scope === "all" || scope === "tokens") { delete stored.tokens; delete stored.expiresAt; }
      if (scope === "all" || scope === "verifier") verifier = "";
      await save();
    },
  };
  const cloudFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== identity.origin) throw new Error("Cloud discovery cannot send credentials to another origin.");
    return fetch(input, { ...init, redirect: "error", signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000) });
  };
  const transport = new StreamableHTTPClientTransport(new URL(identity.resource), {
    authProvider: provider, fetch: cloudFetch, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  let client = new Client({ name: "frely-cli-cloud", version: VERSION });
  try {
    try { await client.connect(transport as unknown as Transport); }
    catch (error) {
      if (!(error instanceof UnauthorizedError) || !pendingCode) throw error;
      await transport.finishAuth(await pendingCode);
      client = new Client({ name: "frely-cli-cloud", version: VERSION });
      await client.connect(transport as unknown as Transport);
    }
    await closeListener();
    return { client, close: () => client.close() };
  } catch {
    await closeListener();
    await client.close().catch(() => undefined);
    throw new Error("Cloud connection or authorization failed. Confirm app availability and account selection, then run frely cloud login. No business call was replayed.");
  }
}

export async function runCloud(args: readonly string[]): Promise<{ value?: unknown; text?: string; failed?: boolean }> {
  const action = args[1] ?? "list";
  if (action === "help" || args.includes("--help") || args.includes("-h")) return { text: CLOUD_USAGE };
  if (!["list", "describe", "call", "login", "logout"].includes(action)) throw new Error(CLOUD_USAGE);
  const named = action === "describe" || action === "call";
  const name = named ? args[2] : undefined;
  if (named && (!name || !/^[a-zA-Z0-9_.-]{1,128}$/.test(name))) throw new Error("A valid Cloud tool name is required.");
  const options = new Map<string, string>();
  for (let i = named ? 3 : 2; i < args.length; i++) {
    const option = args[i]!, value = args[++i];
    const allowed = action === "list" ? ["--group"] : action === "call" ? ["--json", "--input"] : [];
    if (!allowed.includes(option) || options.has(option) || value === undefined) throw new Error(CLOUD_USAGE);
    options.set(option, value);
  }
  let input: Record<string, unknown> = {};
  if (options.has("--json") && options.has("--input")) throw new Error("Use --json or --input.");
  if (action === "call") {
    let raw = options.get("--json") ?? "{}";
    const file = options.get("--input");
    if (file !== undefined) {
      if ((await stat(file)).size > 512 * 1024) throw new Error("Cloud input exceeds 512 KiB.");
      raw = await readFile(file, "utf8");
    }
    if (Buffer.byteLength(raw) > 512 * 1024) throw new Error("Cloud input exceeds 512 KiB.");
    const value: unknown = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Cloud input must be a JSON object.");
    input = value as Record<string, unknown>;
  }
  if (action === "logout") { await logoutCloud(); return { value: { authorized: false } }; }
  const session = await connectCloud();
  try {
    if (action === "login") return { value: { authorized: true } };
    const all = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await session.client.listTools(cursor === undefined ? {} : { cursor });
      all.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error("Invalid Cloud tool pagination.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (action === "list") {
      const group = options.get("--group");
      return { value: { tools: all.filter(tool => !group || tool.name.startsWith(group + ".")) } };
    }
    const tool = all.find(tool => tool.name === name);
    if (!tool) throw new Error("Cloud tool is unavailable or not authorized: " + name);
    if (action === "describe") return { value: tool };
    const result = await session.client.callTool({ name: name!, arguments: input }, undefined, { timeout: 180000 });
    return { value: result, failed: result.isError === true };
  } finally { await session.close(); }
}
