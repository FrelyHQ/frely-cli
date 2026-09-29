import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";

// Preloaded by scripts/test.mjs (node --test --import). Gives every test a private
// XDG_CONFIG_HOME so state kept under ~/.config/frely (MCP authorization, the workspace
// registry, ...) can neither leak between tests nor touch the real user profile.
let previous: string | undefined;
let directory: string | undefined;

beforeEach(() => {
  previous = process.env.XDG_CONFIG_HOME;
  directory = mkdtempSync(join(tmpdir(), "frely-test-config-"));
  process.env.XDG_CONFIG_HOME = directory;
});

afterEach(() => {
  if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previous;
  if (directory) rmSync(directory, { recursive: true, force: true });
});
