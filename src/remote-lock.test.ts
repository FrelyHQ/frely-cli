import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { remoteLocked, remoteState, setRemoteLock } from "./remote-lock.js";

test("the local lock is the one thing that makes the remote state false", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frely-remote-lock-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = directory;
  t.after(async () => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; await rm(directory, { recursive: true, force: true }); });
  assert.equal(await remoteLocked(), false);
  await setRemoteLock(true);
  assert.equal(await remoteLocked(), true);
  await setRemoteLock(false);
  assert.equal(await remoteLocked(), false);
});

test("remote state: locked is false even with an active authorization; no authorization is null", () => {
  assert.equal(remoteState({ locked: true, authorized: true }), "false");
  assert.equal(remoteState({ locked: false, authorized: true }), "true");
  assert.equal(remoteState({ locked: false, authorized: false }), "null");
  assert.equal(remoteState({ locked: true, authorized: false }), "false");
});
