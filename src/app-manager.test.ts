import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appInstallStatus,
  installApp,
  listAppReleases,
  selectAssetForPlatform,
  type AppManagerDeps,
  type AppRelease,
} from "./app-manager.js";

function releasesFixture(): AppRelease[] {
  return [
    {
      tag: "frely-app-v0.2.0",
      version: "0.2.0",
      prerelease: true,
      assets: [
        { name: "Frely-App-0.2.0-macos-universal.zip", url: "https://example/Frely-App-0.2.0-macos-universal.zip", size: 100 },
        { name: "Frely-App-0.2.0-macos-universal.zip.sha256", url: "https://example/Frely-App-0.2.0-macos-universal.zip.sha256", size: 85 },
        { name: "Frely-App-0.2.0-linux-x64.AppImage", url: "https://example/Frely-App-0.2.0-linux-x64.AppImage", size: 100 },
        { name: "Frely-App-0.2.0-windows-x64.zip", url: "https://example/Frely-App-0.2.0-windows-x64.zip", size: 100 },
      ],
    },
    {
      tag: "frely-client-v0.1.0",
      version: "0.1.0",
      prerelease: true,
      assets: [
        { name: "Pi-Client-0.1.0-macos-universal.zip", url: "https://example/Pi-Client-0.1.0-macos-universal.zip", size: 100 },
        { name: "Pi-Client-0.1.0-macos-arm64.dmg", url: "https://example/Pi-Client-0.1.0-macos-arm64.dmg", size: 100 },
      ],
    },
  ];
}

const darwinOnly = process.platform !== "darwin"
  ? `frely app install flows exercise darwin paths and /Applications writability; skipped on ${process.platform}`
  : false;

test("listAppReleases maps GitHub releases and filters tag prefixes", async () => {
  const body = JSON.stringify([
    {
      tag_name: "v0.7.1",
      prerelease: false,
      assets: [{ name: "frely-darwin-arm64", browser_download_url: "https://example/f", size: 1 }],
    },
    {
      tag_name: "frely-app-v0.2.0",
      prerelease: true,
      assets: [{ name: "Frely-App-0.2.0-macos-universal.zip", browser_download_url: "https://example/a", size: 2 }],
    },
  ]);
  const deps: AppManagerDeps = { fetchText: async () => body };
  const releases = await listAppReleases(deps);
  assert.equal(releases.length, 1);
  assert.equal(releases[0]!.version, "0.2.0");
  assert.equal(releases[0]!.assets[0]!.url, "https://example/a");
});

test("selectAssetForPlatform prefers new prefix and universal darwin assets", () => {
  const releases = releasesFixture();
  const selection = selectAssetForPlatform(releases, "darwin", "arm64");
  assert.ok(selection);
  assert.equal(selection.release.tag, "frely-app-v0.2.0");
  assert.equal(selection.asset.name, "Frely-App-0.2.0-macos-universal.zip");
  assert.ok(selection.sha256Url);
});

test("selectAssetForPlatform falls back to legacy prefix and arch-specific assets", () => {
  const legacyOnly: AppRelease[] = [releasesFixture()[1]!];
  const arm = selectAssetForPlatform(legacyOnly, "darwin", "arm64");
  assert.equal(arm?.asset.name, "Pi-Client-0.1.0-macos-arm64.dmg");
  assert.equal(selectAssetForPlatform(legacyOnly, "darwin", "x64")?.asset.name, "Pi-Client-0.1.0-macos-universal.zip");
  assert.equal(selectAssetForPlatform(legacyOnly, "linux", "arm64"), null);
});

test("selectAssetForPlatform picks linux and windows assets", () => {
  const releases = releasesFixture();
  assert.equal(selectAssetForPlatform(releases, "linux", "x64")?.asset.name, "Frely-App-0.2.0-linux-x64.AppImage");
  assert.equal(selectAssetForPlatform(releases, "win32", "x64")?.asset.name, "Frely-App-0.2.0-windows-x64.zip");
});

test("appInstallStatus reports installed app details on darwin", { skip: darwinOnly }, async () => {
  const deps: AppManagerDeps = {
    platform: "darwin",
    arch: "arm64",
    which: () => undefined,
    pathExists: async (path) => path === "/Applications/Frely App.app",
    run: async (command, args) => {
      if (command === "defaults" && args[0] === "read") return { code: 0, stdout: "0.2.0\n", stderr: "" };
      if (command === "pgrep") return { code: 1, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
  };
  const status = await appInstallStatus(deps);
  assert.equal(status.installed, true);
  assert.equal(status.path, "/Applications/Frely App.app");
  assert.equal(status.version, "0.2.0");
  assert.equal(status.running, false);
  assert.equal(status.managedBy, "manual");
});

test("appInstallStatus recognizes homebrew management and legacy app name", async () => {
  const deps: AppManagerDeps = {
    platform: "darwin",
    arch: "arm64",
    which: (command) => (command === "brew" ? "/opt/homebrew/bin/brew" : undefined),
    pathExists: async (path) => path.endsWith("Frely Client.app"),
    run: async (command) => {
      if (command === "brew") return { code: 0, stdout: "", stderr: "" };
      if (command === "defaults") return { code: 1, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
  };
  const status = await appInstallStatus(deps);
  assert.equal(status.installed, true);
  assert.equal(status.managedBy, "homebrew");
  assert.equal(status.path?.endsWith("Frely Client.app"), true);
});

test("appInstallStatus reports not installed", async () => {
  const deps: AppManagerDeps = { platform: "darwin", which: () => undefined, pathExists: async () => false, run: async () => ({ code: 1, stdout: "", stderr: "" }) };
  const status = await appInstallStatus(deps);
  assert.equal(status.installed, false);
  assert.equal(status.managedBy, "none");
});

test("installApp returns early when already installed", { skip: darwinOnly }, async () => {
  const logs: string[] = [];
  const deps: AppManagerDeps = {
    platform: "darwin",
    which: () => undefined,
    pathExists: async (path) => path === "/Applications/Frely App.app",
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    log: (message) => logs.push(message),
  };
  const result = await installApp(deps);
  assert.equal(result.installed, true);
  assert.ok(logs.some((line) => line.includes("already installed")));
});

test("installApp downloads, verifies sha256, and copies the app bundle (darwin zip)", { skip: darwinOnly }, async () => {
  const logs: string[] = [];
  const commands: Array<[string, string[]]> = [];
  const directory = await mkdtemp(join(tmpdir(), "app-manager-"));
  const archive = join(directory, "Frely-App-0.2.0-macos-universal.zip");
  await writeFile(archive, "archive-bytes");
  const checksum = createHash("sha256").update("archive-bytes").digest("hex");
  const deps: AppManagerDeps = {
    platform: "darwin",
    arch: "arm64",
    which: () => undefined,
    pathExists: async (path) => path.includes("extracted/Frely App.app") || path === "/Applications",
    fetchText: async (url) =>
      url.endsWith(".sha256")
        ? `${checksum}  Frely-App-0.2.0-macos-universal.zip\n`
        : JSON.stringify([
            {
              tag_name: "frely-app-v0.2.0",
              prerelease: true,
              assets: [
                { name: "Frely-App-0.2.0-macos-universal.zip", browser_download_url: "https://example/Frely-App-0.2.0-macos-universal.zip", size: archive.length },
                { name: "Frely-App-0.2.0-macos-universal.zip.sha256", browser_download_url: "https://example/Frely-App-0.2.0-macos-universal.zip.sha256", size: 85 },
              ],
            },
          ]),
    downloadFile: async (_url, destination) => {
      const source = await readFile(archive);
      await writeFile(destination, source);
    },
    run: async (command, args) => {
      commands.push([command, args]);
      return { code: 0, stdout: "", stderr: "" };
    },
    log: (message) => logs.push(message),
  };
  const result = await installApp(deps);
  assert.equal(result.installed, true);
  assert.equal(result.method, "download");
  assert.equal(result.path, "/Applications/Frely App.app");
  // ditto extract then copy; quarantine-preserving (no xattr strip anywhere)
  assert.ok(commands.some(([command, args]) => command === "ditto" && args[0] === "-x"));
  assert.ok(commands.some(([command, args]) => command === "ditto" && args[1] === "/Applications/Frely App.app"));
  assert.ok(!commands.some(([command]) => command === "xattr"));
  assert.ok(logs.some((line) => line.includes("quarantine")));
});

test("installApp fails loudly on sha256 mismatch", async () => {
  const deps: AppManagerDeps = {
    platform: "darwin",
    arch: "arm64",
    which: () => undefined,
    pathExists: async () => false,
    fetchText: async (url) =>
      url.endsWith(".sha256")
        ? `${"0".repeat(64)}  asset\n`
        : JSON.stringify([
            {
              tag_name: "frely-app-v0.2.0",
              prerelease: true,
              assets: [
                { name: "Frely-App-0.2.0-macos-universal.zip", browser_download_url: "https://example/asset", size: 10 },
                { name: "Frely-App-0.2.0-macos-universal.zip.sha256", browser_download_url: "https://example/asset.sha256", size: 85 },
              ],
            },
          ]),
    downloadFile: async (_url, destination) => {
      await writeFile(destination, "other-bytes");
    },
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    log: () => {},
  };
  await assert.rejects(() => installApp(deps), /SHA-256 mismatch/);
});
