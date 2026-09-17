// Maintenance evidence: real isolated Git refs, no network, registry or host access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArguments, selectTag } from "./release-entry.mjs";
import { catalog } from "./release-catalog.mjs";
const scripts = dirname(fileURLToPath(import.meta.url));

function fixture(t, packageVersion = "1.2.3") {
  const temp = mkdtempSync(join(tmpdir(), "frely-release-entry-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, "repo"), remote = join(temp, "origin.git");
  mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GITHUB_ACTIONS: "", GITHUB_OUTPUT: "", GITHUB_WORKFLOW_REF: "", GITHUB_EVENT_NAME: "", GITHUB_SHA: "" };
  const git = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore","pipe","pipe"] }).trim();
  git("init", "--bare", remote); git("init", "-b", "main");
  git("config", "user.name", "Release Test"); git("config", "user.email", "test@example.invalid");
  git("remote", "add", "origin", remote);
  mkdirSync(join(repo,"scripts"));
  for (const file of ["release-entry.mjs","release-catalog.mjs"]) cpSync(join(scripts,file),join(repo,"scripts",file));
  for (const artifact of catalog.artifacts) if (artifact.packagePath) {
    mkdirSync(dirname(join(repo,artifact.packagePath)),{recursive:true});
    writeFileSync(join(repo,artifact.packagePath), JSON.stringify({name:"release-test", version:packageVersion}));
  }
  git("add", "."); git("commit", "-m", "fixture"); git("push", "-u", "origin", "main");
  const sha = git("rev-parse","HEAD");
  const invoke = (args, overrides={}) => spawnSync(process.execPath, [join(repo,"scripts/release-entry.mjs"), ...args], {cwd:repo, env:{...env,...overrides}, encoding:"utf8"});
  const tag = catalog.artifacts[0].tagPrefix + "1.2.3";
  return {repo, remote, git, sha, tag, invoke};
}
test("commands reject artifact flags, duplicate options and tag identity overrides", () => {
  for (const args of [
    ["--artifact","landing"], ["--executor","actions","--executor","local"],
    ["--from-tag","v1.2.3","--version","1.2.4"], ["--validate-tag","v1.2.3","--dry-run"],
    ["--version","1.2.3+build"], ["--version","1.2.3-01"], ["--version","$(touch marker)"],
  ]) assert.throws(() => parseArguments(args));
});
test("every artifact has a tag route, and local release records cannot trigger it", () => {
  for (const artifact of catalog.artifacts) {
    assert.equal(selectTag(artifact.tagPrefix+"1.2.3").artifact.id,artifact.id);
    for (const prefix of artifact.localTagPrefixes || []) assert.throws(() => selectTag(prefix+"1.2.3"));
  }
  assert.throws(() => selectTag("deploy/unknown/v1.2.3"));
});
test("dry run leaves remote refs unchanged", t => {
  const f=fixture(t);
  // CLI's package command has its own established preparation; this fixture
  // exercises the generic tag command through an independent landing entry.
  const artifact=catalog.artifacts.find(a=>!a.packagePath) || catalog.artifacts[0];
  const driver=join(f.repo,"scripts","driver.mjs");
  writeFileSync(driver,'import {main} from "./release-entry.mjs"; main(process.argv.slice(2),'+JSON.stringify(artifact.id)+');\n');
  f.git("add","."); f.git("commit","-m","driver"); f.git("push","origin","main");
  const before=f.git("ls-remote","origin");
  const result=spawnSync(process.execPath,[driver,"--executor","actions","--version","1.2.3","--dry-run"],{cwd:f.repo,encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
  assert.equal(f.git("ls-remote","origin"),before);
});
test("accepts only the exact annotated main source and matching workflow", t => {
  const f=fixture(t);
  f.git("tag","-a",f.tag,"-m","release"); f.git("push","origin","refs/tags/"+f.tag);
  assert.equal(f.invoke(["--validate-tag",f.tag]).status,0);
  const invalid=f.invoke(["--validate-tag",f.tag],{GITHUB_ACTIONS:"true",GITHUB_WORKFLOW_REF:"owner/repo/.github/workflows/wrong.yml@refs/heads/main"});
  assert.notEqual(invalid.status,0);
  const valid=f.invoke(["--validate-tag",f.tag],{GITHUB_ACTIONS:"true",GITHUB_WORKFLOW_REF:"owner/repo/.github/workflows/"+catalog.artifacts[0].workflow+"@refs/heads/main"});
  assert.equal(valid.status,0,valid.stderr);
  writeFileSync(join(f.repo,"extra"),"changed");
  f.git("add","."); f.git("commit","-m","different source");
  assert.notEqual(f.invoke(["--validate-tag",f.tag]).status,0);
});
test("rejects lightweight and off-main tags", t => {
  const f=fixture(t);
  f.git("tag",f.tag); f.git("push","origin","refs/tags/"+f.tag);
  assert.notEqual(f.invoke(["--validate-tag",f.tag]).status,0);
  f.git("checkout","-b","feature");
  writeFileSync(join(f.repo,"feature"),"not on main");
  f.git("add","."); f.git("commit","-m","feature");
  const tag=catalog.artifacts[0].tagPrefix+"1.2.4";
  f.git("tag","-a",tag,"-m","release"); f.git("push","origin","refs/tags/"+tag);
  assert.notEqual(f.invoke(["--validate-tag",tag]).status,0);
});
test("rejects different remote annotated object even at the same commit", t => {
  const f=fixture(t);
  f.git("tag","-a",f.tag,"-m","remote"); f.git("push","origin","refs/tags/"+f.tag);
  f.git("tag","-d",f.tag); f.git("tag","-a",f.tag,"-m","local replacement");
  assert.notEqual(f.invoke(["--validate-tag",f.tag]).status,0);
});

test("independent commands publish only their selected tag and preserve source identity", t => {
  const f=fixture(t);
  const artifact=catalog.artifacts.find(a=>a.id!==catalog.defaultArtifact) || catalog.artifacts[0];
  const driver=join(f.repo,"scripts","driver.mjs");
  writeFileSync(driver,'import {main} from "./release-entry.mjs"; main(process.argv.slice(2),'+JSON.stringify(artifact.id)+');\n');
  f.git("add","."); f.git("commit","-m","entry driver");
  const source=f.git("rev-parse","HEAD");
  const result=spawnSync(process.execPath,[driver,"--executor","actions","--version","1.2.3"],{cwd:f.repo,encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
  const tag=artifact.tagPrefix+"1.2.3";
  assert.equal(f.git("tag","--list"),tag);
  assert.equal(f.git("cat-file","-t","refs/tags/"+tag),"tag");
  assert.equal(f.git("rev-parse",tag+"^{commit}"),source);
  assert.ok(f.git("ls-remote","origin","refs/tags/"+tag+"^{}").startsWith(source));
  assert.ok(f.git("ls-remote","origin","refs/heads/main").startsWith(source));
  const retry=spawnSync(process.execPath,[driver,"--executor","actions","--version","1.2.3"],{cwd:f.repo,encoding:"utf8"});
  assert.notEqual(retry.status,0);
  assert.equal(f.git("rev-parse",tag+"^{commit}"),source);
});

test("an existing version cannot be rebound to a different source through another entry", t => {
  const f=fixture(t);
  const artifact=catalog.artifacts.find(a=>(a.localTagPrefixes || []).length);
  if (!artifact) {
    // Package tag admission must fail when source metadata carries a different version.
    const tag=catalog.artifacts[0].tagPrefix+"1.2.4";
    f.git("tag","-a",tag,"-m","wrong package version"); f.git("push","origin","refs/tags/"+tag);
    assert.notEqual(f.invoke(["--validate-tag",tag]).status,0);
    return;
  }
  const oldTag=artifact.localTagPrefixes[0]+"1.2.3";
  f.git("tag","-a",oldTag,"-m","local release"); f.git("push","origin","refs/tags/"+oldTag);
  writeFileSync(join(f.repo,"changed"),"new source");
  f.git("add","."); f.git("commit","-m","changed"); f.git("push","origin","main");
  const tag=artifact.tagPrefix+"1.2.3";
  f.git("tag","-a",tag,"-m","conflicting request"); f.git("push","origin","refs/tags/"+tag);
  assert.notEqual(f.invoke(["--validate-tag",tag]).status,0);
});

test("tag-ref fetch preserves annotated identity after a peeled-commit checkout", t => {
  const f = fixture(t);
  const ref = "refs/tags/" + f.tag;
  f.git("tag", "-a", f.tag, "-m", "release");
  f.git("push", "origin", ref);
  const object = f.git("rev-parse", ref);
  // actions/checkout's default event-SHA fallback replaces the local tag ref.
  f.git("fetch", "--no-tags", "origin", "+" + f.sha + ":" + ref);
  f.git("checkout", "--detach", ref);
  assert.equal(f.git("cat-file", "-t", ref), "commit");
  const broken = f.invoke(["--validate-tag", f.tag]);
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /Release tag must be annotated/);
  // Explicit checkout ref fetches the tag ref without mapping the event SHA to it.
  f.git("fetch", "--no-tags", "origin", "+" + ref + ":" + ref);
  assert.equal(f.git("rev-parse", ref), object);
  const fixed = f.invoke(["--validate-tag", f.tag]);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(f.git("rev-parse", "HEAD"), f.sha);
  assert.ok(f.git("ls-remote", "origin", ref).startsWith(object));
});

test("push admission binds an explicit tag checkout to the triggering commit", t => {
  const f = fixture(t);
  f.git("tag", "-a", f.tag, "-m", "release");
  f.git("push", "origin", "refs/tags/" + f.tag);
  const event = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "push",
    GITHUB_WORKFLOW_REF: "owner/repo/.github/workflows/" + catalog.artifacts[0].workflow + "@refs/tags/" + f.tag,
    GITHUB_SHA: f.sha,
  };
  const valid = f.invoke(["--validate-tag", f.tag], event);
  assert.equal(valid.status, 0, valid.stderr);
  for (const sha of ["0".repeat(40), ""]) {
    const invalid = f.invoke(["--validate-tag", f.tag], { ...event, GITHUB_SHA: sha });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Release tag must match the triggering commit/);
  }
});
