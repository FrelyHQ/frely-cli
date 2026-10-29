import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { limitBytes, localDenyReason, READ_TOOLS, TOOL_OUTPUT_LIMIT_BYTES, WorkspaceReadBridge } from "./workspace-read.js";

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "frely-read-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "main.ts"), "export const a = 1;\nexport const b = 2;\n");
  await writeFile(join(root, "README.md"), "# demo\n");
  await writeFile(join(root, ".env"), "SECRET=1\n");
  await writeFile(join(root, ".env.local"), "SECRET=2\n");
  await writeFile(join(root, "server.pem"), "-----BEGIN-----\n");
  await writeFile(join(root, "id_rsa"), "key\n");
  await writeFile(join(root, ".npmrc"), "//registry:_authToken=x\n");
  await writeFile(join(root, ".gitignore"), "ignored.txt\nbuild/\n");
  await writeFile(join(root, "ignored.txt"), "ignored SECRET\n");
  await mkdir(join(root, "build"));
  await writeFile(join(root, "build", "out.js"), "built\n");
  await writeFile(join(root, "logo.bin"), Buffer.from([0x89, 0x50, 0, 0, 1, 2]));
  return root;
}

const call = (name: string, args: Record<string, unknown>, callId = "c1") => ({ callId, name, arguments: JSON.stringify(args) });

test("local policy refuses git internals, env files, key material and package credentials", () => {
  for (const path of [".git/config", "a/.git/HEAD", ".env", ".env.production", "x/.ENV", "k.pem", "a/b/tls.key", "c.p12", "id_ed25519", ".npmrc", "d/.netrc", ".pypirc"]) {
    assert.notEqual(localDenyReason(path), null, path);
  }
  for (const path of ["src/main.ts", "README.md", "environment.ts", "docs/keys.md", "monkey.keyboard"]) assert.equal(localDenyReason(path), null, path);
});

test("tools match the FrelyMCP workspace tool names", () => {
  assert.deepEqual(READ_TOOLS.map((tool) => tool.name), ["workspace_info", "list_directory", "find_files", "search_files", "read_file", "read_file_lines", "stat_path"]);
});

test("reads allowed files and records them", async () => {
  const root = await repo();
  try {
    const bridge = await WorkspaceReadBridge.open(root);
    const logged: string[] = [];
    const [full, lines] = await bridge.answerRound([call("read_file", { path: "src/main.ts" }), call("read_file_lines", { path: "src/main.ts", startLine: 2, endLine: 2 }, "c2")], (path) => logged.push(path));
    assert.equal(full!.output, "export const a = 1;\nexport const b = 2;\n");
    assert.equal(lines!.output, "export const b = 2;");
    assert.deepEqual(logged, ["src/main.ts"]);
    assert.deepEqual(bridge.filesRead().map((file) => file.path), ["src/main.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses .env, keys, git-ignored files, binaries and symlinks without failing the round", async () => {
  const root = await repo();
  try {
    await symlink("/etc/hostname", join(root, "link.txt"));
    const bridge = await WorkspaceReadBridge.open(root);
    const names = [".env", ".env.local", "server.pem", "id_rsa", ".npmrc", "ignored.txt", "build/out.js", ".git/config", "logo.bin"];
    const outputs = await bridge.answerRound(names.map((path, index) => call("read_file", { path }, `c${index}`)));
    for (const [index, output] of outputs.entries()) assert.match(output.output, /denied by local policy/u, names[index]);
    const [symlinkResult, escape] = await bridge.answerRound([call("read_file", { path: "link.txt" }), call("read_file", { path: "../outside" }, "c2")]);
    assert.match(symlinkResult!.output, /^error:/u);
    assert.match(escape!.output, /^error:/u);
    assert.doesNotMatch(escape!.output, new RegExp(root.replaceAll("\\", "\\\\"), "u"));
    assert.deepEqual(bridge.filesRead(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listings, file search and content search leave out denied and ignored files", async () => {
  const root = await repo();
  try {
    const bridge = await WorkspaceReadBridge.open(root);
    const [list, find, search] = await bridge.answerRound([
      call("list_directory", {}),
      call("find_files", { pattern: "*" }, "c2"),
      call("search_files", { query: "SECRET" }, "c3"),
    ]);
    const listed = (JSON.parse(list!.output) as { name: string }[]).map((entry) => entry.name);
    assert.ok(listed.includes("src") && listed.includes("README.md"));
    for (const hidden of [".git", ".env", ".env.local", "server.pem", "id_rsa", ".npmrc", "ignored.txt", "build"]) assert.ok(!listed.includes(hidden), hidden);
    const found = JSON.parse(find!.output) as string[];
    assert.ok(found.includes("src/main.ts"));
    for (const hidden of [".env", "server.pem", "ignored.txt", "build/out.js"]) assert.ok(!found.includes(hidden), hidden);
    assert.deepEqual(JSON.parse(search!.output), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overview lists readable files only", async () => {
  const root = await repo();
  try {
    const bridge = await WorkspaceReadBridge.open(root);
    const lines = (await bridge.overview()).split("\n");
    assert.ok(lines.includes("src/main.ts") && lines.includes("README.md"));
    for (const hidden of [".env", "server.pem", "ignored.txt", "build/out.js", ".npmrc"]) assert.ok(!lines.includes(hidden), hidden);
    assert.ok((await bridge.overview(20)).includes("more files"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one result is cut at 64 KiB and the total budget ends reading", async () => {
  const root = await repo();
  try {
    await writeFile(join(root, "big.txt"), "x".repeat(200 * 1024));
    const bridge = await WorkspaceReadBridge.open(root, { totalBytes: 100 * 1024, maxRounds: 16 });
    const [big] = await bridge.answerRound([call("read_file", { path: "big.txt" })]);
    assert.ok(Buffer.byteLength(big!.output) <= TOOL_OUTPUT_LIMIT_BYTES);
    assert.match(big!.output, /truncated/u);
    const [second] = await bridge.answerRound([call("read_file", { path: "big.txt" })]);
    assert.ok(Buffer.byteLength(second!.output) <= 100 * 1024 - TOOL_OUTPUT_LIMIT_BYTES + 1);
    const [spent] = await bridge.answerRound([call("read_file", { path: "README.md" })]);
    assert.match(spent!.output, /budget exhausted/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rounds beyond the limit get budget exhausted instead of file content", async () => {
  const root = await repo();
  try {
    const bridge = await WorkspaceReadBridge.open(root, { totalBytes: 1024 * 1024, maxRounds: 2 });
    assert.equal((await bridge.answerRound([call("read_file", { path: "README.md" })]))[0]!.output, "# demo\n");
    await bridge.answerRound([call("read_file", { path: "README.md" })]);
    assert.equal(bridge.roundBudgetSpent, true);
    assert.match((await bridge.answerRound([call("read_file", { path: "README.md" })]))[0]!.output, /budget exhausted/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a directory that is not a git repository still works", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-read-plain-"));
  try {
    await writeFile(join(root, "a.txt"), "hello");
    await writeFile(join(root, ".env"), "x");
    const bridge = await WorkspaceReadBridge.open(root);
    assert.equal((await bridge.answerRound([call("read_file", { path: "a.txt" })]))[0]!.output, "hello");
    assert.match((await bridge.answerRound([call("read_file", { path: ".env" })]))[0]!.output, /denied/u);
    assert.ok((await bridge.overview()).includes("a.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("limitBytes keeps multibyte text valid", () => {
  const cut = limitBytes("中".repeat(100), 100);
  assert.ok(Buffer.byteLength(cut) <= 100);
  assert.ok(!cut.includes("�"));
});
