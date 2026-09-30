import test from "node:test";
import assert from "node:assert/strict";
import { MAX_LIFETIME_USD, provisionAgentKey } from "./app-key.js";

test("agent key provisioning rejects out-of-range lifetime budgets before any network call", async () => {
  for (const bad of [0, -1, Number.NaN, MAX_LIFETIME_USD + 0.01, Number.POSITIVE_INFINITY]) {
    await assert.rejects(() => provisionAgentKey(bad), /lifetime-usd/);
  }
});
