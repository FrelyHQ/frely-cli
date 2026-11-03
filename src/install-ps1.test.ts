import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// install.ps1 cannot run on CI Linux; pin the contract between the installer's PATH forwarder and `frely uninstall`.
const installer = readFileSync(new URL("../install.ps1", import.meta.url), "utf8");
const uninstall = readFileSync(new URL("./uninstall.ts", import.meta.url), "utf8");

describe("install.ps1 PATH resolution", () => {
  test("writes a marked frely.cmd forwarder that uninstall knows how to remove", () => {
    expect(installer).toContain("frely-shim");
    expect(uninstall).toContain("frely-shim");
    expect(installer).toContain("frely.cmd");
    expect(uninstall).toContain("frely.cmd");
  });
  test("verifies resolution from a fresh shell and tells agents to use the full path instead of reinstalling", () => {
    expect(installer).toContain("Find-Frely $freshPath");
    expect(installer).toContain("Find-Frely $inheritedPath");
    expect(installer).toContain("do not reinstall");
  });
});
