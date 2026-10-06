import test from "node:test";
import assert from "node:assert/strict";
import { buildSandboxConfig, detectSandboxBackend, isSandboxDisabled, PATH_GRANTS_META_KEY, pathGrantsFromMeta, sandboxDenialHint, sensitiveReadPaths } from "./sandbox.js";
import { generateProxyEnvVars } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";

test("sandbox backend detection reports off when disabled and never throws", () => {
  const previous = process.env.FRELY_SANDBOX;
  try {
    process.env.FRELY_SANDBOX = "off";
    assert.equal(isSandboxDisabled(), true);
    assert.equal(detectSandboxBackend(), "off");
    process.env.FRELY_SANDBOX = "";
    const backend = detectSandboxBackend();
    assert.ok(backend === "srt" || backend === "none", `unexpected backend ${backend}`);
  } finally {
    if (previous === undefined) delete process.env.FRELY_SANDBOX; else process.env.FRELY_SANDBOX = previous;
  }
});

test("a path grant reopens only its own group and never the Frely credential directory", () => {
  assert.ok(sensitiveReadPaths().includes("~/.ssh"));
  const withSsh = sensitiveReadPaths(["ssh"]);
  assert.ok(!withSsh.includes("~/.ssh"));
  assert.ok(withSsh.includes("~/.aws"));
  assert.ok(sensitiveReadPaths(["ssh", "aws", "gcloud", "kube", "gh", "gnupg", "git-credentials", "npm-tokens", "frely"]).includes("~/.config/frely"));
  assert.equal(buildSandboxConfig("/work", ["ssh"]).filesystem?.denyRead?.includes("~/.ssh"), false);
});

test("path grants are read from the relay's _meta key and unknown names are dropped", () => {
  assert.deepEqual(pathGrantsFromMeta({ [PATH_GRANTS_META_KEY]: ["ssh", "ssh", "frely", "../etc", 7] }), ["ssh"]);
  assert.deepEqual(pathGrantsFromMeta(undefined), []);
  assert.deepEqual(pathGrantsFromMeta({ [PATH_GRANTS_META_KEY]: "ssh" }), []);
});

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { customWritePath, isKnownGrantName, SSH_PROXY_PREFIX, UNSANDBOXED_GROUP, writablePaths } from "./sandbox.js";

test("cache groups and custom paths open only the directories they name", () => {
  assert.ok(buildSandboxConfig("/work", ["pub-cache"]).filesystem?.allowWrite?.includes("~/.pub-cache"));
  assert.ok(!buildSandboxConfig("/work", []).filesystem?.allowWrite?.includes("~/.pub-cache"));
  assert.deepEqual(writablePaths(["gradle", "ssh", UNSANDBOXED_GROUP]), ["~/.gradle"]);
  assert.deepEqual(writablePaths(["path:~/development/flutter/bin/cache"]), [join(homedir(), "development", "flutter", "bin", "cache")]);
});

test("custom writable paths refuse the home directory, credential stores and start-up files", () => {
  const home = homedir();
  const refused = [
    "path:~", "path:~/", "path:/", "path:", "path:relative/dir", "path:/opt/../etc", "path:~/a/../.ssh", "path:/tmp\0/x", `path:/${"a".repeat(150)}`,
    "path:~/.ssh", "path:~/.ssh/keys", "path:~/.aws", "path:~/.zshrc", "path:~/.bashrc", "path:~/.config/frely", "path:~/.config/frely/devices",
    "path:~/Library", "path:~/Library/LaunchAgents/x", "path:/Library/LaunchDaemons",
    `path:${join(home, ".ssh")}`, `path:${join(home, ".aws", "config")}`, `path:${home}`, `path:${join(home, "..")}`,
  ];
  for (const name of refused) assert.equal(customWritePath(name), undefined, name);
  // Any other absolute directory is allowed (POSIX paths; Windows normalises the separators).
  if (process.platform !== "win32") {
    for (const path of ["/tmp", "/tmp/", "/tmp/frely-work", "/var/folders/ab/cd1234/T/frely", "/private/tmp/x", "/opt/homebrew/Caskroom/flutter", "/Volumes/Data/work", `/${"a".repeat(149)}`]) {
      assert.equal(customWritePath(`path:${path}`), path.replace(/\/+$/u, ""), path);
    }
    assert.equal(customWritePath(`path:${join(home, "development", "sdk")}`), join(home, "development", "sdk"));
  }
  assert.equal(isKnownGrantName("path:~/.ssh"), false);
  assert.equal(isKnownGrantName("unsandboxed"), true);
  assert.deepEqual(pathGrantsFromMeta({ [PATH_GRANTS_META_KEY]: ["ssh", "gradle", "unsandboxed", "path:~/dev/sdk", "path:~/.ssh", "nope"] }), ["ssh", "gradle", "unsandboxed", "path:~/dev/sdk"]);
});

test("the ssh prefix runs plain ssh through the proxy options srt exports for git", { skip: process.platform === "win32" }, () => {
  const run = (script: string, env: Record<string, string>) => execFileSync("/bin/sh", ["-c", SSH_PROXY_PREFIX + script], { env: { PATH: "/tmp/frely-no-bin:/usr/bin:/bin", ...env }, encoding: "utf8" });
  const dir = `${process.env.TMPDIR ?? "/tmp"}/frely-ssh-prefix-${process.pid}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/ssh`, '#!/bin/sh\nfor a in "$@"; do printf "[%s]" "$a"; done; echo\n', { mode: 0o755 });
  const out = run('ssh host "echo hi there"', { PATH: `${dir}:/usr/bin:/bin`, GIT_SSH_COMMAND: "ssh -o ControlMaster=no -o ProxyCommand='nc -X 5 -x localhost:9 %h %p'" });
  assert.equal(out.trim(), "[-o][ControlMaster=no][-o][ProxyCommand=nc -X 5 -x localhost:9 %h %p][host][echo hi there]");
  assert.equal(run('ssh host', { PATH: `${dir}:/usr/bin:/bin` }).trim(), "[host]");
});

test("sandboxDenialHint recognises denials and points at request_permission", () => {
  assert.match(sandboxDenialHint("mkdir: /opt/homebrew/x: Operation not permitted") ?? "", /request_permission/);
  assert.match(sandboxDenialHint("Permission denied") ?? "", /sandbox/);
  assert.equal(sandboxDenialHint("fatal: not a git repository"), undefined);
});

test("patched srt uses authenticated HTTP CONNECT for macOS git-over-ssh", { skip: process.platform !== "darwin" }, () => {
  const env = generateProxyEnvVars(65229, 65230, undefined, "deadbeef", true, "echo hi");
  const gitSsh = env.find((value) => value.startsWith("GIT_SSH_COMMAND="));
  assert.ok(gitSsh);
  assert.match(gitSsh, /ProxyCommand=/);
  assert.match(gitSsh, /CONNECT %h:%p HTTP\/1\.1/);
  assert.match(gitSsh, /Proxy-Authorization: Basic/);
  assert.match(gitSsh, /c3J0LmVjaG8gaGk6ZGVhZGJlZWY=/);
  assert.match(gitSsh, /\/bin\/sh -c/);
  assert.match(gitSsh, /\/usr\/bin\/nc 127\.0\.0\.1 65229/);
  assert.doesNotMatch(gitSsh, /nc -X 5 -x localhost:65230/);
});

test("patched srt keeps the macOS SOCKS5 git-over-ssh path without proxy auth", { skip: process.platform !== "darwin" }, () => {
  const env = generateProxyEnvVars(65229, 65230, undefined, undefined, true, "echo hi");
  const gitSsh = env.find((value) => value.startsWith("GIT_SSH_COMMAND="));
  assert.ok(gitSsh);
  assert.match(gitSsh, /nc -X 5 -x localhost:65230/);
  assert.doesNotMatch(gitSsh, /Proxy-Authorization: Basic/);
});
