import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "frely-installer-smoke-"));
const platform = process.platform === "win32" ? "windows" : process.platform;
const asset = `frely-${platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
const releases = join(directory, "release"), destination = join(directory, "user bin");
const installed = join(destination, process.platform === "win32" ? "frely.exe" : "frely");
const hash = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
try {
  await mkdir(releases);
  await copyFile(join("artifacts", asset), join(releases, asset));
  await copyFile(join("artifacts", `${asset}.sha256`), join(releases, `${asset}.sha256`));
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
  const original = await hash(installed);
  await writeFile(join(releases, `${asset}.sha256`), `${"0".repeat(64)}  ${asset}\n`);
  await assert.rejects(run(executable, args, { env, timeout: 30000 }), /checksum mismatch/i);
  assert.equal(await hash(installed), original, "checksum failure must preserve the installed executable");
  console.log(`Offline installer passed (${platform}): user-only path with spaces, executable startup, checksum rejection, existing installation preserved.`);
} finally { await rm(directory, { recursive: true, force: true }); }
