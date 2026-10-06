import test from "node:test";
import assert from "node:assert/strict";
import { buildSandboxConfig, detectSandboxBackend, isSandboxDisabled, PATH_GRANTS_META_KEY, pathGrantsFromMeta, sensitiveReadPaths } from "./sandbox.js";

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
  for (const name of ["path:~", "path:~/", "path:/", "path:/etc", "path:/usr/bin", "path:~/.ssh", "path:~/.ssh/keys", "path:~/.zshrc", "path:~/Library", "path:~/Library/LaunchAgents/x", "path:~/.config/frely", "path:~/a/../.ssh", "path:relative/dir", "path:/opt", "path:/opt/../etc"]) {
    assert.equal(customWritePath(name), undefined, name);
  }
  // /opt is a POSIX install root; on Windows it is not under any allowed root.
  assert.equal(customWritePath("path:/opt/homebrew/Caskroom/flutter"), process.platform === "win32" ? undefined : "/opt/homebrew/Caskroom/flutter");
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
