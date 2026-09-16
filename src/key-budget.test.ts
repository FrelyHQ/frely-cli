import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKeyBudget, KeyBudgetError, publicKeyBudgetError } from "./key-budget.js";
import { writeManagedSkill } from "./skill/managed.js";
import type { CredentialStore } from "./credential-store.js";

const apiKey = "synthetic_budget_key_12345";
const distributionId = "creator_distribution_0123456789abcdef01234567";

test("queries self usage using only the supplied bearer Key and preserves independent limits", async () => {
  const payload = { usage: { amount: 5 }, limits: [{ limitValue: 10, usedValue: 5, remainingValue: 5 }], sources: [{ name: "Creator", remainingValue: 0 }, { name: "PAYG", remainingValue: 3 }] };
  let calls = 0;
  const result = await getKeyBudget({ apiKey, relayUrl: "https://app.frely.cloud", fetchFn: async (url, init) => {
    calls++;
    assert.equal(url, "https://app.frely.cloud/api/key/budget");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer " + apiKey);
    assert.equal(headers.has("cookie"), false);
    return Response.json(payload);
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, payload);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test("stored Agent Key uses its manifest's Relay origin and cannot be sent to a caller override", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-budget-")));
  let reads = 0;
  const store: CredentialStore = {
    async getPassword(service, id) {
      reads++;
      assert.equal(service, "frely-cli-skill-api-key-v1");
      assert.equal(id, distributionId);
      return apiKey;
    },
    async setPassword() { throw new Error("read only"); },
    async deletePassword() { throw new Error("read only"); },
  };
  try {
    await writeManagedSkill({ home, content: "managed test Skill", record: {
      version: 1, distributionId, manifestUrl: "https://app.frely.cloud/api/public/virtual-models/" + distributionId,
      modelId: "GPT-800", mcpUrl: "https://api.frely.cloud/mcp/GPT-800", name: "GPT-800", slug: "gpt-800",
      host: "generic", scope: "global", authMode: "api-key", skillPath: join(home, "skills", "gpt-800", "SKILL.md"),
    } });
    const result = await getKeyBudget({ distributionId, home, credentialStore: store, fetchFn: async (url, init) => {
      assert.equal(url, "https://app.frely.cloud/api/key/budget");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + apiKey);
      return Response.json({ usage: {} });
    } });
    assert.deepEqual(result, { usage: {} });
    await assert.rejects(getKeyBudget({ distributionId, home, credentialStore: store, relayUrl: "https://example.com" }), (e: unknown) => e instanceof KeyBudgetError && e.code === "input_invalid");
    assert.equal(reads, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("authentication, funding, and rate errors do not echo upstream bodies or credentials", async () => {
  for (const [status, code] of [[401, "api_key_rejected"], [402, "funding_source_unavailable"], [429, "rate_limited"]] as const) {
    await assert.rejects(getKeyBudget({ apiKey, fetchFn: async () => Response.json({ message: apiKey }, { status }) }), (e: unknown) => {
      const result = publicKeyBudgetError(e);
      assert.equal(result.error.code, code);
      assert.equal(JSON.stringify(result).includes(apiKey), false);
      return true;
    });
  }
  await assert.rejects(getKeyBudget({ apiKey, fetchFn: async () => { throw new Error(apiKey); } }), (e: unknown) => !JSON.stringify(publicKeyBudgetError(e)).includes(apiKey));
  await assert.rejects(getKeyBudget({ apiKey, fetchFn: async () => Response.json({ reflected: apiKey }) }), (e: unknown) => e instanceof KeyBudgetError && e.code === "invalid_response");
});

test("ambiguous credentials and unsafe destinations fail before any network request", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => { calls++; return Response.json({}); };
  for (const input of [
    {},
    { apiKey, distributionId },
    { apiKey: apiKey + "\n" },
    { apiKey, relayUrl: "http://example.com" },
    { apiKey, relayUrl: "https://user:password@example.com" },
    { apiKey, relayUrl: "https://example.com/#fragment" },
  ]) {
    await assert.rejects(getKeyBudget({ ...input, fetchFn }), KeyBudgetError);
  }
  assert.equal(calls, 0);
});
