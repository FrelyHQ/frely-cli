import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Workspace } from "./workspace.js";

async function homeWorkspace(grants: string[] = []) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-cli-home-")));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  await mkdir(join(home, ".ssh"), { recursive: true });
  await mkdir(join(home, ".config/frely"), { recursive: true });
  await mkdir(join(home, "project"), { recursive: true });
  await writeFile(join(home, ".ssh/id_ed25519"), "PRIVATE");
  await writeFile(join(home, ".config/frely/device.json"), "TOKEN");
  await writeFile(join(home, ".zshrc"), "# rc\n");
  await writeFile(join(home, "project/notes.txt"), "needle\n");
  return { home, workspace: (await Workspace.open(home)).withGrants(grants) };
}

test("a home-directory workspace cannot read credential stores through file tools", async () => {
  const { home, workspace } = await homeWorkspace();
  await assert.rejects(() => workspace.readFile(".ssh/id_ed25519"), /protected/);
  await assert.rejects(() => workspace.listDirectory(".ssh"), /protected/);
  await assert.rejects(() => workspace.readFile(".config/frely/device.json"), /protected/);
  assert.equal(await workspace.readFile("project/notes.txt"), "needle\n");
  const found = await workspace.findFiles(".", "*", 50);
  assert.ok(!found.some((path) => path.startsWith(".ssh/") || path.startsWith(".config/frely/")));
  const hits = await workspace.searchFiles(".", "PRIVATE", { regex: false, caseSensitive: true, maxResults: 10, contextLines: 0 });
  assert.equal(JSON.stringify(hits).includes("PRIVATE"), false);
  assert.ok(home);
});

test("a symlinked directory inside the workspace cannot reach a credential store", async () => {
  const { home, workspace } = await homeWorkspace();
  await symlink(join(home, ".ssh"), join(home, "project/link"));
  await assert.rejects(() => workspace.readFile("project/link/id_ed25519"), /protected|Symbolic/);
  await assert.rejects(() => workspace.writeFile("project/link/new", "x", false), /protected|escapes/);
});

test("shell start-up files and credential stores cannot be written", async () => {
  const { home, workspace } = await homeWorkspace();
  await assert.rejects(() => workspace.writeFile(".zshrc", "evil", true), /protected/);
  await assert.rejects(() => workspace.writeFile(".ssh/authorized_keys", "key", false), /protected/);
  await assert.rejects(() => workspace.deletePath(".zshrc", false), /protected/);
  await assert.rejects(() => workspace.movePath("project/notes.txt", ".zshrc", true), /protected/);
  assert.equal(await readFile(join(home, ".zshrc"), "utf8"), "# rc\n");
});

test("an approved group opens reads only; Frely's own credentials stay closed", async () => {
  const { workspace, home } = await homeWorkspace(["ssh"]);
  assert.equal(await workspace.readFile(".ssh/id_ed25519"), "PRIVATE");
  await assert.rejects(() => workspace.writeFile(".ssh/authorized_keys", "key", false), /protected/);
  await assert.rejects(() => workspace.readFile(".config/frely/device.json"), /protected/);
  assert.ok(home);
});
