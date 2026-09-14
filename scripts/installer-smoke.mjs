import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const original = await hash(installed);
  await writeFile(join(releases, `${asset}.sha256`), `${"0".repeat(64)}  ${asset}\n`);
  await assert.rejects(run(executable, args, { env, timeout: 30000 }), /checksum mismatch/i);
  assert.equal(await hash(installed), original, "checksum failure must preserve the installed executable");
  console.log(`Offline installer passed (${platform}): user-only path with spaces, executable startup, checksum rejection, existing installation preserved.`);
} finally { await rm(directory, { recursive: true, force: true }); }
