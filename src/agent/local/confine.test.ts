import assert from "node:assert/strict";
import test from "node:test";
import type { CredentialStore } from "../../credential-store.js";
import { agentEnv, gatewayOrigin, readApiKey } from "./confine.js";
import { MODEL_HOST } from "./model-proxy.js";

test("the Agent's environment has the placeholder and the proxy name, and nothing from the caller's shell", () => {
  const env = agentEnv("/home/u/frely-agents/helper", { model: true }, { PATH: "/usr/bin", HOME: "/home/u", AWS_SECRET_ACCESS_KEY: "s", FRELY_API_KEY: "real", OPENAI_API_KEY: "mine", GITHUB_TOKEN: "t", LANG: "C" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.LANG, "C");
  assert.equal(env.OPENAI_API_KEY, "frely-local-placeholder");
  assert.equal(env.OPENAI_BASE_URL, `http://${MODEL_HOST}/v1`);
  assert.equal(env.ANTHROPIC_BASE_URL, `http://${MODEL_HOST}`);
  assert.equal(env.UV_CACHE_DIR, "/home/u/frely-agents/helper/.cache/uv");
  const text = JSON.stringify(env);
  for (const secret of ["real", "mine", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"]) assert.ok(!text.includes(secret), secret);
});

test("setup gets no model access at all", () => {
  const env = agentEnv("/w", { model: false }, { PATH: "/usr/bin" });
  assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test("model calls go to the public gateway for frely.cloud and to the relay itself elsewhere", () => {
  assert.equal(gatewayOrigin("https://frely.cloud", {}), "https://api.frely.cloud");
  assert.equal(gatewayOrigin("http://127.0.0.1:3000", {}), "http://127.0.0.1:3000");
  assert.equal(gatewayOrigin("https://frely.cloud", { FRELY_GATEWAY_URL: "https://gw.example.com/ignored" }), "https://gw.example.com");
  assert.throws(() => gatewayOrigin("https://frely.cloud", { FRELY_GATEWAY_URL: "http://gw.example.com" }), /HTTPS/u);
});

test("the API key comes from the environment first, then secure storage", async () => {
  const store: CredentialStore = { getPassword: async (service, account) => service === "frely-cli-local-agent-key-v1" && account === "https://api.frely.cloud" ? "stored" : null, setPassword: async () => undefined, deletePassword: async () => true };
  assert.equal(await readApiKey("https://api.frely.cloud", { FRELY_API_KEY: " from-env " }, store), "from-env");
  assert.equal(await readApiKey("https://api.frely.cloud", {}, store), "stored");
  assert.equal(await readApiKey("https://other.example.com", {}, store), undefined);
});
