import { homedir } from "node:os";
import { join } from "node:path";
import { requireLogin } from "../auth.js";
import { remoteAgentMcpInvoker, SkillInvocationError } from "./router.js";
import {
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

const MANIFEST_SCHEMA = "frely.virtual-model.public.v1";
const DISTRIBUTION_ID = /^creator_distribution_[a-f0-9]{24}$/u;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_TASK_BYTES = 128 * 1024;

interface PublicCapability {
  readonly id: string;
  readonly level: "base" | "advanced";
  readonly entrypoints: readonly ("model" | "mcp" | "a2a")[];
  readonly description?: string;
}

interface PublicVirtualModelManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA;
  readonly id: string;
  readonly modelId: string;
  readonly version: string;
  readonly name: string;
  readonly description: string | null;
  readonly capabilities: readonly PublicCapability[];
  readonly urls: {
    readonly manifest: string;
    readonly mcp: string;
  };
}

export class SkillAccessError extends Error {
  constructor(
    readonly code: "invalid_manifest_url" | "manifest_fetch_failed" | "manifest_invalid" | "target_not_installed" | "auth_required" | "remote_authorization_failed" | "entitlement_required" | "remote_call_failed" | "input_invalid" | "host_unsupported",
    message: string,
  ) {
    super(message);
    this.name = "SkillAccessError";
  }
}

export async function installSkillAdapter(input: {
  readonly manifestUrl: string;
  readonly host: SkillHost;
  readonly scope: SkillScope;
  readonly cwd?: string;
  readonly home?: string;
  readonly fetchFn?: typeof fetch;
}) {
  const manifest = await fetchManifest(input.manifestUrl, input.fetchFn ?? fetch);
  const home = input.home ?? homedir();
  const existing = await readManagedSkill(manifest.id, home);
  const slug = existing?.slug ?? skillSlug(manifest.name, manifest.id);
  const root = managedSkillRoot(input.host, input.scope, input.cwd, home);
  const skillPath = existing?.skillPath ?? join(root, slug, "SKILL.md");
  const content = renderSkill(manifest, slug);
  const record = await writeManagedSkill({
    home,
    content,
    record: {
      version: 1,
      distributionId: manifest.id,
      manifestUrl: manifest.urls.manifest,
      modelId: manifest.modelId,
      mcpUrl: manifest.urls.mcp,
      name: manifest.name,
      slug,
      host: input.host,
      scope: input.scope,
      skillPath,
    },
  });
  return Object.freeze({
    ok: true,
    distributionId: record.distributionId,
    modelId: record.modelId,
    name: record.name,
    host: record.host,
    scope: record.scope,
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
    skillPath: record.skillPath,
    state,
  });
}

export async function removeSkillAdapter(distributionId: string, home = homedir()) {
  assertDistributionId(distributionId);
  const record = await readManagedSkill(distributionId, home);
  if (!record) return Object.freeze({ ok: true, removed: false, distributionId });
  await removeManagedSkill(record, home);
  return Object.freeze({ ok: true, removed: true, distributionId });
}

export async function invokeInstalledAgent(input: {
  readonly distributionId: string;
  readonly task: string;
  readonly home?: string;
  readonly signal?: AbortSignal;
}) {
  assertDistributionId(input.distributionId);
  if (!input.task.trim() || Buffer.byteLength(input.task, "utf8") > MAX_TASK_BYTES) throw new SkillAccessError("input_invalid", "Agent input must be non-empty and at most 128 KiB.");
  const record = await readManagedSkill(input.distributionId, input.home ?? homedir());
  if (!record) throw new SkillAccessError("target_not_installed", "The Frely Skill target is not installed.");
  const login = await requireLogin().catch(() => { throw new SkillAccessError("auth_required", "Frely login is required. Run `frely login`."); });
  try {
    const result = await remoteAgentMcpInvoker.invoke({
      relayUrl: new URL(record.mcpUrl).origin,
      modelId: record.modelId,
      token: login.credential.value,
      credential: login.credential,
      task: input.task,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return Object.freeze({ ok: true, distributionId: record.distributionId, modelId: record.modelId, text: result.text, ...(result.usage ? { usage: result.usage } : {}) });
  } catch (error) {
    if (error instanceof SkillInvocationError && error.code === "entitlement_required") throw new SkillAccessError("entitlement_required", "This Frely Agent is not available to the current account.");
    if (error instanceof SkillInvocationError && error.code === "remote_authorization_failed") throw new SkillAccessError("remote_authorization_failed", "Frely authorization failed. Run `frely login` again.");
    throw new SkillAccessError("remote_call_failed", "The remote Frely Agent call failed.");
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
  if (canonical.toString() !== sourceUrl.toString()) throw new SkillAccessError("manifest_invalid", "Frely manifest canonical URL does not match the requested URL.");
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
    description: root.description as string | null,
    capabilities,
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

function renderSkill(manifest: PublicVirtualModelManifest, slug: string): string {
  const description = oneLine(manifest.description ?? `Use ${manifest.name} through Frely when the user's task matches this Agent.`).slice(0, 900);
  const capabilities = manifest.capabilities.length === 0 ? "- Use the published Agent for tasks described by this Skill." : manifest.capabilities.map((capability) => `- ${capability.id}${capability.description ? `: ${oneLine(capability.description)}` : ""}`).join("\n");
  return `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\ncompatibility: ${JSON.stringify("Requires frely-cli and network access to Frely.")}\nmetadata:\n  frely-distribution-id: ${JSON.stringify(manifest.id)}\n  frely-model-id: ${JSON.stringify(manifest.modelId)}\n---\n\n# ${manifest.name}\n\nUse this Skill when the user's task matches ${manifest.name}. The Agent runs remotely on Frely; this Skill contains only trigger and invocation instructions.\n\n## Public capabilities\n\n${capabilities}\n\n## Execute\n\nPass the user's complete task to stdin of:\n\n\`frely agent invoke ${manifest.id} --input-stdin --json\`\n\nDo not put credentials in the command and do not replace the user's current model provider. If the remote call fails, surface the returned state instead of inventing current external facts.\n`;
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
