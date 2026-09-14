import test from "node:test";
import assert from "node:assert/strict";
import { basicCredentialStore as credentialStore } from "../credential-basic.js";
import { SkillInvocationError, invokeSkill } from "./router.js";

const relayUrl = "http://127.0.0.1:43127";
const account = relayUrl;

test("uses the base Skill flow when no local token is configured", async () => {
  const restore = memoryStore();
  try {
    let baseCalls = 0;
    let remoteCalls = 0;
    const result = await invokeSkill({
      relayUrl,
      modelId: "user/vm-agent/v1",
      task: "basic task",
      baseSkill: async () => { baseCalls += 1; return { text: "base" }; },
      remoteAgentMcp: { invoke: async () => { remoteCalls += 1; return { text: "remote" }; } },
    });
    assert.equal(result.text, "base");
    assert.equal(baseCalls, 1);
    assert.equal(remoteCalls, 0);
  } finally {
    restore();
  }
});

test("returns payment_required only when an advanced capability is reached", async () => {
  const restore = memoryStore();
  try {
    let baseCalls = 0;
    await assert.rejects(
      invokeSkill({
        relayUrl,
        modelId: "user/vm-agent/v1",
        task: "advanced task",
        capability: { id: "server-export", level: "advanced", entrypoints: ["model", "mcp", "a2a"] },
        registrationUrl: "https://app.frely.cloud/register?next=skill",
        baseSkill: async () => { baseCalls += 1; return { text: "must not execute" }; },
        remoteAgentMcp: { invoke: async () => ({ text: "must not execute" }) },
      }),
      (error: unknown) => error instanceof SkillInvocationError
        && error.code === "payment_required"
        && error.details.registrationUrl === "https://app.frely.cloud/register?next=skill",
    );
    assert.equal(baseCalls, 0);
  } finally {
    restore();
  }
});

test("rejects an untrusted registration URL for an advanced capability", async () => {
  const restore = memoryStore();
  try {
    await assert.rejects(
      invokeSkill({
        relayUrl,
        modelId: "user/vm-agent/v1",
        task: "advanced task",
        capability: { id: "server-export", level: "advanced", entrypoints: ["model"] },
        registrationUrl: "http://evil.example/register",
        baseSkill: async () => ({ text: "must not execute" }),
        remoteAgentMcp: { invoke: async () => ({ text: "must not execute" }) },
      }),
      (error: unknown) => error instanceof Error && error.message === "registration_url_required",
    );
  } finally {
    restore();
  }
});

test("configured but expired credentials still select remote MCP and never fall back", async () => {
  const restore = memoryStore();
  try {
    await credentialStore.setPassword("frely-cli-basic-v1", account, JSON.stringify({
      version: 1,
      type: "basic-oauth",
      accessToken: "expired-token",
      expiresAt: 1,
    }));
    let baseCalls = 0;
    let remoteToken = "";
    await assert.rejects(
      invokeSkill({
        relayUrl,
        modelId: "user/vm-agent/v1",
        task: "remote task",
        baseSkill: async () => { baseCalls += 1; return { text: "fallback" }; },
        remoteAgentMcp: { invoke: async ({ token }) => { remoteToken = token; throw new Error("remote rejected"); } },
      }),
      (error: unknown) => error instanceof SkillInvocationError && error.code === "remote_authorization_failed",
    );
    assert.equal(remoteToken, "expired-token");
    assert.equal(baseCalls, 0);
  } finally {
    restore();
  }
});

test("a legacy cookie injected into basic storage cannot authorize a remote Skill", async () => {
  const restore = memoryStore();
  let calls = 0;
  try {
    await credentialStore.setPassword("frely-cli-basic-v1", account, "friday_session_token=synthetic");
    await assert.rejects(invokeSkill({ relayUrl, modelId: "user/vm-agent/v1", task: "remote task",
      baseSkill: async () => { calls++; return { text: "base" }; },
      remoteAgentMcp: { invoke: async () => { calls++; return { text: "remote" }; } },
    }));
    assert.equal(calls, 0);
  } finally { restore(); }
});

function memoryStore(): () => void {
  const values = new Map<string, string>();
  const previous = { ...credentialStore };
  Object.assign(credentialStore, {
    getPassword: async (service: string, key: string) => values.get(`${service}\u0000${key}`) ?? null,
    setPassword: async (service: string, key: string, value: string) => { values.set(`${service}\u0000${key}`, value); },
    deletePassword: async (service: string, key: string) => values.delete(`${service}\u0000${key}`),
  });
  return () => Object.assign(credentialStore, previous);
}
