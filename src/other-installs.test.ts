import test from "node:test";
import assert from "node:assert/strict";
import { olderThan, otherInstallNotes, otherInstalls } from "./other-installs.js";

test("versions before the locked refresh are flagged", () => {
  assert.equal(olderThan("0.23.33", "0.23.34"), true);
  assert.equal(olderThan("0.21.0", "0.23.34"), true);
  assert.equal(olderThan("0.23.34", "0.23.34"), false);
  assert.equal(olderThan("1.0.0", "0.23.34"), false);
  assert.equal(olderThan("not-a-version", "0.23.34"), false);
});

test("other copies on PATH are listed with their versions, never the running one", async () => {
  const versions: Record<string, string | null> = { "/old/frely": "0.21.0", "/new/frely": "0.23.41", "/broken/frely": null };
  const found = await otherInstalls({ current: "/me/frely", paths: ["/me/frely", "/old/frely", "/new/frely", "/broken/frely"], version: async (path) => versions[path] ?? null });
  assert.deepEqual(found.map((item) => [item.path, item.unsafeRefresh]), [["/old/frely", true], ["/new/frely", false], ["/broken/frely", false]]);
  const notes = otherInstallNotes(found);
  assert.match(notes[0]!, /^Warning: an older frely 0\.21\.0 .*can sign it out/u);
  assert.match(notes[1]!, /^Note: another frely 0\.23\.41 is installed at \/new\/frely/u);
  assert.match(notes[2]!, /^Note: another frely is installed at \/broken\/frely/u);
  assert.deepEqual(otherInstallNotes(await otherInstalls({ current: "/me/frely", paths: ["/me/frely"] })), []);
});
