import test from "node:test";
import assert from "node:assert/strict";
import { buildSandboxConfig, deniedReadReference, detectSandboxBackend, isSandboxDisabled, PATH_GRANTS_META_KEY, pathGrantsFromMeta, protectedWriteDenials, sandboxDenialHint, sensitiveReadPaths } from "./sandbox.js";

test("sandbox backend detection reports off when disabled and never throws", () => {
  const previous = process.env.FRELY_SANDBOX;
  try {
    process.env.FRELY_SANDBOX = "off";
    assert.equal(isSandboxDisabled(), true);
    assert.equal(detectSandboxBackend(), "off");
    process.env.FRELY_SANDBOX = "";
    const backend = detectSandboxBackend();
    assert.ok(backend === "srt" || backend === "unavailable", `unexpected backend ${backend}`);
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
import { homedir, tmpdir } from "node:os";
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

test("sandboxDenialHint points ssh proxy failures at request_permission resource=ssh", () => {
  const proxy = sandboxDenialHint("ssh: Could not resolve hostname ctb-eu\nThe proxy refused the tunnel (HTTP 502)", "ssh ctb-eu uptime", 255, false);
  assert.match(proxy ?? "", /resource=ssh/);
  assert.match(proxy ?? "", /"ctb-eu" has no dot/);
  assert.match(proxy ?? "", /Reading ~\/\.ssh\/config from the CLI process failed/);
  assert.match(sandboxDenialHint("kex_exchange_identification: read: Connection reset", "git pull", 128) ?? "", /resource=ssh/);
  assert.match(sandboxDenialHint("", "scp a b.example.com:/x", 255) ?? "", /resource=ssh/);
  assert.doesNotMatch(sandboxDenialHint("", "ssh ctb.example.com true", 255, true) ?? "", /no dot|failed too/);
  assert.equal(sandboxDenialHint("The proxy refused the tunnel", "curl https://x", 1), undefined);
  assert.equal(sandboxDenialHint("boom", "ssh host true", 1), undefined);
});

test("the sandbox fails closed: the refusal explains the reason and the ways forward, and manual opt-outs still run the command", async () => {
  const { sandboxCommand, sandboxUnavailableMessage, resetSandboxForTests, isSandboxStrict } = await import("./sandbox.js");
  const message = sandboxUnavailableMessage("missing dependencies: bubblewrap not installed");
  assert.match(message, /was not run/u);
  assert.match(message, /bubblewrap not installed/u);
  assert.match(message, /install the missing sandbox dependencies/u);
  assert.match(message, /request_permission with resource "unsandboxed"/u);
  assert.match(message, /FRELY_SANDBOX=off/u);
  assert.equal(isSandboxStrict(), true);

  const previous = { sandbox: process.env.FRELY_SANDBOX, strict: process.env.FRELY_SANDBOX_STRICT };
  try {
    delete process.env.FRELY_SANDBOX_STRICT;
    process.env.FRELY_SANDBOX = "";
    await resetSandboxForTests();
    const backend = detectSandboxBackend();
    if (backend === "srt") {
      // Sandbox works here: the command is wrapped, never returned bare.
      assert.notEqual(await sandboxCommand("echo hi", tmpdir()), "echo hi");
    } else {
      // Unsupported platform or missing dependency: refused without any strict flag.
      await assert.rejects(sandboxCommand("echo hi", tmpdir()), /sandbox cannot run on this device/u);
    }
    // The owner's approved grant and FRELY_SANDBOX=off are the only ways to run it as is.
    assert.equal(await sandboxCommand("echo hi", tmpdir(), [UNSANDBOXED_GROUP]), "echo hi");
    process.env.FRELY_SANDBOX = "off";
    assert.equal(await sandboxCommand("echo hi", tmpdir()), "echo hi");
  } finally {
    if (previous.sandbox === undefined) delete process.env.FRELY_SANDBOX; else process.env.FRELY_SANDBOX = previous.sandbox;
    if (previous.strict === undefined) delete process.env.FRELY_SANDBOX_STRICT; else process.env.FRELY_SANDBOX_STRICT = previous.strict;
    await resetSandboxForTests();
  }
});

test("deniedReadReference names an unapproved credential path spelled in the command", () => {
  const home = homedir();
  assert.deepEqual(deniedReadReference("ls -la ~/.ssh"), { path: "~/.ssh", group: "ssh" });
  assert.deepEqual(deniedReadReference("cat $HOME/.ssh/id_rsa | head -2"), { path: "~/.ssh", group: "ssh" });
  assert.deepEqual(deniedReadReference(`cat "${home}/.aws/credentials"`), { path: "~/.aws", group: "aws" });
  assert.deepEqual(deniedReadReference("cat ${HOME}/.config/frely/config.json"), { path: "~/.config/frely", group: null });
  assert.equal(deniedReadReference("ls -la ~/.ssh", ["ssh"]), undefined);
  assert.equal(deniedReadReference("ls ~/.sshx ~/projects"), undefined);
  assert.equal(deniedReadReference("ssh ctb.example.com uptime"), undefined);
});

test("loopback binding is open by default so local servers and tests can run", () => {
  assert.equal(buildSandboxConfig("/work", []).network?.allowLocalBinding, true);
});

import { mkdtempSync, rmSync } from "node:fs";
import { sandboxViolationLines, wrapSerialized, type WrapManager } from "./sandbox.js";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

const baseConfig = (): SandboxRuntimeConfig => buildSandboxConfig("/work");

/** A stand-in for srt that records the global allowGitConfig switch at the moment each command is wrapped. */
function fakeManager(): { manager: WrapManager; seen: Map<string, boolean | undefined>; updates: (boolean | undefined)[]; current: () => boolean | undefined } {
  let flag: boolean | undefined;
  const seen = new Map<string, boolean | undefined>();
  const updates: (boolean | undefined)[] = [];
  const manager: WrapManager = {
    updateConfig(config) { flag = config.filesystem?.allowGitConfig; updates.push(flag); },
    async wrapWithSandbox(command) { await new Promise((resolve) => setTimeout(resolve, 5)); seen.set(command, flag); return `wrapped:${command}`; },
  };
  return { manager, seen, updates, current: () => flag };
}

test("allowGitConfig is on only while the wrap of the one command that asked for it runs, even with commands wrapped at the same time", async () => {
  const { manager, seen, updates, current } = fakeManager();
  const base = baseConfig();
  const wrap = (command: string, gitConfig: boolean) => wrapSerialized(manager, base, () => manager.wrapWithSandbox(command), gitConfig);
  const results = await Promise.all([wrap("a", false), wrap("b", true), wrap("c", false), wrap("d", true), wrap("e", false)]);
  assert.deepEqual(results, ["wrapped:a", "wrapped:b", "wrapped:c", "wrapped:d", "wrapped:e"]);
  assert.deepEqual([...seen], [["a", undefined], ["b", true], ["c", undefined], ["d", true], ["e", undefined]]);
  assert.equal(current(), undefined, "switched back after the last git-config wrap");
  assert.deepEqual(updates, [true, undefined, true, undefined]);
});

test("a failed wrap still switches allowGitConfig back and does not block later wraps", async () => {
  const { manager, seen, current } = fakeManager();
  const base = baseConfig();
  await assert.rejects(wrapSerialized(manager, base, async () => { throw new Error("bwrap failed"); }, true), /bwrap failed/u);
  assert.equal(current(), undefined);
  assert.equal(await wrapSerialized(manager, base, () => manager.wrapWithSandbox("next"), false), "wrapped:next");
  assert.equal(seen.get("next"), undefined);
});

test("only the wraps are queued: wrapped commands keep running concurrently", async () => {
  const { manager } = fakeManager();
  const base = baseConfig();
  const running: string[] = [];
  const peak = { value: 0 };
  const spawn = async (name: string) => {
    const wrapped = await wrapSerialized(manager, base, () => manager.wrapWithSandbox(name), name === "git");
    running.push(wrapped);
    peak.value = Math.max(peak.value, running.length);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running.splice(running.indexOf(wrapped), 1);
  };
  await Promise.all([spawn("git"), spawn("one"), spawn("two")]);
  assert.equal(peak.value, 3);
});

test("run_command's profile may write .git/config, start_process's may not, and .git/hooks is denied in both", () => {
  const root = mkdtempSync(join(tmpdir(), "frely-sbx-"));
  try {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    const denied = buildSandboxConfig(root).filesystem;
    assert.ok(denied?.denyWrite?.includes(join(root, ".git", "config")));
    assert.ok(denied?.denyWrite?.includes(join(root, ".git", "hooks")));
    assert.equal(denied?.allowGitConfig, undefined);
    const allowed = buildSandboxConfig(root, [], { allowGitConfig: true }).filesystem;
    assert.ok(!allowed?.denyWrite?.includes(join(root, ".git", "config")));
    assert.ok(allowed?.denyWrite?.includes(join(root, ".git", "hooks")));
    assert.equal(allowed?.allowGitConfig, true);
    // No .git directory (a fresh folder, or a worktree whose .git is a file): nothing extra is denied.
    assert.deepEqual(buildSandboxConfig("/nonexistent-workspace").filesystem?.denyWrite, protectedWriteDenials([]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the user's upstream proxy is passed to srt only when there is one", () => {
  assert.equal(buildSandboxConfig("/work").network?.parentProxy, undefined);
  assert.deepEqual(buildSandboxConfig("/work", [], { parentProxy: { http: "http://127.0.0.1:7890", https: "http://127.0.0.1:7890", noProxy: "corp.example" } }).network?.parentProxy, { http: "http://127.0.0.1:7890", https: "http://127.0.0.1:7890", noProxy: "corp.example" });
});

test("violation lines of an unknown command are empty and never throw", () => {
  assert.deepEqual(sandboxViolationLines(undefined), []);
  assert.deepEqual(sandboxViolationLines("no-such-command"), []);
});

test("denial hints name the narrowest approval for what was blocked", () => {
  const home = homedir();
  const credential = sandboxDenialHint(`cat: ${home}/.aws/credentials: Operation not permitted`, "cat x");
  assert.match(credential ?? "", /resource "aws"/u);
  assert.doesNotMatch(credential ?? "", /unsandboxed/u);
  const write = sandboxDenialHint("mkdir: cannot create directory '/opt/homebrew/Cellar/x': Operation not permitted", "brew x", 1, undefined, { workspaceRoot: "/work" });
  assert.match(write ?? "", /resource "path:\/opt\/homebrew\/Cellar"/u);
  assert.doesNotMatch(write ?? "", /unsandboxed/u);
  const home_ = sandboxDenialHint(`touch: cannot touch '${home}/.local/share/tool/x': Permission denied`, "tool", 1, undefined, { workspaceRoot: "/work" });
  assert.match(home_ ?? "", /resource "path:~\/\.local\/share\/tool"/u);
  // Inside the workspace or temp directory a denial is not a missing grant.
  assert.doesNotMatch(sandboxDenialHint("touch: cannot touch '/work/a/b': Permission denied", "touch a/b", 1, undefined, { workspaceRoot: "/work" }) ?? "", /resource "path:/u);
  // A protected file can only be opened by naming it exactly.
  assert.match(sandboxDenialHint(`bash: ${home}/.zshrc: Operation not permitted`, "echo x >> ~/.zshrc", 1, undefined, { workspaceRoot: "/work" }) ?? "", /resource "path:~\/\.zshrc"/u);
});

test("violations recorded by srt are used when stderr names nothing", () => {
  const hint = sandboxDenialHint("make: *** [all] Error 1", "make", 2, undefined, { violations: ["deny(1) file-write-create /opt/tools/out.bin"], workspaceRoot: "/work" });
  assert.match(hint ?? "", /resource "path:\/opt\/tools"/u);
});

test(".git/hooks stays blocked and the hint says no approval opens it", () => {
  const hint = sandboxDenialHint("error: unable to create '/work/.git/hooks/pre-commit': Operation not permitted", "cp x .git/hooks/pre-commit", 1, undefined, { workspaceRoot: "/work" });
  assert.match(hint ?? "", /\.git\/hooks stays blocked/u);
  assert.match(hint ?? "", /no approval opens it/u);
  assert.doesNotMatch(hint ?? "", /resource "path:/u);
  assert.doesNotMatch(hint ?? "", /unsandboxed/u);
});

test("docker.sock, raw TCP and XPC are the only denials that point at unsandboxed; raw TCP also names frely tunnel", () => {
  const docker = sandboxDenialHint("permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock", "docker ps", 1);
  assert.match(docker ?? "", /resource "unsandboxed"/u);
  assert.match(docker ?? "", /once by default/u);
  assert.doesNotMatch(docker ?? "", /frely tunnel/u);
  const tcp = sandboxDenialHint("psql: error: connection to server at \"db.example.com\" (10.1.2.3), port 5432 failed: Connection refused", "psql -h db.example.com -c 'select 1'", 2);
  assert.match(tcp ?? "", /frely tunnel <host>:<port>/u);
  assert.match(tcp ?? "", /resource "unsandboxed"/u);
  assert.match(sandboxDenialHint("redis-cli: Could not connect", "redis-cli -h cache.example.com ping", 1) ?? "", /frely tunnel/u);
  assert.match(sandboxDenialHint("anything", "node x.js", 1, undefined, { violations: ["deny(1) network-outbound 10.1.2.3:5432"] }) ?? "", /frely tunnel/u);
  const xpc = sandboxDenialHint("error: Connection invalid (mach-lookup com.apple.CoreSimulator.CoreSimulatorService)", "xcrun simctl list", 1);
  assert.match(xpc ?? "", /XPC/u);
  assert.match(xpc ?? "", /resource "unsandboxed"/u);
  // Ordinary network failures of other commands are not a sandbox matter.
  assert.equal(sandboxDenialHint("curl: (7) Failed to connect: Connection refused", "curl http://localhost:1", 7), undefined);
});

test(".git/config denials say it is a run_command thing", () => {
  assert.match(sandboxDenialHint("error: could not lock config file /work/.git/config: Operation not permitted", "git remote add x y", 1, undefined, { workspaceRoot: "/work" }) ?? "", /run_command/u);
});
