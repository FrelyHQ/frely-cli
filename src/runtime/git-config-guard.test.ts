import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedProgramKeys, findGitConfigs, GitConfigGuard, guardNote, listConfigEntries, runsPrograms } from "./git-config-guard.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
const workspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), "frely-guard-"));
  git(root, "init", "-q");
  return root;
};

test("every key that makes git run a program is recognised, and ordinary keys are not", () => {
  const dangerous: [string, string][] = [
    ["core.fsmonitor", "/tmp/x"], ["core.sshcommand", "ssh -o X"], ["core.hookspath", "/tmp/hooks"], ["core.pager", "sh -c x"], ["core.editor", "vim"], ["core.askpass", "/tmp/a"],
    ["credential.helper", "store"], ["credential.https://github.com.helper", "!x"], ["filter.lfs.clean", "x"], ["filter.lfs.smudge", "x"], ["filter.lfs.process", "x"],
    ["diff.word.textconv", "x"], ["diff.word.command", "x"], ["merge.ours.driver", "x"], ["gpg.program", "x"], ["gpg.ssh.program", "x"], ["include.path", "../x"],
    ["includeif.gitdir:/a/.path", "../x"], ["uploadpack.packobjectshook", "x"], ["receivepack.anything", "x"], ["remote.origin.uploadpack", "x"], ["remote.origin.receivepack", "x"],
    ["sequence.editor", "x"], ["alias.st", "!sh -c x"], ["Core.FsMonitor", "x"], ["core.gitproxy", "x"], ["init.templatedir", "/tmp/t"],
  ];
  for (const [key, value] of dangerous) assert.equal(runsPrograms(key, value), true, key);
  const ordinary: [string, string][] = [
    ["user.name", "A"], ["user.email", "a@b.c"], ["remote.origin.url", "git@github.com:a/b.git"], ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
    ["branch.main.remote", "origin"], ["branch.main.merge", "refs/heads/main"], ["core.bare", "false"], ["core.filemode", "true"], ["alias.st", "status -sb"],
    ["credential.username", "me"], ["submodule.lib.url", "https://x/y"], ["submodule.lib.update", "checkout"], ["diff.word.binary", "true"], ["pull.rebase", "true"],
  ];
  for (const [key, value] of ordinary) assert.equal(runsPrograms(key, value), false, key);
});

test("only keys the command added or changed are reported; an unchanged existing helper is left alone", () => {
  const before = [{ key: "credential.helper", value: "osxkeychain" }, { key: "user.name", value: "A" }];
  assert.deepEqual(addedProgramKeys(before, before), []);
  assert.deepEqual(addedProgramKeys(before, [...before, { key: "credential.helper", value: "!evil" }]), ["credential.helper"]);
  assert.deepEqual(addedProgramKeys(before, [{ key: "credential.helper", value: "!evil" }, { key: "user.name", value: "A" }]), ["credential.helper"]);
  assert.deepEqual(addedProgramKeys([], [{ key: "core.fsmonitor", value: "x" }, { key: "core.fsmonitor", value: "y" }]), ["core.fsmonitor"]);
});

test("the guard keeps ordinary config changes and removes program-running keys the command added", async () => {
  const root = workspace();
  try {
    git(root, "config", "user.name", "Before");
    const guard = await GitConfigGuard.snapshot(root);
    git(root, "remote", "add", "origin", "git@github.com:a/b.git");
    git(root, "config", "branch.main.remote", "origin");
    git(root, "config", "core.fsmonitor", "/tmp/evil");
    git(root, "config", "core.sshCommand", "sh -c evil");
    git(root, "config", "alias.pwn", "!sh -c evil");
    git(root, "config", "alias.st", "status -sb");
    git(root, "config", "credential.https://example.com.helper", "!evil");
    git(root, "config", "filter.x.smudge", "evil");
    git(root, "config", "include.path", "../evil.cfg");
    const result = await guard.restore();
    assert.deepEqual(result.removed.map((item) => item.key).sort(), ["alias.pwn", "core.fsmonitor", "core.sshcommand", "credential.https://example.com.helper", "filter.x.smudge", "include.path"]);
    const keys = (await listConfigEntries(join(root, ".git", "config"))).map((entry) => entry.key);
    for (const kept of ["user.name", "remote.origin.url", "branch.main.remote", "alias.st"]) assert.ok(keys.includes(kept), kept);
    for (const gone of ["core.fsmonitor", "core.sshcommand", "alias.pwn", "filter.x.smudge", "include.path"]) assert.ok(!keys.includes(gone), gone);
    const note = guardNote(result) ?? "";
    assert.match(note, /core\.fsmonitor/u);
    assert.match(note, /alias\.pwn/u);
    assert.doesNotMatch(note, /evil/u, "values are never echoed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed existing helper goes back to its old value; comments and formatting survive", async () => {
  const root = workspace();
  try {
    const file = join(root, ".git", "config");
    writeFileSync(file, `${readFileSync(file, "utf8")}# keep this comment\n[credential]\n\thelper = osxkeychain\n[user]\n\tname   =   Spaced\n`);
    const guard = await GitConfigGuard.snapshot(root);
    git(root, "config", "--replace-all", "credential.helper", "!evil");
    git(root, "config", "--add", "credential.helper", "!also-evil");
    git(root, "config", "user.email", "new@example.com");
    const result = await guard.restore();
    assert.deepEqual(result.removed.map((item) => item.key), ["credential.helper"]);
    const entries = await listConfigEntries(file);
    assert.deepEqual(entries.filter((entry) => entry.key === "credential.helper").map((entry) => entry.value), ["osxkeychain"]);
    assert.ok(entries.some((entry) => entry.key === "user.email" && entry.value === "new@example.com"));
    const text = readFileSync(file, "utf8");
    assert.match(text, /# keep this comment/u);
    assert.match(text, /name   =   Spaced/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a command that changes nothing leaves the file and the result untouched", async () => {
  const root = workspace();
  try {
    const file = join(root, ".git", "config");
    const before = readFileSync(file, "utf8");
    const guard = await GitConfigGuard.snapshot(root);
    const result = await guard.restore();
    assert.deepEqual(result, { removed: [], restored: [], unreadable: [] });
    assert.equal(guardNote(result), undefined);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested repositories and repositories created by the command are checked too", async () => {
  const root = workspace();
  try {
    mkdirSync(join(root, "libs", "sub"), { recursive: true });
    git(join(root, "libs", "sub"), "init", "-q");
    const guard = await GitConfigGuard.snapshot(root);
    git(join(root, "libs", "sub"), "config", "core.pager", "evil");
    mkdirSync(join(root, "fresh"));
    git(join(root, "fresh"), "init", "-q");
    git(join(root, "fresh"), "config", "core.hooksPath", "/tmp/h");
    git(join(root, "fresh"), "config", "user.name", "ok");
    const result = await guard.restore();
    assert.deepEqual(result.removed.map((item) => `${item.file}:${item.key}`).sort(), [join("fresh", ".git", "config") + ":core.hookspath", join("libs", "sub", ".git", "config") + ":core.pager"]);
    assert.ok((await listConfigEntries(join(root, "fresh", ".git", "config"))).some((entry) => entry.key === "user.name"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a config git cannot parse any more is restored byte for byte", async () => {
  const root = workspace();
  try {
    const file = join(root, ".git", "config");
    const before = readFileSync(file, "utf8");
    const guard = await GitConfigGuard.snapshot(root);
    writeFileSync(file, "[core\n\tfsmonitor = evil\n");
    const result = await guard.restore();
    assert.deepEqual(result.restored, [join(".git", "config")]);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.match(guardNote(result) ?? "", /restored/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository scanning skips node_modules, links to worktrees and deep trees", async () => {
  const root = workspace();
  try {
    mkdirSync(join(root, "node_modules", "pkg", ".git"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", ".git", "config"), "");
    mkdirSync(join(root, "a", "b", "c", "d", ".git"), { recursive: true });
    mkdirSync(join(root, "wt"));
    writeFileSync(join(root, "wt", ".git"), "gitdir: /elsewhere\n");
    assert.deepEqual(await findGitConfigs(root), [join(root, ".git", "config")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
