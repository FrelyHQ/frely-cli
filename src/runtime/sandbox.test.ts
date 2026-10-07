import test from "node:test";
import assert from "node:assert/strict";
import { buildSandboxConfig, detectSandboxBackend, isSandboxDisabled, PATH_GRANTS_META_KEY, pathGrantsFromMeta, protectedWriteDenials, sandboxDenialHint, sensitiveReadPaths } from "./sandbox.js";

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

test("the Admin session directory is closed to commands until friday-admin is approved, then readable and writable", () => {
  assert.ok(sensitiveReadPaths().includes("~/.config/friday-relay"));
  assert.ok(protectedWriteDenials([]).includes("~/.config/friday-relay"));
  assert.ok(!sensitiveReadPaths(["friday-admin"]).includes("~/.config/friday-relay"));
  assert.ok(!protectedWriteDenials(["friday-admin"]).includes("~/.config/friday-relay"));
  assert.ok(writablePaths(["friday-admin"]).includes("~/.config/friday-relay"));
  assert.ok(sensitiveReadPaths(["friday-admin"]).includes("~/.config/frely"));
  assert.deepEqual(pathGrantsFromMeta({ [PATH_GRANTS_META_KEY]: ["friday-admin"] }), ["friday-admin"]);
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

test("custom writable paths: any absolute directory, protected paths only when named exactly", () => {
  const home = homedir();
  const refused = [
    "path:/", "path:", "path:~", "path:relative/dir", "path:/opt/../etc", "path:~/a/../.ssh", "path:/tmp\0/x", `path:/${"a".repeat(150)}`,
    // Frely's own credentials can never be granted; sub-paths of a protected path need the protected path itself.
    "path:~/.config/frely", "path:~/.config/frely/devices", "path:~/.ssh/keys", `path:${join(home, ".aws", "config")}`, "path:~/Library/LaunchAgents/x",
  ];
  for (const name of refused) assert.equal(customWritePath(name), undefined, name);
  // A parent of a protected path is a normal grant (the protection is applied by protectedWriteDenials); so is the home directory.
  assert.equal(customWritePath("path:~/"), home);
  assert.equal(customWritePath(`path:${home}`), home);
  assert.equal(customWritePath("path:~/.config"), join(home, ".config"));
  assert.equal(customWritePath("path:~/Library"), join(home, "Library"));
  // Naming a protected path in full is the explicit second step.
  assert.equal(customWritePath("path:~/.ssh"), join(home, ".ssh"));
  assert.equal(customWritePath("path:~/.zshrc"), join(home, ".zshrc"));
  assert.equal(isKnownGrantName("path:~/.ssh"), true);
  assert.equal(isKnownGrantName("path:~/.ssh/keys"), false);
  assert.equal(isKnownGrantName("unsandboxed"), true);
  assert.deepEqual(pathGrantsFromMeta({ [PATH_GRANTS_META_KEY]: ["ssh", "gradle", "unsandboxed", "path:~/dev/sdk", "path:~/.ssh/keys", "nope"] }), ["ssh", "gradle", "unsandboxed", "path:~/dev/sdk"]);
  // Any other absolute directory is allowed (POSIX paths; Windows normalises the separators).
  if (process.platform !== "win32") {
    for (const path of ["/tmp", "/tmp/", "/tmp/frely-work", "/var/folders/ab/cd1234/T/frely", "/private/tmp/x", "/etc", "/opt/homebrew/Caskroom/flutter", "/Volumes/Data/work", `/${"a".repeat(149)}`]) {
      assert.equal(customWritePath(`path:${path}`), path.replace(/\/+$/u, ""), path);
    }
    assert.equal(customWritePath(`path:${join(home, "development", "sdk")}`), join(home, "development", "sdk"));
  }
  // On Windows the system drive root is refused, the root of another drive is allowed.
  if (process.platform === "win32") {
    const system = `${process.env.SystemDrive ?? "C:"}\\`;
    const other = system.toLowerCase().startsWith("d:") ? "E:\\" : "D:\\";
    assert.equal(customWritePath(`path:${system}`), undefined);
    assert.equal(customWritePath(`path:${system.replace("\\", "/")}`), undefined);
    assert.equal(customWritePath(`path:${other}`), other);
    assert.equal(customWritePath(`path:${other.replace("\\", "/")}`), other);
    assert.equal(customWritePath(`path:${other}work`), `${other}work`);
  }
});

test("protected paths stay write-denied inside a granted parent until named exactly", () => {
  const denied = (groups: string[]) => buildSandboxConfig("/work", groups).filesystem?.denyWrite ?? [];
  // Always denied by default, and Frely's credentials in every case.
  for (const path of ["~/.ssh", "~/.aws", "~/.zshrc", "~/Library/LaunchAgents", "~/.config/frely"]) assert.ok(denied([]).includes(path), path);
  // The home directory granted as a whole does not open the protected paths inside it.
  const withHome = buildSandboxConfig("/work", ["path:~/"]).filesystem;
  assert.ok(withHome?.allowWrite?.includes(homedir()));
  for (const path of ["~/.ssh", "~/.aws", "~/.zshrc", "~/.config/frely"]) assert.ok(withHome?.denyWrite?.includes(path), path);
  // Naming ~/.ssh in full lifts that one denial and no other; Frely's credentials stay denied.
  const exact = denied(["path:~/", "path:~/.ssh"]);
  assert.ok(!exact.includes("~/.ssh"));
  for (const path of ["~/.aws", "~/.zshrc", "~/.config/frely"]) assert.ok(exact.includes(path), path);
  // A refused name changes nothing.
  assert.ok(denied(["path:~/.config/frely", "path:~/.ssh/keys"]).includes("~/.ssh"));
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
