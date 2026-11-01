import assert from "node:assert/strict";
import test from "node:test";
import type { Controller, ToolResult } from "../../controller/client.js";
import { EXIT } from "../../controller/client.js";
import { approveSites, siteResource } from "./approvals.js";
import type { LocalAgentRecord } from "./store.js";

const record = (overrides: Partial<LocalAgentRecord> = {}): LocalAgentRecord => ({
  version: 1, slug: "helper", source: "alice/helper", repoUrl: "https://github.com/alice/helper", commit: "a".repeat(40), name: "Helper", workspace: "/home/u/frely-agents/helper",
  setup: undefined, run: "node index.js", network: ["pypi.org", "api.example.com"], addedAt: "2026-10-28T00:00:00Z", setupDone: true, approvals: {}, pid: undefined, startedAt: undefined, ...overrides,
});

const data = (value: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });

function fake(answers: Record<string, ToolResult[]>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const controller = { async call(name: string, args: Record<string, unknown>) { calls.push({ name, args }); const next = answers[name]?.shift(); if (!next) throw new Error(`unexpected ${name}`); return next; }, close: async () => undefined, tools: async () => [], instructions: () => undefined } as Controller;
  return { controller, calls };
}
const io = (interactive: boolean) => { const lines: string[] = []; return { interactive, err: (text: string) => { lines.push(text); }, lines }; };

test("a site that is already allowed needs no wait and the request names the device, site and agent", async () => {
  const { controller, calls } = fake({ request_permission: [data({ status: "allowed", expiresAt: "2026-10-29T00:00:00Z" }), data({ status: "allowed", expiresAt: "2026-10-30T00:00:00Z" })] });
  const gained = await approveSites(record(), io(false), { open: async () => controller, deviceId: async () => "dev_1" });
  assert.deepEqual(gained, { "pypi.org": "2026-10-29T00:00:00Z", "api.example.com": "2026-10-30T00:00:00Z" });
  assert.equal(calls[0]!.name, "request_permission");
  assert.deepEqual({ ...calls[0]!.args, reason: undefined }, { device: "dev_1", resource: "net:pypi.org", mode: "window", reason: undefined, command: "frely agent local start helper" });
  assert.match(String(calls[0]!.args.reason), /helper.*pypi\.org/u);
  assert.equal(siteResource("pypi.org"), "net:pypi.org");
});

test("sites that are still approved are not asked for again", async () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const { controller, calls } = fake({});
  const gained = await approveSites(record({ approvals: { "pypi.org": future, "api.example.com": future } }), io(false), { open: async () => controller, deviceId: async () => "dev_1" });
  assert.deepEqual(gained, {});
  assert.equal(calls.length, 0);
});

test("with nobody to wait, a pending request ends with exit code 3 and the link", async () => {
  const { controller } = fake({ request_permission: [data({ status: "pending", shortCode: "ABCDEF", approveUrl: "https://frely.cloud/device?g=ABCDEF" })] });
  const output = io(false);
  await assert.rejects(approveSites(record({ network: ["pypi.org"] }), output, { open: async () => controller, deviceId: async () => "dev_1" }), (error: Error & { exitCode?: number }) => error.exitCode === EXIT.approval && /run the same command again/u.test(error.message));
  assert.match(output.lines.join(""), /https:\/\/frely\.cloud\/device\?g=ABCDEF/u);
});

test("at a terminal the request waits for the owner, and a declined site is left out", async () => {
  const { controller, calls } = fake({
    request_permission: [data({ status: "pending", shortCode: "ABCDEF", approveUrl: "https://frely.cloud/device?g=ABCDEF" }), data({ status: "pending", shortCode: "GHJKLM", approveUrl: "https://frely.cloud/device?g=GHJKLM" })],
    permission_status: [data({ status: "pending" }), data({ status: "approved", mode: "window", expiresAt: "2026-10-29T12:00:00Z" }), data({ status: "denied" })],
  });
  const output = io(true);
  const gained = await approveSites(record(), output, { open: async () => controller, deviceId: async () => "dev_1", sleep: async () => undefined, pollMs: 1 });
  assert.deepEqual(gained, { "pypi.org": "2026-10-29T12:00:00Z" });
  assert.equal(calls.filter((call) => call.name === "permission_status").length, 3);
  assert.match(output.lines.join(""), /api\.example\.com was declined; helper will run without it/u);
});

test("an error answer from FrelyMCP stops the command with its words", async () => {
  const { controller } = fake({ request_permission: [{ isError: true, content: [{ type: "text", text: "device offline" }] }] });
  await assert.rejects(approveSites(record({ network: ["pypi.org"] }), io(true), { open: async () => controller, deviceId: async () => "dev_1" }), /Could not ask for approval of pypi\.org: device offline/u);
});
