import { homedir } from "node:os";
import { join } from "node:path";
import { LOGIN_REFRESH_UNAVAILABLE, requireLogin } from "../auth.js";
import { credentialStore as secureCredentialStore, type CredentialStore } from "../credential-store.js";
import { remoteAgentMcpInvoker, remoteAgentTaskClient, SkillInvocationError, type AgentTurnResult, type CallerItem, type CallerToolDefinition, type RemoteAgentMcpInvoker, type RemoteAgentTaskClient, type SkillInvocationResult } from "./router.js";
import {
  findManagedSkillByInstallName,
  ManagedSkillError,
  managedSkillRoot,
  managedSkillState,
  readManagedSkill,
  removeManagedSkill,
  skillSlug,
  writeManagedSkill,
  type SkillHost,
  type SkillScope,
} from "./managed.js";

const MANIFEST_SCHEMA = "frely.agent.public.v1";
const DISTRIBUTION_ID = /^creator_distribution_[a-f0-9]{24}$/u;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_TASK_BYTES = 128 * 1024;
export const SKILL_API_KEY_SERVICE = "frely-cli-skill-api-key-v1";

interface PublicCapability {
  readonly id: string;
  readonly level: "base" | "advanced";
  readonly entrypoints: readonly ("model" | "mcp" | "a2a")[];
  readonly description?: string;
}

interface PublicVirtualModelManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA;
  readonly id: string;
  readonly installName?: string;
  readonly modelId: string;
  readonly version: string;
  readonly name: string;
  readonly description: string | null;
  readonly capabilities: readonly PublicCapability[];
  readonly clientTrigger?: { readonly description: string; readonly when: readonly string[] };
  readonly urls: {
    readonly manifest: string;
    readonly mcp: string;
  };
}
export class SkillAccessError extends Error {
  constructor(
    readonly code: "invalid_manifest_url" | "agent_not_found" | "manifest_fetch_failed" | "manifest_invalid" | "target_not_installed" | "auth_required" | "remote_authorization_failed" | "entitlement_required" | "payment_required" | "remote_call_failed" | "input_invalid" | "host_unsupported" | "credential_store_failed",
    message: string,
  ) {
    super(message);
    this.name = "SkillAccessError";
  }
}

/** An Agent is named like every product: `username/name`, optionally `@<version>`. */
const AGENT_NAME = /^([^/@\s]{1,64})\/([^/@\s]{1,64})(?:@([1-9][0-9]{0,8}))?$/u;

/** `frely agent install` takes `username/name[@version]` (or the distribution id older scripts use) and reads its public manifest on the account's Frely origin. */
export function agentManifestUrl(target: string, relayUrl: string): string {
  if (!DISTRIBUTION_ID.test(target) && !AGENT_NAME.test(target)) throw new SkillAccessError("input_invalid", "Use the Agent's name, for example username/name, or username/name@3 for a version.");
  return `${relayUrl}/api/public/agents/${target.split("/").map(encodeURIComponent).join("/")}`;
}

/** An installed Agent's distribution id from the id or `username/name` a user typed; a version written after the name is ignored. */
export async function resolveAgentTarget(target: string, relayUrl: string, home = homedir(), fetchFn: typeof fetch = fetch): Promise<string> {
  if (DISTRIBUTION_ID.test(target)) return target;
  const match = AGENT_NAME.exec(target);
  if (match === null) throw new SkillAccessError("input_invalid", "Use the Agent's name, for example username/name.");
  const installed = await findManagedSkillByInstallName(`${match[1]}/${match[2]}`, home);
  if (installed) return installed.distributionId;
  return (await fetchManifest(agentManifestUrl(`${match[1]}/${match[2]}`, relayUrl), fetchFn)).id;
}

export async function installSkillAdapter(input: {
  readonly manifestUrl: string;
  readonly host: SkillHost;
  readonly scope: SkillScope;
  readonly apiKey?: string;
  readonly cwd?: string;
  readonly home?: string;
  readonly fetchFn?: typeof fetch;
  readonly credentialStore?: CredentialStore;
}) {
  const fetchFn = input.fetchFn ?? fetch;
  const manifest = await fetchManifest(input.manifestUrl, fetchFn);
  const home = input.home ?? homedir();
  const existing = await readManagedSkill(manifest.id, home);
  const slug = existing?.slug ?? skillSlug(manifest.name);
  const root = managedSkillRoot(input.host, input.scope, input.cwd, home);
  const skillPath = existing?.skillPath ?? join(root, slug, "SKILL.md");
  const content = renderSkill(manifest, slug);
  const authMode = input.apiKey !== undefined ? "api-key" as const : existing?.authMode ?? "account" as const;
  const recordInput = {
    version: 1 as const,
    distributionId: manifest.id,
    manifestUrl: manifest.urls.manifest,
    modelId: manifest.modelId,
    mcpUrl: manifest.urls.mcp,
    name: manifest.name,
    ...(manifest.installName === undefined ? {} : { installName: manifest.installName }),
    slug,
    host: input.host,
    scope: input.scope,
    authMode,
    skillPath,
  };

  let store: CredentialStore | undefined;
  let previousApiKey: string | null = null;
  if (input.apiKey !== undefined) {
    assertApiKey(input.apiKey);
    await verifyApiKey(manifest, input.apiKey, fetchFn);
    store = input.credentialStore ?? secureCredentialStore;
    try {
      previousApiKey = await store.getPassword(SKILL_API_KEY_SERVICE, manifest.id);
      await store.setPassword(SKILL_API_KEY_SERVICE, manifest.id, input.apiKey);
    } catch (error) {
      throw new SkillAccessError("credential_store_failed", error instanceof Error ? error.message : "Could not store the model-scoped API key securely.");
    }
  }

  let record;
  try {
    record = await writeManagedSkill({ home, content, record: recordInput });
  } catch (error) {
    if (store) {
      if (previousApiKey === null) await store.deletePassword(SKILL_API_KEY_SERVICE, manifest.id).catch(() => false);
      else await store.setPassword(SKILL_API_KEY_SERVICE, manifest.id, previousApiKey).catch(() => undefined);
    }
    throw error;
  }
  return Object.freeze({
    ok: true,
    distributionId: record.distributionId,
    modelId: record.modelId,
    name: record.name,
    host: record.host,
    scope: record.scope,
    authMode: record.authMode,
    skillPath: record.skillPath,
    state: "host_reload_needed" as const,
    hostAction: hostAction(record.host),
  });
}

export async function skillAdapterStatus(distributionId: string, home = homedir()) {
  assertDistributionId(distributionId);
  const record = await readManagedSkill(distributionId, home);
  if (!record) return Object.freeze({ ok: true, installed: false, distributionId, state: "not_installed" as const });
  const state = await managedSkillState(record);
  return Object.freeze({
    ok: true,
    installed: state !== "missing",
    distributionId,
    modelId: record.modelId,
    name: record.name,
    host: record.host,
    scope: record.scope,
    authMode: record.authMode,
    skillPath: record.skillPath,
    state,
  });
}

export async function removeSkillAdapter(distributionId: string, home = homedir(), store: CredentialStore = secureCredentialStore) {
  assertDistributionId(distributionId);
  const record = await readManagedSkill(distributionId, home);
  if (!record) return Object.freeze({ ok: true, removed: false, distributionId });
  const state = await managedSkillState(record);
  if (state === "modified") await removeManagedSkill(record, home);
  if (record.authMode === "api-key") await store.deletePassword(SKILL_API_KEY_SERVICE, distributionId);
  await removeManagedSkill(record, home);
  return Object.freeze({ ok: true, removed: true, distributionId });
}

export interface InstalledAgentInput {
  readonly distributionId: string;
  readonly home?: string;
  readonly credentialStore?: CredentialStore;
  readonly remoteInvoker?: RemoteAgentMcpInvoker;
}

/** The installed record plus the credential that calls it. Shared by the single-shot call and the tool round trips. */
async function openInstalledAgent(input: InstalledAgentInput) {
  assertDistributionId(input.distributionId);
  const record = await readManagedSkill(input.distributionId, input.home ?? homedir());
  if (!record) throw new SkillAccessError("target_not_installed", "The Frely Skill target is not installed.");
  let token: string;
  let credential: Awaited<ReturnType<typeof requireLogin>>["credential"] | undefined;
  if (record.authMode === "api-key") {
    const store = input.credentialStore ?? secureCredentialStore;
    token = await store.getPassword(SKILL_API_KEY_SERVICE, record.distributionId).catch(() => null) ?? "";
    if (!token) throw new SkillAccessError("auth_required", "The model-scoped API key is unavailable. Reinstall with frely item install <username/name> --api-key-stdin.");
  } else {
    const login = await requireLogin().catch((error: unknown) => {
      // A refresh outage is not a missing login: tell the caller to retry instead of asking for `frely login`.
      if (error instanceof Error && error.message === LOGIN_REFRESH_UNAVAILABLE) throw new SkillAccessError("remote_call_failed", LOGIN_REFRESH_UNAVAILABLE);
      throw new SkillAccessError("auth_required", "Frely login is required. Run `frely login`.");
    });
    token = login.credential.value;
    credential = login.credential;
  }
  return { record, token, credential };
}

function remoteCallError(error: unknown, authMode: "account" | "api-key"): SkillAccessError {
  if (error instanceof SkillInvocationError && error.code === "entitlement_required") return new SkillAccessError("entitlement_required", "This Frely Agent is not available to the configured credential.");
  if (error instanceof SkillInvocationError && error.code === "payment_required") return new SkillAccessError("payment_required", "Not enough Frely Credit. Run `frely api call credit_products.list` and `frely api call payment_checkout.create` (pass useImmediately:true) to get a payment link for the user, then retry once they have paid.");
  if (error instanceof SkillInvocationError && error.code === "remote_authorization_failed") return new SkillAccessError("remote_authorization_failed", authMode === "api-key" ? "The model-scoped API key was rejected. Reinstall with frely item install <username/name> --api-key-stdin." : "Frely authorization failed. Run `frely login` again.");
  return new SkillAccessError("remote_call_failed", error instanceof SkillInvocationError && error.details.remoteCode ? `The remote Frely Agent call failed (${error.details.remoteCode}).` : "The remote Frely Agent call failed.");
}

export async function invokeInstalledAgent(input: InstalledAgentInput & {
  readonly task: string;
  /** Sent only when given; otherwise the Gateway uses the account's setting. */
  readonly progressSummary?: boolean;
  /** Called with the newest progress line of a long task. */
  readonly onProgress?: (sentence: string) => void;
  readonly taskClient?: RemoteAgentTaskClient;
  readonly signal?: AbortSignal;
}) {
  assertDistributionId(input.distributionId);
  if (!input.task.trim() || Buffer.byteLength(input.task, "utf8") > MAX_TASK_BYTES) throw new SkillAccessError("input_invalid", "Agent input must be non-empty and at most 128 KiB.");
  const { record, token, credential } = await openInstalledAgent(input);
  const target = { relayUrl: new URL(record.mcpUrl).origin, modelId: record.modelId, token, ...(credential ? { credential } : {}) };
  const tasks = input.taskClient ?? remoteAgentTaskClient;
  let taskId: string | undefined;
  try {
    let result: SkillInvocationResult = await (input.remoteInvoker ?? remoteAgentMcpInvoker).invoke({
      ...target,
      task: input.task,
      ...(input.progressSummary === undefined ? {} : { progressSummary: input.progressSummary }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    // A long call returns `running` after about 50 seconds; the task goes on at Frely, so wait for it here (reading is free).
    while (result.state === "running" && result.taskId !== undefined) {
      taskId = result.taskId;
      if (result.progressSummary) input.onProgress?.(result.progressSummary);
      result = await tasks.status({ ...target, taskId, wait: true, ...(input.signal ? { signal: input.signal } : {}) });
    }
    if (result.state === "failed" || result.state === "canceled") throw new SkillInvocationError("remote_call_failed");
    return Object.freeze({ ok: true, distributionId: record.distributionId, modelId: record.modelId, text: result.text, ...(result.usage ? { usage: result.usage } : {}) });
  } catch (error) {
    // The caller gave up (Ctrl-C, `frely agent cancel`): stop the task at Frely too, so it does not keep running and billing.
    if (taskId !== undefined && input.signal?.aborted) await tasks.cancel({ ...target, taskId }).catch(() => undefined);
    throw remoteCallError(error, record.authMode);
  }
}

/** The Agent cannot take caller tools (`client_tools_unsupported`); the run then falls back to one plain call. */
export class ClientToolsUnsupportedError extends Error {
  constructor() {
    super("This Agent does not support local file tools.");
    this.name = "ClientToolsUnsupportedError";
  }
}

export interface InstalledAgentSession {
  readonly distributionId: string;
  readonly modelId: string;
  /** One `invoke` round with caller tools. Errors are the same typed `SkillAccessError`s as `invokeInstalledAgent`. */
  turn(input: { readonly task: string; readonly tools: readonly CallerToolDefinition[]; readonly items: readonly CallerItem[]; readonly signal?: AbortSignal }): Promise<AgentTurnResult>;
}

/** Resolve the credential once and return a handle for several tool rounds; each round is billed on its own. */
export async function openInstalledAgentSession(input: InstalledAgentInput): Promise<InstalledAgentSession> {
  const { record, token, credential } = await openInstalledAgent(input);
  const invoker = input.remoteInvoker ?? remoteAgentMcpInvoker;
  return {
    distributionId: record.distributionId,
    modelId: record.modelId,
    async turn(turn) {
      if (!turn.task.trim() || Buffer.byteLength(turn.task, "utf8") > MAX_TASK_BYTES) throw new SkillAccessError("input_invalid", "Agent input must be non-empty and at most 128 KiB.");
      if (invoker.invokeTurn === undefined) throw new ClientToolsUnsupportedError();
      try {
        return await invoker.invokeTurn({
          relayUrl: new URL(record.mcpUrl).origin,
          modelId: record.modelId,
          token,
          ...(credential ? { credential } : {}),
          task: turn.task,
          tools: turn.tools,
          items: turn.items,
          ...(turn.signal ? { signal: turn.signal } : {}),
        });
      } catch (error) {
        if (error instanceof SkillInvocationError && error.details.remoteCode === "client_tools_unsupported") throw new ClientToolsUnsupportedError();
        throw remoteCallError(error, record.authMode);
      }
    },
  };
}

function assertApiKey(value: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 8 || bytes > 8192 || /[\x00-\x20\x7f]/u.test(value)) {
    throw new SkillAccessError("input_invalid", "The model-scoped API key is invalid.");
  }
}

async function verifyApiKey(manifest: PublicVirtualModelManifest, apiKey: string, fetchFn: typeof fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchFn(manifest.urls.mcp, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "frely-skill-auth-check", method: "tools/list" }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SkillAccessError("remote_authorization_failed", "Could not verify the model-scoped API key.");
  }
  const payload = await response.json().catch(() => null) as unknown;
  const root = record(payload);
  const result = record(root?.result);
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  const hasInvoke = tools.some((tool) => record(tool)?.name === "invoke");
  if (!response.ok || !root || root.error !== undefined || !hasInvoke) {
    throw new SkillAccessError("remote_authorization_failed", "The model-scoped API key cannot access this Frely Agent.");
  }
}


export function publicSkillAccessError(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof SkillAccessError || error instanceof ManagedSkillError) return Object.freeze({ ok: false, error: Object.freeze({ code: error.code, message: error.message }) });
  return Object.freeze({ ok: false, error: Object.freeze({ code: "unexpected_error", message: error instanceof Error ? error.message : "Unexpected error" }) });
}

async function fetchManifest(value: string, fetchFn: typeof fetch): Promise<PublicVirtualModelManifest> {
  const url = normalizedFrelyUrl(value, "invalid_manifest_url");
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SkillAccessError("manifest_fetch_failed", "Unable to fetch the Frely manifest.");
  }
  if (response.status === 404) throw new SkillAccessError("agent_not_found", "No Agent has this name.");
  if (!response.ok) throw new SkillAccessError("manifest_fetch_failed", `Frely manifest request failed with HTTP ${response.status}.`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) throw new SkillAccessError("manifest_invalid", "Frely manifest is too large.");
  let payload: unknown;
  try { payload = JSON.parse(text); }
  catch { throw new SkillAccessError("manifest_invalid", "Frely manifest is not valid JSON."); }
  return parseManifest(payload, url);
}

function parseManifest(value: unknown, sourceUrl: URL): PublicVirtualModelManifest {
  const root = record(value);
  const urls = record(root?.urls);
  if (!root || root.schemaVersion !== MANIFEST_SCHEMA || typeof root.id !== "string" || !DISTRIBUTION_ID.test(root.id) || typeof root.modelId !== "string" || root.modelId.length < 1 || root.modelId.length > 256 || typeof root.version !== "string" || typeof root.name !== "string" || root.name.length < 1 || root.name.length > 120 || !(root.description === null || typeof root.description === "string") || !Array.isArray(root.capabilities) || !urls || typeof urls.manifest !== "string" || typeof urls.mcp !== "string") {
    throw new SkillAccessError("manifest_invalid", "Frely manifest shape is invalid.");
  }
  const canonical = normalizedFrelyUrl(urls.manifest, "manifest_invalid");
  // The manifest answers under its install name however it was asked for (id, name or a former username), so only the origin is compared.
  if (canonical.origin !== sourceUrl.origin || !canonical.pathname.startsWith("/api/public/agents/")) throw new SkillAccessError("manifest_invalid", "Frely manifest canonical URL does not match the requested URL.");
  const mcp = normalizedFrelyUrl(urls.mcp, "manifest_invalid");
  const expectedMcpPath = `/mcp/${encodeURIComponent(root.modelId)}`;
  if (mcp.pathname !== expectedMcpPath || mcp.search) throw new SkillAccessError("manifest_invalid", "Frely MCP URL does not match the published model identity.");
  const capabilities = root.capabilities.map(parseCapability);
  return Object.freeze({
    schemaVersion: MANIFEST_SCHEMA,
    id: root.id,
    modelId: root.modelId,
    version: root.version,
    name: root.name,
    ...(typeof root.installName === "string" && AGENT_NAME.test(root.installName) ? { installName: root.installName } : {}),
    description: root.description as string | null,
    capabilities,
    ...(root.clientTrigger === undefined ? {} : { clientTrigger: parseClientTrigger(root.clientTrigger) }),
    urls: Object.freeze({ manifest: canonical.toString(), mcp: mcp.toString() }),
  });
}

function parseCapability(value: unknown): PublicCapability {
  const item = record(value);
  if (!item || typeof item.id !== "string" || !/^[a-z][a-z0-9-]{2,62}$/u.test(item.id) || (item.level !== "base" && item.level !== "advanced") || !Array.isArray(item.entrypoints) || item.entrypoints.some((entry) => !["model", "mcp", "a2a"].includes(String(entry))) || (item.description !== undefined && typeof item.description !== "string")) {
    throw new SkillAccessError("manifest_invalid", "Frely capability metadata is invalid.");
  }
  return Object.freeze({ id: item.id, level: item.level, entrypoints: Object.freeze(item.entrypoints as ("model" | "mcp" | "a2a")[]), ...(typeof item.description === "string" ? { description: item.description } : {}) });
}

function parseClientTrigger(value: unknown): { readonly description: string; readonly when: readonly string[] } {
  const item = record(value);
  const validText = (text: unknown, max: number): text is string => typeof text === "string" && text.trim().length > 0 && text.length <= max && !/[\x00-\x1f\x7f]/u.test(text);
  if (!item || !validText(item.description, 900) || !Array.isArray(item.when) || item.when.length < 1 || item.when.length > 12 || !item.when.every((text) => validText(text, 300))) {
    throw new SkillAccessError("manifest_invalid", "Frely client trigger metadata is invalid.");
  }
  return Object.freeze({ description: item.description, when: Object.freeze(item.when as string[]) });
}

function renderSkill(manifest: PublicVirtualModelManifest, slug: string): string {
  const description = oneLine(manifest.clientTrigger?.description ?? manifest.description ?? `Use ${manifest.name} through Frely when the user's task matches this Agent.`).slice(0, 900);
  const capabilities = manifest.capabilities.length === 0 ? "- Use the published Agent for tasks described by this Skill." : manifest.capabilities.map((capability) => `- ${capability.id}${capability.description ? `: ${oneLine(capability.description)}` : ""}`).join("\n");
  const triggers = manifest.clientTrigger?.when.map((condition) => `- ${oneLine(condition)}`).join("\n") ?? `- The user explicitly asks for ${oneLine(manifest.name)} or their task matches its published capabilities.`;
  return `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\ncompatibility: ${JSON.stringify("Requires frely-cli and network access to Frely.")}\nmetadata:\n  frely-distribution-id: ${JSON.stringify(manifest.id)}\n  frely-model-id: ${JSON.stringify(manifest.modelId)}\n---\n\n# ${oneLine(manifest.name)}\n\nThe Agent runs remotely on Frely; this Skill contains only trigger and invocation instructions.\n\n## When to use\n\n${triggers}\n\n## Public capabilities\n\n${capabilities}\n\n## Execute\n\nPass the user's complete relevant request to stdin of:\n\n\`frely agent run ${manifest.id} --input-stdin --json\`\n\nDo not put credentials in the command and do not replace the user's current model provider. Return the result to the user. If the user asked you to act on it (for example, carry out a plan), do so with your own tools, following your usual confirmation rules. A call can take several minutes. If your command is cut off, run \`frely agent result --last --wait\` instead of calling again. If the user asked not to see progress updates (for example in their AGENTS.md), add \`--no-progress-summary\` to the run command. If the result starts with NEED_FILES, read those files yourself and call again with the original task plus them. If the remote call fails, surface the returned state instead of inventing current external facts.\n`;
}

function hostAction(host: SkillHost): string {
  if (host === "chatgpt") return "Reload or import the installed Agent Skill in the ChatGPT surface you are using, then verify that it appears in the available Skills list.";
  return "Restart or reload the Agent session if it was already running so it rescans Skills.";
}

function normalizedFrelyUrl(value: string, code: "invalid_manifest_url" | "manifest_invalid"): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new SkillAccessError(code, "Frely URL is invalid."); }
  if (url.username || url.password || url.hash) throw new SkillAccessError(code, "Frely URL is invalid.");
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const frely = url.hostname === "frely.cloud" || url.hostname.endsWith(".frely.cloud");
  if (!(url.protocol === "https:" && frely) && !(url.protocol === "http:" && loopback)) throw new SkillAccessError(code, "Frely URL must use a Frely HTTPS host or loopback development host.");
  return url;
}

function assertDistributionId(value: string): void { if (!DISTRIBUTION_ID.test(value)) throw new SkillAccessError("target_not_installed", "Frely distribution id is invalid."); }
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function oneLine(value: string): string { return value.replace(/\s+/gu, " ").trim(); }
