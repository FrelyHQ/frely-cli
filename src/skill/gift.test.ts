import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudToolError } from "./cloud-item.js";
import { redeemGift } from "./gift.js";

const code = `fsl_${"a".repeat(32)}`;
const sink = () => { const lines: string[] = []; return { lines, write: (text: string) => lines.push(text) }; };

test("redeemGift claims the code through share_links.redeem", async () => {
  const out = sink(); const calls: unknown[] = [];
  await redeemGift(code, async (name, input) => { calls.push([name, input]); return { productKind: "agent", productId: "p", giftUnits: 5 }; }, out);
  assert.deepEqual(calls, [["share_links.redeem", { code }]]);
  assert.match(out.lines.join(""), /Gift claimed/);
});

test("redeemGift accepts a code this account already claimed and passes other errors on", async () => {
  const out = sink();
  await redeemGift(code, async () => { throw new CloudToolError("creator_share_already_claimed"); }, out);
  assert.match(out.lines.join(""), /already claimed/);
  await assert.rejects(redeemGift(code, async () => { throw new CloudToolError("creator_share_link_exhausted"); }, sink()), { code: "creator_share_link_exhausted" });
});

test("redeemGift refuses a malformed code before any call", async () => {
  let called = false;
  await assert.rejects(redeemGift("nope", async () => { called = true; return {}; }, sink()), /fsl_/);
  assert.equal(called, false);
});
