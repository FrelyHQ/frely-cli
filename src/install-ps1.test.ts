import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// install.ps1 cannot run on CI Linux; pin the contract between the installer's PATH forwarder and `frely uninstall`.
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
