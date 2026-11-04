import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPendingUpdate, isFileInUse, pendingVersion, stagePendingUpdate } from "./windows-pending.js";

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "frely-pending-"));
  const entry = join(directory, "frely.exe"), marker = join(directory, "update-pending");
  await writeFile(entry, "old");
  const verified = join(directory, "verified"); await writeFile(verified, "new");
  const installation = { method: "standalone", entry, platform: "win32" } as never;
  return { directory, entry, marker, verified, installation };
}
const exists = (path: string) => stat(path).then(() => true, () => false);

test("a blocked swap is staged and finished at the next start, after the staged file verifies", async () => {
  const { entry, marker, verified, installation } = await setup();
  await stagePendingUpdate(installation, "2.0.0", verified, marker);
  assert.equal(await pendingVersion(marker), "2.0.0");
  assert.equal(await applyPendingUpdate(installation, marker, async () => "2.0.0"), "2.0.0");
  assert.equal(await readFile(entry, "utf8"), "new");
  assert.equal(await exists(marker), false);
});

test("a staged file that was changed or reports another version is discarded and the installation stays", async () => {
  const { entry, marker, verified, installation } = await setup();
  await stagePendingUpdate(installation, "2.0.0", verified, marker);
  assert.equal(await applyPendingUpdate(installation, marker, async () => "9.9.9"), null);
  assert.equal(await readFile(entry, "utf8"), "old");
  await stagePendingUpdate(installation, "2.0.0", verified, marker);
  await writeFile(`${entry}.new`, "tampered");
  assert.equal(await applyPendingUpdate(installation, marker, async () => "2.0.0"), null);
  assert.equal(await readFile(entry, "utf8"), "old");
  assert.equal(await exists(marker), false);
});

test("nothing happens off Windows or without a marker; only file-in-use errors count as blocked", async () => {
  const { marker, installation } = await setup();
  assert.equal(await applyPendingUpdate(installation, marker), null);
  assert.equal(await applyPendingUpdate({ method: "standalone", entry: "/x/frely", platform: "linux" } as never, marker), null);
  for (const code of ["EPERM", "EBUSY", "EACCES"]) assert.equal(isFileInUse(Object.assign(new Error("x"), { code })), true);
  assert.equal(isFileInUse(Object.assign(new Error("x"), { code: "ENOENT" })), false);
  assert.equal(createHash("sha256").update("a").digest("hex").length, 64);
});
