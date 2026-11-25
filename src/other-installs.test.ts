import test from "node:test";
import assert from "node:assert/strict";
import { olderThan, otherInstallNotes, otherInstalls, removalCommand } from "./other-installs.js";

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
  const notes = otherInstallNotes(found, "linux");
  assert.match(notes[0]!, /^Warning: an older frely 0\.21\.0 .*can sign it out/u);
  assert.match(notes[1]!, /^Note: another frely 0\.23\.41 is installed at \/new\/frely/u);
  assert.match(notes[2]!, /^Note: another frely is installed at \/broken\/frely.*Remove it with: rm '\/broken\/frely'$/u);
  assert.deepEqual(otherInstallNotes(await otherInstalls({ current: "/me/frely", paths: ["/me/frely"] })), []);
});

test("each other copy comes with the command that removes only that copy", () => {
  const nvm = "/Users/w/.nvm/versions/node/v24.14.1/lib/node_modules/frely-cli/dist/index.js";
  assert.equal(removalCommand(nvm, "darwin"), "'/Users/w/.nvm/versions/node/v24.14.1/bin/npm' uninstall -g --prefix '/Users/w/.nvm/versions/node/v24.14.1' frely-cli");
  assert.equal(removalCommand("/Users/w/.bun/install/global/node_modules/frely-cli/dist/index.js", "darwin"), "bun remove -g frely-cli");
  assert.equal(removalCommand("/opt/other/frely", "linux"), "rm '/opt/other/frely'");
  assert.equal(removalCommand("/opt/other/run.sh", "linux"), null);
  const [note] = otherInstallNotes([{ path: nvm, version: "0.23.38", unsafeRefresh: false }], "darwin");
  assert.match(note!, /Remove it with: '\/Users\/w\/\.nvm\/versions\/node\/v24\.14\.1\/bin\/npm' uninstall -g/u);
  assert.doesNotMatch(note!, /frely self uninstall/u);
  assert.equal(removalCommand("C:\\Users\\w\\AppData\\Roaming\\npm\\node_modules\\frely-cli\\dist\\index.js", "win32"), 'npm uninstall -g --prefix "C:\\Users\\w\\AppData\\Roaming\\npm" frely-cli');
  assert.equal(removalCommand("C:\\tools\\frely.exe", "win32"), 'del "C:\\tools\\frely.exe"');
});
