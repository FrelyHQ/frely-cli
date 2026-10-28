import assert from "node:assert/strict";
import test from "node:test";
import { isApprovableHost, ManifestError, parseManifest } from "./manifest.js";

test("a frely.yaml with a local section gives the run command, setup and the extra sites", () => {
  const manifest = parseManifest("name: My Agent\nlocal:\n  setup: uv sync\n  run: uv run main.py\n  network:\n    - pypi.org\n    - files.pythonhosted.org\n    - pypi.org\n");
  assert.deepEqual(manifest, { name: "My Agent", setup: "uv sync", run: "uv run main.py", network: ["pypi.org", "files.pythonhosted.org"] });
});

test("only local.run is required", () => {
  assert.deepEqual(parseManifest("local:\n  run: node index.js\n"), { name: undefined, setup: undefined, run: "node index.js", network: [] });
});

test("a repository without a local section says what to add", () => {
  assert.throws(() => parseManifest("name: x\ndockerfile: Dockerfile\n"), /no local: section.*local\.run/u);
  assert.throws(() => parseManifest("local:\n  setup: make\n"), /local\.run is required/u);
});

test("commands are one short line", () => {
  assert.throws(() => parseManifest("local:\n  run: |\n    a\n    b\n"), /one line/u);
  assert.throws(() => parseManifest(`local:\n  run: ${"x".repeat(501)}\n`), /one line/u);
  assert.throws(() => parseManifest("local:\n  run: 5\n"), ManifestError);
});

test("sites must be exact names, never wildcards, ports or addresses", () => {
  for (const bad of ["*.pypi.org", "pypi.org:443", "127.0.0.1", "10.0.0.1", "localhost", "evil.localhost", "printer.local", "https://pypi.org", "a b.com", "PyPI.org"]) {
    assert.throws(() => parseManifest(`local:\n  run: x\n  network: ["${bad}"]\n`), /exact site name/u, bad);
  }
  assert.equal(isApprovableHost("api.github.com"), true);
  assert.equal(isApprovableHost("localhost"), false);
  assert.throws(() => parseManifest(`local:\n  run: x\n  network: [${Array.from({ length: 21 }, (_, i) => `s${i}.example.com`).join(", ")}]\n`), /at most 20/u);
});

test("invalid or oversized YAML is refused", () => {
  assert.throws(() => parseManifest("local: [unclosed"), /not valid YAML/u);
  assert.throws(() => parseManifest("- just\n- a list\n"), /must be a mapping/u);
  assert.throws(() => parseManifest("# " + "x".repeat(70 * 1024)), /larger than 64 KiB/u);
  assert.throws(() => parseManifest("a: &x [1]\nlocal:\n  run: *x\n"), ManifestError);
});
