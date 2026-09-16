import { homedir } from "node:os";
import { normalizeRelayUrl } from "./auth.js";
import { credentialStore as secureCredentialStore, type CredentialStore } from "./credential-store.js";
import { readManagedSkill } from "./skill/managed.js";
import { SKILL_API_KEY_SERVICE } from "./skill/access.js";

export class KeyBudgetError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message);
    this.name = "KeyBudgetError";
  }
}

export async function getKeyBudget(input: {
  readonly apiKey?: string;
  readonly relayUrl?: string;
  readonly distributionId?: string;
  readonly home?: string;
  readonly credentialStore?: CredentialStore;
  readonly fetchFn?: typeof fetch;
}): Promise<Readonly<Record<string, unknown>>> {
  if ((input.apiKey !== undefined) === (input.distributionId !== undefined)) {
    throw new KeyBudgetError("input_invalid", "Use exactly one of --api-key-stdin or --distribution <distribution-id>.");
  }
  let apiKey: string;
  let relayUrl: string;
  if (input.distributionId !== undefined) {
    if (input.relayUrl !== undefined) throw new KeyBudgetError("input_invalid", "--relay cannot override an installed Skill's credential destination.");
    if (!/^creator_distribution_[a-f0-9]{24}$/u.test(input.distributionId)) throw new KeyBudgetError("input_invalid", "Frely distribution id is invalid.");
    const installed = await readManagedSkill(input.distributionId, input.home ?? homedir());
    if (!installed) throw new KeyBudgetError("target_not_installed", "The Frely Skill target is not installed.");
    if (installed.authMode !== "api-key") throw new KeyBudgetError("api_key_required", "This Skill uses account login. Supply an API key through --api-key-stdin.");
    const origin = new URL(installed.manifestUrl);
    if (origin.username || origin.password || origin.hash || !(origin.protocol === "https:" && (origin.hostname === "frely.cloud" || origin.hostname.endsWith(".frely.cloud")) || origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) {
      throw new KeyBudgetError("input_invalid", "Installed Skill credential destination is invalid.");
    }
    relayUrl = origin.origin;
    try {
      apiKey = await (input.credentialStore ?? secureCredentialStore).getPassword(SKILL_API_KEY_SERVICE, installed.distributionId) ?? "";
    } catch {
      throw new KeyBudgetError("credential_store_failed", "Could not read the saved API key securely.");
    }
    if (!apiKey) throw new KeyBudgetError("api_key_required", "The saved API key is unavailable. Reinstall this Skill with --api-key-stdin.");
  } else {
    apiKey = input.apiKey!;
    try {
      const raw = input.relayUrl ?? process.env.FRELY_RELAY_URL;
      if (raw) {
        const parsed = new URL(raw);
        if (parsed.username || parsed.password || parsed.hash) throw new Error("invalid");
      }
      relayUrl = normalizeRelayUrl(raw);
    } catch {
      throw new KeyBudgetError("input_invalid", "Relay must be an HTTPS URL or a loopback development URL without credentials.");
    }
  }
  if (Buffer.byteLength(apiKey, "utf8") < 8 || Buffer.byteLength(apiKey, "utf8") > 8192 || /[\x00-\x20\x7f]/u.test(apiKey)) {
    throw new KeyBudgetError("input_invalid", "The API key is invalid.");
  }
  try {
    const response = await (input.fetchFn ?? fetch)(relayUrl + "/api/key/budget", {
      method: "GET",
      headers: { accept: "application/json", authorization: "Bearer " + apiKey },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const code = response.status === 401 ? "api_key_rejected" : response.status === 403 ? "access_denied" : response.status === 402 ? "funding_source_unavailable" : response.status === 429 ? "rate_limited" : "budget_request_failed";
      throw new KeyBudgetError(code, "Key budget request failed with HTTP " + response.status + ".", response.status);
    }
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > 1024 * 1024 || body.includes(apiKey)) throw new KeyBudgetError("invalid_response", "Frely returned an invalid budget response.");
    const result: unknown = JSON.parse(body);
    if (result === null || typeof result !== "object" || Array.isArray(result)) throw new KeyBudgetError("invalid_response", "Frely returned an invalid budget response.");
    return Object.freeze(result as Record<string, unknown>);
  } catch (error) {
    if (error instanceof KeyBudgetError) throw error;
    throw new KeyBudgetError("budget_request_failed", "Unable to read Key budget. Check the Relay URL and network connection.");
  }
}

export function publicKeyBudgetError(error: unknown) {
  return {
    ok: false,
    error: error instanceof KeyBudgetError
      ? { code: error.code, message: error.message, ...(error.status === undefined ? {} : { status: error.status }) }
      : { code: "budget_request_failed", message: "Unable to read Key budget." },
  };
}

