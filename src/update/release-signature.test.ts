import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReleaseSignature, releaseSigningMessage } from "./release-signature.js";
import { prepareStandalone } from "./update.js";
import { standaloneAsset } from "./release.js";

const pair = generateKeyPairSync("ed25519");
const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const signed = (version: string, asset: string, body: string) => sign(null, releaseSigningMessage(version, asset, hash(body)), pair.privateKey).toString("base64url");

test("signature check: verified, unsigned (record-only), invalid and required-missing", () => {
  const checksumText = `${hash("bin")}  frely\n`;
  const base = { version: "1.0.0", asset: "frely-linux-x64", checksumText, keys: [publicKey] };
  assert.equal(checkReleaseSignature({ ...base, signature: signed("1.0.0", "frely-linux-x64", "bin") }), "verified");
  assert.equal(checkReleaseSignature({ ...base, signature: undefined }), "unsigned");
  assert.equal(checkReleaseSignature({ ...base, keys: [], signature: undefined }), "unsigned");
  assert.throws(() => checkReleaseSignature({ ...base, signature: undefined, required: true }), /not signed/u);
  assert.throws(() => checkReleaseSignature({ ...base, keys: [], signature: undefined, required: true }), /No release signing key/u);
  assert.throws(() => checkReleaseSignature({ ...base, signature: signed("1.0.1", "frely-linux-x64", "bin") }), /signature is invalid/u);
  assert.throws(() => checkReleaseSignature({ ...base, signature: signed("1.0.0", "frely-darwin-arm64", "bin") }), /signature is invalid/u);
  assert.throws(() => checkReleaseSignature({ ...base, checksumText: `${hash("evil")}  frely\n`, signature: signed("1.0.0", "frely-linux-x64", "bin") }), /signature is invalid/u);
});

test("an update whose executable or checksum was swapped fails and leaves the installation untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "frely-signed-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, "frely"); await writeFile(entry, "old");
  const asset = standaloneAsset();
  const prepare = (body: string, checksumBody: string, signature: string | undefined, keys = [publicKey]) => prepareStandalone({ method: "standalone", entry, platform: "linux" },
    { version: "1.2.3", sources: [{ kind: "github", baseUrl: "https://example.invalid" }] },
    async (url, path) => {
      if (url.endsWith(".sig")) { if (signature === undefined) throw new Error("404"); await writeFile(path, signature); return; }
      await writeFile(path, url.endsWith(".sha256") ? `${hash(checksumBody)}  frely\n` : body);
    }, async () => "1.2.3", undefined, { keys });
  const good = signed("1.2.3", asset, "new");
  await (await prepare("new", "new", good)).cleanup();
  await (await prepare("new", "new", undefined)).cleanup();
  // An attacker who controls the download source swaps both binary and checksum: the checksum matches, the signature cannot.
  await assert.rejects(prepare("evil", "evil", good), /signature is invalid/u);
  await assert.rejects(prepare("evil", "evil", signed("1.2.3", asset, "other")), /signature is invalid/u);
  assert.equal(await readFile(entry, "utf8"), "old");
});
