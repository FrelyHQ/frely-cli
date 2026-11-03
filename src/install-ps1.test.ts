import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// install.ps1 cannot run on CI Linux; pin the contract between the installer's PATH forwarder and `frely uninstall`.
const installer = readFileSync(new URL("../install.ps1", import.meta.url), "utf8");
const uninstall = readFileSync(new URL("./uninstall.ts", import.meta.url), "utf8");

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
