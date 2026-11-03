import assert from "node:assert/strict";
import test from "node:test";
import { CloudToolError } from "./cloud-item.js";
import { claimInstall, ItemNotFoundError, resolveItem } from "./resolve.js";

const agent = { kind: "agent", id: "creator_distribution_" + "a".repeat(24), name: "frely/gpt800", version: null, manifest: { id: "x" } };

test("resolveItem returns what the server says the name is", async () => {
  assert.equal((await resolveItem("frely/gpt800", async () => agent))?.kind, "agent");
});

test("a server without the tool gives null, so the older lookup is used; a hidden name is a clear not-found", async () => {
  assert.equal(await resolveItem("a/b", async () => { throw new CloudToolError("tool_unavailable_or_forbidden"); }), null);
  await assert.rejects(resolveItem("a/b", async () => { throw new CloudToolError("item_not_found"); }), (error: unknown) => error instanceof ItemNotFoundError && /If you have a gift code/u.test((error as Error).message));
});

test("claimInstall sends the gift with the name and says the gift was not claimed when the item is not found", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const gift = "fsl_" + "a".repeat(32);
  const done = await claimInstall("frely/gpt800", gift, async (_name, input) => { seen.push(input); return { ...agent, claimedBy: { id: "u1", email: "a@x.test" } }; });
  assert.deepEqual(seen[0], { name: "frely/gpt800", gift });
  assert.equal(done?.claimedBy?.email, "a@x.test");
  await assert.rejects(claimInstall("a/b", gift, async () => { throw new CloudToolError("item_not_found"); }), /The gift was not claimed/u);
});

test("claimInstall does not say the gift was not claimed when the server claimed it and the lookup then failed", async () => {
  const gift = `fsl_${"a".repeat(32)}`;
  await assert.rejects(claimInstall("a/b", gift, async () => { throw new CloudToolError("item_not_found_after_claim"); }),
    (error: unknown) => error instanceof ItemNotFoundError && /gift was claimed/u.test((error as Error).message) && !/not claimed/u.test((error as Error).message));
});
