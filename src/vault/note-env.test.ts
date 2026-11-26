import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hideSecrets, vaultEnvFor } from "./note-env.js";
import { ProcessManager } from "../runtime/process-manager.js";
import { safeEnv, Workspace } from "../runtime/workspace.js";

const NOTE = { CF_ACCESS_CLIENT_ID: "client-id.access", CF_ACCESS_CLIENT_SECRET: "secret-VALUE-12345", SHORT: "on" };
const read = async (name: string) => { assert.equal(name, "zen-quant webhook"); return { ...NOTE }; };

test("vaultEnvFor: only process run/start may name a note, never a hosted Agent; short values are not hidden", async () => {
  assert.equal(await vaultEnvFor("process", { action: "run", command: "x" }, undefined, read), undefined);
  const got = await vaultEnvFor("process", { action: "run", command: "x", vaultItem: " zen-quant webhook " }, undefined, read);
  assert.deepEqual(got, { env: NOTE, secrets: ["secret-VALUE-12345", "client-id.access"] });
  assert.ok(await vaultEnvFor("start_process", { command: "x", vaultItem: "zen-quant webhook" }, {}, read));
  for (const args of [{ action: "read", vaultItem: "n" }, { action: "list", vaultItem: "n" }]) await assert.rejects(vaultEnvFor("process", args, undefined, read), /only with process action run or start/u);
  await assert.rejects(vaultEnvFor("read_file", { vaultItem: "n" }, undefined, read), /only with process/u);
  for (const vaultItem of ["", " ", 3, "a\nb", "x".repeat(101)]) await assert.rejects(vaultEnvFor("process", { action: "run", vaultItem }, undefined, read), /name of a secure note/u);
  let reads = 0;
  await assert.rejects(vaultEnvFor("process", { action: "run", vaultItem: "zen-quant webhook" }, { "frely/origin": "hosted-agent" }, async () => { reads += 1; return {}; }), /not available to Agents/u);
  assert.equal(reads, 0);
});

test("hideSecrets replaces every value in every string of a result, longest first", () => {
  assert.deepEqual(hideSecrets({ stdout: "id=client-id.access\nsecret=secret-VALUE-12345", nested: [{ stderr: "x secret-VALUE-12345" }], code: 0 }, ["secret-VALUE-12345", "client-id.access"]),
    { stdout: "id=***\nsecret=***", nested: [{ stderr: "x ***" }], code: 0 });
  assert.equal(hideSecrets("abcd abcdef", ["abcdef", "abcd"]), "*** ***");
  assert.equal(hideSecrets("same", []), "same");
});

test("a command gets the note's fields as environment variables, and its output has their values hidden", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-note-env-"));
  try {
    const workspace = await Workspace.open(root);
    const vault = (await vaultEnvFor("process", { action: "run", vaultItem: "zen-quant webhook" }, undefined, read))!;
    const out = await workspace.runCommand(`node -e "console.log(process.env.CF_ACCESS_CLIENT_SECRET.length, process.env.CF_ACCESS_CLIENT_SECRET)"`, ".", 10_000, undefined, [], vault.env);
    assert.equal(out.stdout.trim(), "18 secret-VALUE-12345");
    assert.equal(hideSecrets(out, vault.secrets).stdout.trim(), "18 ***");
    const plain = await workspace.runCommand(`node -e "console.log(String(process.env.CF_ACCESS_CLIENT_SECRET))"`, ".", 10_000);
    assert.equal(plain.stdout.trim(), "undefined");

    const manager = new ProcessManager();
    const started = await manager.start(`node -e "console.log(process.env.CF_ACCESS_CLIENT_ID)"`, root, { ...safeEnv(), ...vault.env }, root, [], vault.secrets);
    let read1 = manager.read(started.id);
    for (let i = 0; i < 80 && !read1.stdout.includes("***"); i += 1) { await new Promise((resolve) => setTimeout(resolve, 25)); read1 = manager.read(started.id); }
    assert.equal(read1.stdout.trim(), "***");
    await manager.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
