import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signArtifacts } from "./release-sign.mjs";
import { signatureProblems, trustedKeys } from "./release-verify-signatures.mjs";

function release(t) {
  const dir = mkdtempSync(join(tmpdir(), "frely-sig-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  for (const asset of ["frely-linux-x64", "frely-windows-x64.exe"]) {
    writeFileSync(join(dir, `${asset}.gz`), "gz");
    writeFileSync(join(dir, `${asset}.sha256`), `${createHash("sha256").update(asset).digest("hex")}  ${asset}\n`);
  }
  signArtifacts(dir, "1.2.3", privateKey.export({ format: "pem", type: "pkcs8" }));
  return { dir, key };
}

test("a fully signed release has no problems", (t) => {
  const { dir, key } = release(t);
  assert.deepEqual(signatureProblems(dir, "1.2.3", [key]), []);
});

test("a missing signature fails", (t) => {
  const { dir, key } = release(t);
  rmSync(join(dir, "frely-linux-x64.sha256.sig"));
  assert.match(signatureProblems(dir, "1.2.3", [key]).join("\n"), /frely-linux-x64: missing .*\.sig/u);
});

test("a signature for another version or an untrusted key fails", (t) => {
  const { dir, key } = release(t);
  assert.equal(signatureProblems(dir, "1.2.4", [key]).length, 2);
  const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  assert.equal(signatureProblems(dir, "1.2.3", [other]).length, 2);
});

test("a missing checksum fails and an empty directory fails", (t) => {
  const { dir, key } = release(t);
  rmSync(join(dir, "frely-windows-x64.exe.sha256"));
  assert.match(signatureProblems(dir, "1.2.3", [key]).join("\n"), /missing frely-windows-x64\.exe\.sha256/u);
  const empty = mkdtempSync(join(tmpdir(), "frely-sig-empty-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  assert.match(signatureProblems(empty, "1.2.3", [key])[0], /no frely-\* assets/u);
});

test("reads the key the CLI trusts", () => assert.ok(trustedKeys().length >= 1));
