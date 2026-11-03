import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installGithubItem, type GithubFetch } from "./github-item.js";
import { CloudItemError } from "./cloud-item.js";

const SHA = "a".repeat(40);
const base = { login: "Foo", repo: "bar.skill", commitSha: SHA, license: "MIT", hasScripts: true };

function fake(blobs: Record<string, string>, over: { mode?: Record<string, string>; type?: Record<string, string>; sizes?: Record<string, number>; truncated?: boolean } = {}) {
  const calls: string[] = [];
  const fetcher: GithubFetch = async (url) => {
    calls.push(url);
    if (url === `https://api.github.com/repos/Foo/bar.skill/git/trees/${SHA}?recursive=1`) {
      return new Response(JSON.stringify({ truncated: over.truncated ?? false, tree: Object.entries(blobs).map(([path, body]) => ({ path, type: over.type?.[path] ?? "blob", mode: over.mode?.[path] ?? "100644", size: over.sizes?.[path] ?? body.length })) }));
    }
    const raw = `https://raw.githubusercontent.com/Foo/bar.skill/${SHA}/`;
    if (url.startsWith(raw)) { const body = blobs[decodeURIComponent(url.slice(raw.length))]; return body === undefined ? new Response("", { status: 404 }) : new Response(body); }
    return new Response("", { status: 404 });
  };
  return { fetcher, calls };
}

test("installs the pinned commit without execute permission and reports it as unscanned", async () => {
  const home = await mkdtemp(join(tmpdir(), "frely-gh-"));
  const { fetcher, calls } = fake({ "SKILL.md": "---\nname: x\n---", "scripts/run.sh": "echo hi", ".github/ci.yml": "no", "link": "../x" }, { mode: { link: "120000" } });
  const result = await installGithubItem({ ...base, home, cwd: home, fetch: fetcher });
  assert.equal(result.needsReview, true);
  assert.equal(result.commit, SHA);
  assert.equal(result.files, 2);
  assert.equal((await readFile(join(result.path, "scripts/run.sh"), "utf8")), "echo hi");
  assert.equal(((await stat(join(result.path, "scripts/run.sh"))).mode & 0o111), 0);
  assert.ok(calls.every((url) => url.startsWith("https://api.github.com/") || url.startsWith("https://raw.githubusercontent.com/")));
  assert.ok(calls.filter((url) => url.startsWith("https://raw.")).every((url) => url.includes(`/${SHA}/`)));
});

test("refuses a repository without SKILL.md, a truncated or oversized listing, and an unsafe path, before downloading", async () => {
  const home = await mkdtemp(join(tmpdir(), "frely-gh-"));
  const cases: Array<ReturnType<typeof fake>> = [
    fake({ "readme.md": "x" }),
    fake({ "SKILL.md": "x" }, { truncated: true }),
    fake({ "SKILL.md": "x", "big.bin": "x" }, { sizes: { "big.bin": 9 * 1024 * 1024 } }),
    fake({ "SKILL.md": "x", "../escape": "x" }),
  ];
  for (const { fetcher, calls } of cases) {
    await assert.rejects(installGithubItem({ ...base, home, cwd: home, fetch: fetcher }), (error: unknown) => error instanceof CloudItemError);
    assert.equal(calls.some((url) => url.startsWith("https://raw.")), false);
  }
});

test("refuses a commit id or names that are not what Frely would return", async () => {
  await assert.rejects(installGithubItem({ ...base, commitSha: "main" }), CloudItemError);
  await assert.rejects(installGithubItem({ ...base, login: "../x" }), CloudItemError);
});

test("a repository GitHub no longer has gives a clear error", async () => {
  const home = await mkdtemp(join(tmpdir(), "frely-gh-"));
  await assert.rejects(installGithubItem({ ...base, home, cwd: home, fetch: async () => new Response("", { status: 404 }) }), /deleted or made private/u);
});
