import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "frely-installer-smoke-"));
const platform = process.platform === "win32" ? "windows" : process.platform;
const asset = `frely-${platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
const releases = join(directory, "release"), destination = join(directory, "user bin");
const installed = join(destination, process.platform === "win32" ? "frely.exe" : "frely");
const hash = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
/** Source choice without a network: a fake curl on PATH plays GitHub and npmmirror (FAKE_GITHUB / FAKE_NPMMIRROR = fast | slow | dead). */
async function probeCases() {
  const bin = join(directory, "fakebin"), package_ = join(directory, "pkg", "package");
  await mkdir(bin); await mkdir(package_, { recursive: true });
  await copyFile(join(releases, asset), join(package_, "frely"));
  await writeFile(join(package_, "frely.sha256"), `${await hash(join(releases, asset))}  frely\n`);
  await run("tar", ["-czf", join(directory, "npm.tgz"), "-C", join(directory, "pkg"), "package"]);
  await writeFile(join(bin, "curl"), `#!/bin/sh
url= out= probe=
while [ $# -gt 0 ]; do
  case "$1" in -o) out=$2; shift ;; -w) probe=1; shift ;; https://*) url=$1 ;; esac
  shift
done
echo "$url" >> "$FAKE_LOG"
behaviour=dead
case "$url" in
  https://github.com/*) behaviour=$FAKE_GITHUB ;;
  https://registry.npmmirror.com/*) behaviour=$FAKE_NPMMIRROR ;;
esac
case "$behaviour" in
  dead) exit 6 ;;
  slow) sleep 6; [ -z "$probe" ] || printf '0 0.000'; exit 28 ;;
esac
case "$url" in
  */latest) printf '{"version": "9.9.9"}' > "$out" ;;
  *.tgz) if [ -n "$probe" ]; then printf '2000000 90000000.000'; else cp "$FAKE_RELEASE/npm.tgz" "$out"; fi ;;
  *) if [ -n "$probe" ]; then printf '2000000 40000000.000'; else cp "$FAKE_RELEASE/\${url##*/}" "$out"; fi ;;
esac
`, { mode: 0o755 });
  await copyFile(join(directory, "npm.tgz"), join(releases, "npm.tgz"));
  const log = join(directory, "fake.log");
  const attempt = async (behaviour, extra = {}) => {
    const dir = join(directory, `probe-${Math.random().toString(36).slice(2)}`);
    const env = { ...process.env, HOME: directory, FRELY_INSTALL_DIR: dir, FRELY_INSTALL_NO_PROFILE: "1", FRELY_CLI_VERSION: "latest", PATH: `${bin}:${process.env.PATH}`,
      FAKE_RELEASE: releases, FAKE_LOG: log, ...behaviour, ...extra };
    delete env.FRELY_RELEASE_DIR; delete env.FRELY_INSTALL_SOURCES;
    await writeFile(log, "");
    const started = Date.now();
    const result = await run("/bin/sh", [resolve("install.sh")], { env, timeout: 30000 }).catch((error) => error);
    return { dir, stderr: String(result.stderr ?? ""), elapsed: Date.now() - started, ok: !(result instanceof Error), log: await readFile(log, "utf8") };
  };
  const slowGithub = await attempt({ FAKE_GITHUB: "slow", FAKE_NPMMIRROR: "fast" });
  assert.ok(slowGithub.ok, slowGithub.stderr);
  assert.match(slowGithub.stderr, /Frely: using npmmirror/);
  assert.ok(slowGithub.elapsed < 10000, `a slow GitHub must not hold the install up (${slowGithub.elapsed} ms)`);
  assert.equal(await hash(join(slowGithub.dir, "frely")), await hash(join(releases, asset)));
  const fastGithub = await attempt({ FAKE_GITHUB: "fast", FAKE_NPMMIRROR: "slow" });
  assert.ok(fastGithub.ok, fastGithub.stderr);
  assert.match(fastGithub.stderr, /Frely: using github/);
  const bothDown = await attempt({ FAKE_GITHUB: "dead", FAKE_NPMMIRROR: "dead" });
  assert.ok(!bothDown.ok);
  assert.match(bothDown.stderr, /No source supplied a verified release/);
  assert.ok(bothDown.log.indexOf("github.com") < bothDown.log.lastIndexOf("registry.npmmirror.com"), "default order when every probe fails");
  const pinned = await attempt({ FAKE_GITHUB: "slow", FAKE_NPMMIRROR: "fast" }, { FRELY_INSTALL_SOURCES: "github npmmirror" });
  assert.equal(pinned.log.split("\n").filter((line) => line.includes("github.com")).length, 1, "FRELY_INSTALL_SOURCES skips probing");
}
try {
  await mkdir(releases);
  await copyFile(join("artifacts", asset), join(releases, asset));
  await copyFile(join("artifacts", `${asset}.sha256`), join(releases, `${asset}.sha256`));
  // GitHub carries the executable as <asset>.gz; the main flow installs from that. Releases from before gzip assets have only the raw file.
  await writeFile(join(releases, `${asset}.gz`), gzipSync(await readFile(join("artifacts", asset)), { level: 9 }));
  const env = { ...process.env, HOME: directory, USERPROFILE: directory, LOCALAPPDATA: directory,
    FRELY_RELEASE_DIR: releases, FRELY_INSTALL_DIR: destination, FRELY_INSTALL_NO_PROFILE: "1",
    FRELY_CLI_VERSION: "latest", FRELY_CREDENTIAL_STORE: "invalid-basic-test", XDG_CONFIG_HOME: join(directory, "config") };
  const executable = process.platform === "win32"
    ? win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "/bin/sh";
  const args = process.platform === "win32" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", resolve("install.ps1")] : [resolve("install.sh")];
  await run(executable, args, { env, timeout: 30000 });
  assert.equal(await hash(installed), await hash(join(releases, asset)));
  await run(installed, ["doctor", "--json"], { env, timeout: 10000 });
  if (process.platform !== "win32") {
    const profileDestination = join(directory, ".local", "bin");
    const profileEnv = { ...env, FRELY_INSTALL_DIR: profileDestination, FRELY_INSTALL_NO_PROFILE: "0", SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
    await run(executable, args, { env: profileEnv, timeout: 30000 });
    const zshrc = join(directory, ".zshrc");
    assert.match(await readFile(zshrc, "utf8"), /# Frely user bin/);
    await assert.rejects(readFile(join(directory, ".profile"), "utf8"));
    await unlink(zshrc);
    const protectedProfile = join(directory, "protected-profile");
    await writeFile(protectedProfile, "keep\n");
    await symlink(protectedProfile, zshrc);
    await run(executable, args, { env: profileEnv, timeout: 30000 });
    assert.equal(await readFile(protectedProfile, "utf8"), "keep\n", "profile symlinks must not be followed or turn a successful install into a failure");
  }
  if (process.platform !== "win32") await probeCases();
  // gzip-only and raw-only releases both install; a corrupt archive is rejected and leaves the installation alone.
  for (const [name, files] of [["gz-only", [`${asset}.gz`]], ["raw-only", [asset]]]) {
    const dir = join(directory, name), target = join(directory, `bin-${name}`);
    await mkdir(dir);
    for (const file of [...files, `${asset}.sha256`]) await copyFile(join(releases, file), join(dir, file));
    await run(executable, args, { env: { ...env, FRELY_RELEASE_DIR: dir, FRELY_INSTALL_DIR: target }, timeout: 30000 });
    assert.equal(await hash(join(target, process.platform === "win32" ? "frely.exe" : "frely")), await hash(join("artifacts", asset)), name);
  }
  const corrupt = join(directory, "corrupt");
  await mkdir(corrupt);
  await copyFile(join(releases, `${asset}.sha256`), join(corrupt, `${asset}.sha256`));
  await writeFile(join(corrupt, `${asset}.gz`), "not gzip");
  await assert.rejects(run(executable, args, { env: { ...env, FRELY_RELEASE_DIR: corrupt, FRELY_INSTALL_DIR: join(directory, "bin-corrupt") }, timeout: 30000 }), /No source supplied a verified release/);
  const original = await hash(installed);
  await writeFile(join(releases, `${asset}.sha256`), `${"0".repeat(64)}  ${asset}\n`);
  await assert.rejects(run(executable, args, { env, timeout: 30000 }), /checksum mismatch/i);
  assert.equal(await hash(installed), original, "checksum failure must preserve the installed executable");
  console.log(`Offline installer passed (${platform}): user-only path with spaces, executable startup, checksum rejection, existing installation preserved.`);
} finally { await rm(directory, { recursive: true, force: true }); }
