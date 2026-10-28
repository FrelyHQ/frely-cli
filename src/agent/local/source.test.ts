import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { download, parseSource, resolveRegisteredRepo, SourceError } from "./source.js";

test("a target is a Frely Agent name or a public GitHub address", () => {
  assert.deepEqual(parseSource("alice/helper"), { kind: "frely", user: "alice", name: "helper" });
  assert.deepEqual(parseSource("@alice/helper"), { kind: "frely", user: "alice", name: "helper" });
  assert.deepEqual(parseSource("https://github.com/owner/repo"), { kind: "github", owner: "owner", repo: "repo" });
  assert.deepEqual(parseSource("https://github.com/owner/repo.git/"), { kind: "github", owner: "owner", repo: "repo" });
  for (const bad of ["", "alice", "a/b/c", "http://github.com/o/r", "https://gitlab.com/o/r", "git@github.com:o/r.git", "https://github.com/o/r/tree/main", "../x/y", "alice/ha lper"]) {
    assert.throws(() => parseSource(bad), SourceError, bad);
  }
});

test("the registered repository comes from the Frely page and only GitHub addresses are accepted", async () => {
  const calls: string[] = [];
  const answer = (status: number, body: unknown): typeof fetch => (async (url) => { calls.push(String(url)); return new Response(JSON.stringify(body), { status }); }) as typeof fetch;
  const commit = "a".repeat(40);
  assert.deepEqual(await resolveRegisteredRepo("alice", "helper", "https://frely.cloud", answer(200, { repoUrl: "https://github.com/alice/helper.git", commit, name: "Helper" })), { repoUrl: "https://github.com/alice/helper", commit, name: "Helper" });
  assert.deepEqual(calls, ["https://frely.cloud/api/public/agent-repos/alice/helper"]);
  assert.equal((await resolveRegisteredRepo("alice", "helper", "https://frely.cloud", answer(200, { repoUrl: "https://github.com/alice/helper", commit: "main" }))).commit, undefined);
  await assert.rejects(resolveRegisteredRepo("alice", "helper", "https://frely.cloud", answer(404, {})), /not a Frely Agent with a repository/u);
  await assert.rejects(resolveRegisteredRepo("alice", "helper", "https://frely.cloud", answer(200, { repoUrl: "https://evil.example/alice/helper" })), /no usable repository/u);
  await assert.rejects(resolveRegisteredRepo("alice", "helper", "https://frely.cloud", answer(500, {})), /HTTP 500/u);
});

test("download refuses any remote that is not https, even a local path", { skip: process.platform === "win32" }, async () => {
  const origin = mkdtempSync(join(tmpdir(), "frely-origin-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", ...args], { cwd: origin, encoding: "utf8" }).trim();
  git("init", "--quiet", "-b", "main");
  writeFileSync(join(origin, "frely.yaml"), "local:\n  run: x\n");
  git("add", "."); git("commit", "--quiet", "-m", "one");
  const target = join(mkdtempSync(join(tmpdir(), "frely-dl-")), "agent");
  await assert.rejects(download(origin, target, undefined), /git clone failed/u);
  await assert.rejects(download(origin, target, git("rev-parse", "HEAD")), /git fetch failed/u);
  assert.equal(existsSync(join(target, "frely.yaml")), false);
});
