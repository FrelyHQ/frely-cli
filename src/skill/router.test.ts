import test from "node:test";
import assert from "node:assert/strict";
import { basicCredentialStore as credentialStore } from "../credential-basic.js";
import { SkillInvocationError, invokeSkill, remoteAgentMcpInvoker } from "./router.js";

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

test("remote MCP errors pass their error.data.code on and only unknown ones lose it", async () => {
  const oldFetch = globalThis.fetch;
  const invokeWith = async (data?: Record<string, unknown>) => {
    globalThis.fetch = (async () => Response.json({ jsonrpc: "2.0", id: "skill-invoke", error: { code: -32000, message: "no", ...(data ? { data } : {}) } })) as typeof fetch;
    return remoteAgentMcpInvoker.invoke({ relayUrl, modelId: "user/vm-agent/v1", token: "token", task: "task" }).then(() => assert.fail("must reject"), (error: unknown) => error as SkillInvocationError);
  };
  try {
    for (const code of ["payment_required", "entitlement_required", "capability_unavailable"] as const) {
      assert.equal((await invokeWith({ code })).code, code);
    }
    const unknown = await invokeWith({ code: "agent_unavailable" });
    assert.equal(unknown.code, "remote_call_failed");
    assert.equal(unknown.details.remoteCode, "agent_unavailable");
    assert.equal((await invokeWith()).code, "remote_call_failed");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("remote invokeTurn sends tools and items and reads a tool_calls result and a final answer", async () => {
  const oldFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  let step = 0;
  try {
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      step += 1;
      return Response.json({ jsonrpc: "2.0", id: "skill-invoke", result: step === 1
        ? { content: [{ type: "text", text: "tools" }], structuredContent: { request_id: "req_1", status: "tool_calls", calls: [{ callId: "c1", name: "read_file", arguments: "{}" }], items: [{ type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" }], usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } } }
        : { content: [{ type: "text", text: "answer" }], structuredContent: { request_id: "req_2", status: "completed", usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 } } } });
    }) as typeof fetch;
    const tools = [{ type: "function" as const, name: "read_file", description: "d", parameters: { type: "object" } }];
    const base = { relayUrl: "https://relay.test", modelId: "friday/x", token: "t" };
    const first = await remoteAgentMcpInvoker.invokeTurn!({ ...base, task: "task", tools, items: [] });
    assert.deepEqual(first, { status: "tool_calls", calls: [{ callId: "c1", name: "read_file", arguments: "{}" }], items: [{ type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" }], requestId: "req_1", usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } });
    assert.equal(first.status === "tool_calls" && first.items.length, 1);
    const second = await remoteAgentMcpInvoker.invokeTurn!({ ...base, task: "task", tools, items: [...(first.status === "tool_calls" ? first.items : []), { type: "function_call_output", call_id: "c1", output: "ok" }] });
    assert.deepEqual(second, { status: "completed", text: "answer", requestId: "req_2", usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 } });
    const args = (index: number) => ((bodies[index]!.params as Record<string, unknown>).arguments as Record<string, unknown>);
    assert.equal(args(0).input, "task");
    assert.equal((args(0).tools as unknown[]).length, 1);
    assert.equal("items" in args(0), false);
    assert.equal((args(1).items as unknown[]).length, 2);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("remote invokeTurn passes client_tools_unsupported on as the remote code", async () => {
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ jsonrpc: "2.0", id: "skill-invoke", error: { code: -32000, message: "no", data: { code: "client_tools_unsupported" } } })) as typeof fetch;
    await assert.rejects(
      () => remoteAgentMcpInvoker.invokeTurn!({ relayUrl: "https://relay.test", modelId: "friday/x", token: "t", task: "t", tools: [], items: [] }),
      (error: unknown) => error instanceof SkillInvocationError && error.details.remoteCode === "client_tools_unsupported",
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
});
