import test from "node:test";
import assert from "node:assert/strict";
import { cliLaunchArguments } from "./cli-launch.js";
import { windowsArgument, windowsService } from "./service-windows.js";
import { systemdUnit, launchAgentPlist, serviceLaunchArguments, systemdUnitPath } from "./service.js";
import { join } from "node:path";

test("standalone and npm services invoke the intended executable", () => {
  assert.deepEqual(cliLaunchArguments("/src/index.js", ["mcp", "serve"], true, "/bin/frely"), ["/bin/frely", "mcp", "serve"]);
  assert.deepEqual(cliLaunchArguments("/src/index.js", ["mcp", "serve"], false, "/bin/node"), ["/bin/node", "/src/index.js", "mcp", "serve"]);
});

test("service configuration escapes arguments and never includes an external master key", () => {
  const previous = { FRELY_CREDENTIAL_KEY: process.env.FRELY_CREDENTIAL_KEY, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.FRELY_CREDENTIAL_KEY = "a".repeat(64); process.env.XDG_CONFIG_HOME = "/synthetic/config";
  try {
    const command = serviceLaunchArguments("/synthetic/index.js", "/workspace/with % and $value");
    assert.equal(command.includes("a".repeat(64)), false);
    assert.equal(command.includes("encrypted-file"), true);
    assert.equal(systemdUnitPath(), join("/synthetic/config", "systemd", "user", "frely-mcp.service"));
    const unit = systemdUnit(command);
    assert.match(unit, /%% and \$\$value/);
    const plist = launchAgentPlist(["/bin/frely", "mcp", "serve", "--workspace", "/a&b<project>"], "/state");
    assert.match(plist, /a&amp;b&lt;project&gt;/);
    assert.throws(() => systemdUnit(["/bin/frely", "bad\nargument"]), /control characters/);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("Windows task requests carry paths as stdin data, not PowerShell code", async () => {
  const path = 'C:\\Users\\synthetic\\odd & name\\frely.exe';
  const workspace = 'C:\\synthetic\\trailing\\';
  const result = await windowsService("install", [path, "mcp", "serve", "--workspace", workspace], async (file, args, stdin) => {
    assert.match(file, /WindowsPowerShell/);
    assert.equal(args.join(" ").includes(path), false);
    assert.equal(args.includes("-ExecutionPolicy"), false);
    const request = JSON.parse(stdin ?? "");
    assert.equal(request.executable, path);
    assert.equal(request.arguments, ['mcp', 'serve', '--workspace', workspace].map(windowsArgument).join(" "));
    return { code: 0, stdout: '{"installed":true,"active":true}', stderr: "" };
  });
  assert.deepEqual(result, { installed: true, active: true });
  assert.equal(windowsArgument('a"b'), '"a\\"b"');
  assert.throws(() => windowsArgument("bad\nargument"));
});
