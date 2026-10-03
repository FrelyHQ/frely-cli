import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudItemError, CloudToolError, installCloudItem, remoteMcpConnection, type CloudToolCaller } from "./cloud-item.js";

const skillId = "cloud_skill_0123456789abcdef01234567";
const b64 = (text: string) => Buffer.from(text).toString("base64");

function caller(options: { kind?: "prompt" | "skill"; premium?: "ok" | "pass" | "none"; paths?: string[] } = {}): CloudToolCaller {
  const kind = options.kind ?? "skill";
  const premium = options.premium ?? "none";
  return async (name, input) => {
    assert.equal(name, "skills.install");
    const manifest = { id: skillId, kind, slug: "review", displayName: "Review", version: 2, hasScripts: true, premium: { fileCount: premium === "none" ? 0 : 1, totalBytes: 4 } };
    if (input.part === "premium") {
      if (premium === "pass") throw new CloudToolError("creator_pass_required");
      return { manifest, files: [{ path: kind === "prompt" ? "PREMIUM.md" : "premium/extra.md", contentBase64: b64("paid"), isScript: false }] };
    }
    const paths = options.paths ?? (kind === "prompt" ? ["PROMPT.md"] : ["SKILL.md", "scripts/run.sh"]);
    return { manifest, files: paths.map((path) => ({ path, contentBase64: b64(`content of ${path}`), isScript: path.endsWith(".sh") })) };
  };
}

test("installs a Skill with its paid part into the host Skill folder without execute permission", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-item-")));
  try {
    const result = await installCloudItem({ skillId, call: caller({ premium: "ok" }), host: "claude-code", scope: "global", home });
    assert.equal(result.path, join(home, ".claude", "skills", "frely-review-01234567"));
    assert.equal(result.premium, "installed");
    assert.equal(result.files, 3);
    assert.equal(await readFile(join(result.path, "premium", "extra.md"), "utf8"), "paid");
    assert.equal((await stat(join(result.path, "scripts", "run.sh"))).mode & 0o111, 0);
    const again = await installCloudItem({ skillId, call: caller({ premium: "ok" }), host: "claude-code", scope: "global", home });
    assert.equal(again.path, result.path);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("installs the free part of a Prompt and reports a missing pass", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "frely-item-")));
  try {
    const result = await installCloudItem({ skillId, call: caller({ kind: "prompt", premium: "pass" }), cwd });
    assert.equal(result.premium, "pass_required");
    assert.equal(await readFile(join(cwd, "frely-review-01234567", "PROMPT.md"), "utf8"), "content of PROMPT.md");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("refuses unsafe paths, unmanaged folders and edited files", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-item-")));
  try {
    await assert.rejects(installCloudItem({ skillId, call: caller({ paths: ["../escape.md"] }), home }), (error: unknown) => error instanceof CloudItemError && error.code === "item_invalid");
    await assert.rejects(installCloudItem({ skillId, call: caller({ paths: ["C:/escape.md"] }), home }), (error: unknown) => error instanceof CloudItemError && error.code === "item_invalid");
    await assert.rejects(installCloudItem({ skillId: "../x", call: caller(), home }), (error: unknown) => error instanceof CloudItemError && error.code === "input_invalid");
    const result = await installCloudItem({ skillId, call: caller(), home });
    await writeFile(join(result.path, "SKILL.md"), "edited");
    await assert.rejects(installCloudItem({ skillId, call: caller(), home }), (error: unknown) => error instanceof CloudItemError && error.code === "managed_item_modified");
    await rm(join(result.path, ".frely-managed.json"));
    await assert.rejects(installCloudItem({ skillId, call: caller(), home }), (error: unknown) => error instanceof CloudItemError && error.code === "unmanaged_item_exists");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("remote MCP connection references the API key only by environment variable", () => {
  const value = remoteMcpConnection("remote_mcp_0123456789abcdef01234567", "claude-code");
  assert.equal(value.mcpUrl, "https://api.frely.cloud/mcp/remote/remote_mcp_0123456789abcdef01234567");
  assert.match(value.command ?? "", /\$FRELY_API_KEY/u);
  assert.throws(() => remoteMcpConnection("remote_mcp_bad"), CloudItemError);
  assert.throws(() => remoteMcpConnection("remote_mcp_0123456789abcdef01234567", "generic", "http://example.com"), CloudItemError);
});
