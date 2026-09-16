import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CredentialStore } from "../credential-store.js";
import { installSkillAdapter, invokeInstalledAgent, removeSkillAdapter, skillAdapterStatus } from "./access.js";

const distributionId = "creator_distribution_0123456789abcdef01234567";
const manifestUrl = `https://app.frely.cloud/api/public/virtual-models/${distributionId}`;
const modelId = "user/vm-0123456789abcdef0123456789abcdef/v1";

function manifest() {
  return {
    schemaVersion: "frely.virtual-model.public.v1",
    id: distributionId,
    modelId,
    version: "v1",
    name: "TripReady",
    description: "Checks travel weather, exchange rates, and public holidays.",
    capabilities: [
      { id: "weather-forecast", level: "base", entrypoints: ["model", "mcp", "a2a"], description: "Read forecasts." },
    ],
    urls: {
      manifest: manifestUrl,
      mcp: `https://api.frely.cloud/mcp/${encodeURIComponent(modelId)}`,
    },
  };
}
function fetchManifest(payload = manifest()): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}

function fetchManifestWithApiKey(expectedKey: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if ((init?.method ?? "GET") === "GET") return Response.json(manifest());
    assert.equal(url.toString(), `https://api.frely.cloud/mcp/${encodeURIComponent(modelId)}`);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${expectedKey}`);
    return Response.json({ jsonrpc: "2.0", id: "frely-skill-auth-check", result: { tools: [{ name: "invoke" }] } });
  }) as typeof fetch;
}

function memoryCredentialStore(): CredentialStore {
  const values = new Map<string, string>();
  const key = (service: string, account: string) => `${service}\u0000${account}`;
  return {
    async getPassword(service, account) { return values.get(key(service, account)) ?? null; },
    async setPassword(service, account, password) { values.set(key(service, account), password); },
    async deletePassword(service, account) { return values.delete(key(service, account)); },
  };
}

async function tempRoot(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "frely-skill-")));
}

test("installs a managed trigger Skill without installing the remote Agent", async () => {
  const root = await tempRoot();
  try {
    const result = await installSkillAdapter({ manifestUrl, host: "pi", scope: "global", home: root, fetchFn: fetchManifest() });
    assert.equal(result.distributionId, distributionId);
    assert.equal(result.skillPath, join(root, ".pi", "agent", "skills", "frely-tripready-01234567", "SKILL.md"));
    const text = await readFile(result.skillPath, "utf8");
    assert.match(text, /frely agent invoke creator_distribution_/u);
    assert.doesNotMatch(text, /api\.frely\.cloud\/mcp/u);
    const status = await skillAdapterStatus(distributionId, root);
    assert.equal(status.state, "managed");
    assert.equal(status.installed, true);
    const removed = await removeSkillAdapter(distributionId, root);
    assert.equal(removed.removed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses project Agent Skills path for generic compatible hosts", async () => {
  const root = await tempRoot();
  const project = join(root, "project");
  try {
    const result = await installSkillAdapter({ manifestUrl, host: "generic", scope: "project", home: root, cwd: project, fetchFn: fetchManifest() });
    assert.equal(result.skillPath, join(project, ".agents", "skills", "frely-tripready-01234567", "SKILL.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to overwrite a user-modified managed Skill", async () => {
  const root = await tempRoot();
  try {
    const result = await installSkillAdapter({ manifestUrl, host: "pi", scope: "global", home: root, fetchFn: fetchManifest() });
    await writeFile(result.skillPath, `${await readFile(result.skillPath, "utf8")}\nuser edit\n`, "utf8");
    await assert.rejects(
      () => installSkillAdapter({ manifestUrl, host: "pi", scope: "global", home: root, fetchFn: fetchManifest() }),
      /modified/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects non-Frely manifest URLs before fetching", async () => {
  let called = false;
  const fetchFn = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
  await assert.rejects(
    () => installSkillAdapter({ manifestUrl: "https://example.com/model.json", host: "generic", scope: "global", fetchFn }),
    /Frely URL/u,
  );
  assert.equal(called, false);
});

test("rejects an MCP URL that does not match the published model identity", async () => {
  const root = await tempRoot();
  try {
    const payload = manifest();
    payload.urls.mcp = "https://api.frely.cloud/mcp/user%2Fother%2Fv1";
    await assert.rejects(
      () => installSkillAdapter({ manifestUrl, host: "generic", scope: "global", home: root, fetchFn: fetchManifest(payload) }),
      /does not match/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("stores a model-scoped API key outside the Skill and uses it for invocation", async () => {
  const root = await tempRoot();
  const store = memoryCredentialStore();
  const apiKey = "frely_demo_model_key_123456789";
  try {
    const installed = await installSkillAdapter({
      manifestUrl,
      host: "chatgpt",
      scope: "global",
      home: root,
      apiKey,
      credentialStore: store,
      fetchFn: fetchManifestWithApiKey(apiKey),
    });
    assert.equal(installed.authMode, "api-key");
    const skillText = await readFile(installed.skillPath, "utf8");
    assert.doesNotMatch(skillText, /frely_demo_model_key/u);
    const status = await skillAdapterStatus(distributionId, root);
    assert.equal(status.installed, true);
    if (!status.installed) throw new Error("skill_status_missing");
    assert.equal(status.authMode, "api-key");

    let invokedToken = "";
    const result = await invokeInstalledAgent({
      distributionId,
      task: "Plan my Tokyo trip.",
      home: root,
      credentialStore: store,
      remoteInvoker: {
        async invoke(input) {
          invokedToken = input.token;
          assert.equal(input.credential, undefined);
          return { text: "ready" };
        },
      },
    });
    assert.equal(invokedToken, apiKey);
    assert.equal(result.text, "ready");

    const removed = await removeSkillAdapter(distributionId, root, store);
    assert.equal(removed.removed, true);
    await assert.rejects(
      () => invokeInstalledAgent({ distributionId, task: "again", home: root, credentialStore: store }),
      /not installed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed API-key verification leaves no managed Skill or credential", async () => {
  const root = await tempRoot();
  const store = memoryCredentialStore();
  const apiKey = "frely_demo_invalid_key_123456789";
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") return Response.json(manifest());
    return Response.json({ jsonrpc: "2.0", id: "frely-skill-auth-check", error: { code: -32000, message: "denied" } });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => installSkillAdapter({ manifestUrl, host: "chatgpt", scope: "global", home: root, apiKey, credentialStore: store, fetchFn }),
      /cannot access/u,
    );
    const status = await skillAdapterStatus(distributionId, root);
    assert.equal(status.installed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});