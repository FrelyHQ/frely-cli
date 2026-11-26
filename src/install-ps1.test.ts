import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// install.ps1 cannot run on CI Linux; pin the contract between the installer's PATH forwarder and `frely self uninstall`.
const installer = readFileSync("install.ps1", "utf8");
const uninstall = readFileSync("src/uninstall.ts", "utf8");

test("install.ps1 writes a marked frely.cmd forwarder that uninstall removes", () => {
  for (const text of [installer, uninstall]) {
    assert.ok(text.includes("frely-shim"));
    assert.ok(text.includes("frely.cmd"));
  }
});

test("install.ps1 verifies resolution and tells agents not to reinstall", () => {
  assert.ok(installer.includes("Find-Frely $freshPath"));
  assert.ok(installer.includes("Find-Frely $inheritedPath"));
  assert.ok(installer.includes("do not reinstall"));
});

test("install.ps1 stops the service before replacing and keeps the verified download on failure", () => {
  assert.ok(installer.includes("mcp service stop"));
  assert.ok(installer.indexOf("mcp service stop") < installer.indexOf("[IO.File]::Replace"));
  assert.ok(installer.includes(".new.exe"));
  assert.ok(installer.includes("the verified download was kept at"));
  assert.ok(installer.includes("mcp service start"));
});

test("installers warn when an older frely earlier on PATH wins", () => {
  assert.ok(installer.includes("not the one just installed"));
  assert.ok(readFileSync("install.sh", "utf8").includes("not the one just installed"));
});

test("install.ps1 replaces an existing frely.exe without a backup path", () => {
  const line = installer.split("\n").find((candidate) => candidate.includes("[IO.File]::Replace"));
  assert.ok(line, "install.ps1 has no [IO.File]::Replace call");
  assert.ok(line.includes("[NullString]::Value"), "a plain $null reaches File.Replace as an empty backup path in PowerShell");
});

// Runs the installer's own Replace line in Windows PowerShell 5.1, the shell that fails on an empty backup path.
test("install.ps1 Replace line works in Windows PowerShell", { skip: process.platform !== "win32" }, () => {
  const line = installer.split("\n").find((candidate) => candidate.includes("[IO.File]::Replace"))!.trim();
  const directory = mkdtempSync(join(tmpdir(), "frely-replace-"));
  try {
    const target = join(directory, "frely.exe");
    const download = join(directory, "frely.new.exe");
    writeFileSync(target, "old");
    writeFileSync(download, "new");
    const script = `$ErrorActionPreference='Stop'; $download='${download}'; $target='${target}'; $install = ${line.replace(/^\$install = /u, "")}; & $install`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(target, "utf8"), "new");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
