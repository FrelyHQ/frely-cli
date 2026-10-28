import assert from "node:assert/strict";
import test from "node:test";
import { intOption, parseArgs, parseTarget, requireRemote } from "./args.js";

test("device:path is split at the first colon, and a drive letter is a local Windows path", () => {
  assert.deepEqual(parseTarget("laptop:src/a.ts"), { device: "laptop", path: "src/a.ts" });
  assert.deepEqual(parseTarget("laptop:"), { device: "laptop", path: "." });
  assert.deepEqual(parseTarget("laptop:C:\\Users\\a"), { device: "laptop", path: "C:\\Users\\a" });
  assert.deepEqual(parseTarget("C:\\Users\\a"), { device: null, path: "C:\\Users\\a" });
  assert.deepEqual(parseTarget("c:/Users/a"), { device: null, path: "c:/Users/a" });
  assert.deepEqual(parseTarget("./notes.txt"), { device: null, path: "./notes.txt" });
  assert.deepEqual(parseTarget("a:b"), { device: "a", path: "b" });
  assert.throws(() => requireRemote("./notes.txt"), /names no device/u);
  assert.throws(() => requireRemote(undefined), /<device>:<path>/u);
});

test("options, flags and the command after -- are separated, and unknown options are refused", () => {
  const parsed = parseArgs(["box", "--cwd", "app", "--background", "--", "ls", "--all"], { flags: ["--background"], values: ["--cwd", "--timeout"] });
  assert.deepEqual(parsed.positionals, ["box"]);
  assert.equal(parsed.values.get("--cwd"), "app");
  assert.equal(parsed.flags.has("--background"), true);
  assert.deepEqual(parsed.rest, ["ls", "--all"]);
  assert.throws(() => parseArgs(["--nope"], {}), /Unknown option/u);
  assert.throws(() => parseArgs(["--cwd"], { values: ["--cwd"] }), /needs a value/u);
  assert.throws(() => parseArgs(["--cwd", "a", "--cwd", "b"], { values: ["--cwd"] }), /twice/u);
  assert.equal(intOption(parseArgs(["--timeout", "30"], { values: ["--timeout"] }), "--timeout", 1, 120), 30);
  assert.throws(() => intOption(parseArgs(["--timeout", "0"], { values: ["--timeout"] }), "--timeout", 1, 120), /whole number/u);
});
