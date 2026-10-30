import assert from "node:assert/strict";
import test from "node:test";
import { createShareViaApproval } from "./control.js";

const grant = {
  id: "frps_" + "ab".repeat(12), url: "https://s" + "0a".repeat(7) + ".share.example.test/?t=abc", expiresAt: new Date(Date.now() + 3600_000).toISOString(), node: "dmit-la",
  bandwidthBytesPerSecond: 1048576, remainingBytes: 100 * 1048576,
  frpc: { serverAddr: "203.0.113.7", serverPort: 7000, user: "frps_" + "ab".repeat(12), token: "frs_" + "T".repeat(43), proxyName: "share", subdomain: "s" + "0a".repeat(7) },
};
const failure = (error: object) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] });
const needsApproval = failure({ code: "confirmation_required", approvalCode: "CDEFGHJK", url: "https://frely.cloud/device?g=CDEFGHJK", expiresAt: new Date(Date.now() + 60_000).toISOString(), summary: "Open a public link" });

test("the first call asks for the owner's approval, the share is created once after it, with the same approval code", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const controller = {
    async call(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "permission_status") return { structuredContent: { status: "approved" }, content: [] };
      return (args.arguments as Record<string, unknown>).approvalCode === undefined ? needsApproval : { structuredContent: grant, content: [] };
    },
  };
  const written: string[] = [];
  const result = await createShareViaApproval(controller, { deviceId: "drd_" + "a".repeat(32), ttlSeconds: 3600 }, (text) => { written.push(text); });
  assert.equal(result.id, grant.id);
  assert.deepEqual(calls.map((call) => call.name), ["frely_call", "permission_status", "frely_call"]);
  assert.deepEqual(calls[0]!.args, { tool: "shares.create", arguments: { deviceId: "drd_" + "a".repeat(32), ttlSeconds: 3600 } });
  assert.deepEqual(calls[2]!.args, { tool: "shares.create", arguments: { deviceId: "drd_" + "a".repeat(32), ttlSeconds: 3600, approvalCode: "CDEFGHJK" } });
  assert.match(written.join(""), /https:\/\/frely\.cloud\/device\?g=CDEFGHJK/u);
});

test("a denied approval creates nothing", async () => {
  let created = 0;
  const controller = {
    async call(name: string) {
      if (name === "permission_status") return { structuredContent: { status: "denied" }, content: [] };
      created += 1;
      return needsApproval;
    },
  };
  await assert.rejects(createShareViaApproval(controller, { deviceId: "drd_" + "a".repeat(32) }, () => undefined), /not approved/u);
  assert.equal(created, 1);
});
