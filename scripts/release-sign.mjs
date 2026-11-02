#!/usr/bin/env node
// Signs every artifacts/frely-*.sha256 as <asset>.sha256.sig (Ed25519 over version, asset and hash).
// usage: FRELY_RELEASE_SIGNING_KEY=<pem path> node scripts/release-sign.mjs <artifacts-dir> <version>
// Without the key variable nothing is signed (signing is record-only until the owner enables it).
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function signingMessage(version, asset, sha256) {
  return Buffer.from(`frely.release.v1\n${version}\n${asset}\n${sha256.toLowerCase()}\n`);
}

export function signArtifacts(artifacts, version, keyPem) {
  const key = createPrivateKey(keyPem);
  const signed = [];
  for (const file of readdirSync(artifacts).filter((name) => /^frely-.*\.sha256$/u.test(name))) {
    const asset = file.replace(/\.sha256$/u, '');
    const hash = readFileSync(join(artifacts, file), 'utf8').trim().split(/\s+/u)[0];
    if (!/^[0-9a-f]{64}$/iu.test(hash ?? '')) throw new Error(`Invalid checksum in ${file}`);
    writeFileSync(join(artifacts, `${file}.sig`), `${sign(null, signingMessage(version, asset, hash), key).toString('base64url')}\n`);
    signed.push(asset);
  }
  return signed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [artifacts, version] = process.argv.slice(2);
  if (!artifacts || !version) throw new Error('usage: release-sign.mjs <artifacts-dir> <version>');
  const keyPath = process.env.FRELY_RELEASE_SIGNING_KEY;
  if (!keyPath) { console.log('FRELY_RELEASE_SIGNING_KEY is not set; release not signed'); process.exit(0); }
  console.log(`signed: ${signArtifacts(artifacts, version, readFileSync(keyPath)).join(', ')}`);
}
