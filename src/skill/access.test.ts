import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CredentialStore } from "../credential-store.js";
import { SkillInvocationError } from "./router.js";
import { agentManifestUrl, installSkillAdapter, invokeInstalledAgent, removeSkillAdapter, resolveAgentTarget, skillAdapterStatus } from "./access.js";
import { LOGIN_REFRESH_UNAVAILABLE, loginDevice } from "../auth.js";
import { basicCredentialStore } from "../credential-basic.js";
import { useMemoryCredentialStore } from "../test-support.js";

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
    assert.equal(result.skillPath, join(root, ".pi", "agent", "skills", "tripready", "SKILL.md"));
    const text = await readFile(result.skillPath, "utf8");
    assert.match(text, /frely agent run creator_distribution_/u);
    assert.doesNotMatch(text, /api\.frely\.cloud\/mcp/u);
    assert.match(text, /carry out a plan\), do so with your own tools/u);
    assert.match(text, /can take several minutes/u);
    assert.match(text, /frely agent result --last --wait/u);
    assert.match(text, /result starts with NEED_FILES/u);
    assert.doesNotMatch(text, /remote Agent's result/u);
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
    assert.equal(result.skillPath, join(project, ".agents", "skills", "tripready", "SKILL.md"));
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

test("published client trigger metadata drives Skill discovery and invocation", async () => {
  const home = await tempRoot();
  try {
    const trigger = { description: "Ask GPT-800 for specialist help.", when: ["The user explicitly requests GPT-800.", "A difficult reasoning task needs GPT-800's help."] };
    const payload = { ...manifest(), name: "GPT-800", clientTrigger: trigger };
    const installed = await installSkillAdapter({ manifestUrl, host: "generic", scope: "global", home, fetchFn: fetchManifest(payload) });
    const text = await readFile(installed.skillPath, "utf8");
    const frontmatter = text.split("---")[1]!;
    assert.ok(frontmatter.includes(JSON.stringify(trigger.description)));
    for (const condition of trigger.when) assert.ok(text.includes(condition));
    assert.ok(text.includes("frely agent run " + distributionId + " --input-stdin --json"));
    assert.ok(!text.includes(payload.urls.mcp));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("invalid client triggers fail before installing a Skill", async () => {
  const home = await tempRoot();
  try {
    for (const trigger of [
      { description: "", when: ["Use when asked."] },
      { description: "valid", when: [] },
      { description: "valid", when: ["line one\nline two"] },
    ]) {
      await assert.rejects(installSkillAdapter({ manifestUrl, host: "generic", scope: "global", home, fetchFn: fetchManifest({ ...manifest(), ...{ clientTrigger: trigger } }) }), /trigger metadata is invalid/u);
    }
    assert.equal((await skillAdapterStatus(distributionId, home)).installed, false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("account-mode invocation tells a refresh outage apart from a missing login", async (t) => {
  const root = await tempRoot();
  const configDir = await tempRoot();
  const oldFetch = globalThis.fetch;
  const previous = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FRELY_NO_BROWSER: process.env.FRELY_NO_BROWSER };
  const restore = useMemoryCredentialStore();
  process.env.XDG_CONFIG_HOME = configDir;
  process.env.FRELY_NO_BROWSER = "1";
  t.after(async () => {
    restore(); globalThis.fetch = oldFetch;
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(root, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });
  await installSkillAdapter({ manifestUrl, host: "chatgpt", scope: "global", home: root, fetchFn: fetchManifest() });
  const invoke = () => invokeInstalledAgent({ distributionId, task: "Plan my Tokyo trip.", home: root, remoteInvoker: { async invoke() { throw new Error("must not be called"); } } });
  await assert.rejects(invoke(), /Frely login is required/u);

  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/auth/device/code") return Response.json({ device_code: "synthetic-code", user_code: "SYNTH", verification_uri: "https://test.invalid/device", verification_uri_complete: "https://test.invalid/device?user_code=SYNTH", expires_in: 300, interval: 1 });
    if (path === "/api/auth/oauth2/token" && new URLSearchParams(String(options?.body)).get("grant_type") !== "refresh_token") return Response.json({ access_token: "synthetic-basic", refresh_token: "synthetic-refresh", token_type: "bearer", expires_in: 3600 });
    if (path === "/api/auth/me") return Response.json({ user: { id: "user_test", email: "user@example.com" } });
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await loginDevice("https://test.invalid");
  const stored = JSON.parse((await basicCredentialStore.getPassword("frely-cli-basic-v1", "https://test.invalid"))!);
  await basicCredentialStore.setPassword("frely-cli-basic-v1", "https://test.invalid", JSON.stringify({ ...stored, expiresAt: Date.now() - 1_000 }));
  await assert.rejects(invoke(), (error: Error) => {
    assert.equal(error.message, LOGIN_REFRESH_UNAVAILABLE);
    assert.equal((error as { code?: string }).code, "remote_call_failed");
    return true;
  });
});

test("an Agent is installed and found by username/name, and an id keeps working", async () => {
  const root = await tempRoot();
  try {
    assert.equal(agentManifestUrl("ada/tripready", "https://app.frely.cloud"), "https://app.frely.cloud/api/public/virtual-models/ada%2Ftripready");
    assert.equal(agentManifestUrl("ada/tripready@2", "https://app.frely.cloud"), "https://app.frely.cloud/api/public/virtual-models/ada%2Ftripready%402");
    assert.equal(agentManifestUrl(distributionId, "https://app.frely.cloud"), manifestUrl);
    assert.throws(() => agentManifestUrl("https://example.com/manifest.json", "https://app.frely.cloud"), /Use the Agent's name/u);

    const named = { ...manifest(), installName: "ada/tripready", urls: { ...manifest().urls, manifest: "https://app.frely.cloud/api/public/virtual-models/ada%2Ftripready" } };
    await installSkillAdapter({ manifestUrl: agentManifestUrl("ada/tripready", "https://app.frely.cloud"), host: "pi", scope: "global", home: root, fetchFn: fetchManifest(named) });
    const never = (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch;
    assert.equal(await resolveAgentTarget("ada/tripready", "https://app.frely.cloud", root, never), distributionId);
    assert.equal(await resolveAgentTarget("ada/tripready@2", "https://app.frely.cloud", root, never), distributionId);
    assert.equal(await resolveAgentTarget(distributionId, "https://app.frely.cloud", root, never), distributionId);
    // A name never installed here is asked of the server.
    assert.equal(await resolveAgentTarget("bob/other", "https://app.frely.cloud", root, fetchManifest()), distributionId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a name no Agent has is reported as not found", async () => {
  const missing = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(
    installSkillAdapter({ manifestUrl: agentManifestUrl("ada/nothing", "https://app.frely.cloud"), host: "pi", scope: "global", fetchFn: missing }),
    (error: unknown) => (error as { code?: string }).code === "agent_not_found",
  );
});

test("a remote payment_required becomes a payment hint and an unknown remote code is not a login failure", async () => {
  const root = await tempRoot();
  const store = memoryCredentialStore();
  const apiKey = "frely_demo_model_key_123456789";
  try {
    await installSkillAdapter({ manifestUrl, host: "chatgpt", scope: "global", home: root, apiKey, credentialStore: store, fetchFn: fetchManifestWithApiKey(apiKey) });
    const invoke = (error: SkillInvocationError) => invokeInstalledAgent({ distributionId, task: "Plan.", home: root, credentialStore: store, remoteInvoker: { async invoke() { throw error; } } });
    await assert.rejects(invoke(new SkillInvocationError("payment_required")), (error: Error) => {
      assert.equal((error as { code?: string }).code, "payment_required");
      assert.match(error.message, /credit_products\.list/u);
      assert.match(error.message, /payment_checkout\.create/u);
      assert.match(error.message, /useImmediately:true/u);
      assert.doesNotMatch(error.message, /login/u);
      return true;
    });
    await assert.rejects(invoke(new SkillInvocationError("remote_call_failed", { remoteCode: "agent_unavailable" })), (error: Error) => {
      assert.equal((error as { code?: string }).code, "remote_call_failed");
      assert.match(error.message, /agent_unavailable/u);
      assert.doesNotMatch(error.message, /login/u);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
