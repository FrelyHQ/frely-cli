#!/usr/bin/env node
// Fails unless every released executable has a checksum and a valid offline signature.
// usage: node scripts/release-verify-signatures.mjs <dir> <version>      (a directory of frely-* assets)
//        node scripts/release-verify-signatures.mjs --release <vX.Y.Z>    (downloads the published GitHub Release assets with gh)
// The trusted public keys are the ones the CLI itself trusts (src/update/release-signature.ts).
import { createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function trustedKeys() {
  const source = readFileSync(join(root, 'src/update/release-signature.ts'), 'utf8');
  const match = /RELEASE_PUBLIC_KEYS: readonly string\[\] = \[([^\]]*)\]/u.exec(source);
  const keys = [...(match?.[1] ?? '').matchAll(/"([A-Za-z0-9_-]+)"/gu)].map((m) => m[1]);
  if (keys.length === 0) throw new Error('No trusted release public key found in src/update/release-signature.ts');
  return keys;
}

const message = (version, asset, sha256) => Buffer.from(`frely.release.v1\n${version}\n${asset}\n${sha256.toLowerCase()}\n`);

/** Returns a list of problems; empty means every executable asset is checksummed and validly signed. */
export function signatureProblems(dir, version, keys = trustedKeys()) {
  const files = readdirSync(dir);
  // An executable asset is frely-<target>[.exe][.gz]; the checksum and signature belong to the decompressed executable.
  const assets = [...new Set(files.filter((f) => /^frely-.+/u.test(f) && !/\.(sha256|sig)$/u.test(f)).map((f) => f.replace(/\.gz$/u, '')))];
  if (assets.length === 0) return [`no frely-* assets found in ${dir}`];
  const problems = [];
  for (const asset of assets) {
    const checksum = `${asset}.sha256`, sigFile = `${checksum}.sig`;
    if (!existsSync(join(dir, checksum))) { problems.push(`${asset}: missing ${checksum}`); continue; }
    if (!existsSync(join(dir, sigFile))) { problems.push(`${asset}: missing ${sigFile}`); continue; }
    const hash = readFileSync(join(dir, checksum), 'utf8').trim().split(/\s+/u)[0] ?? '';
    if (!/^[0-9a-f]{64}$/iu.test(hash)) { problems.push(`${asset}: invalid checksum file`); continue; }
    const signature = Buffer.from(readFileSync(join(dir, sigFile), 'utf8').trim(), 'base64url');
    const ok = keys.some((key) => {
      try { return verify(null, message(version, asset, hash), createPublicKey({ key: Buffer.from(key, 'base64url'), format: 'der', type: 'spki' }), signature); } catch { return false; }
    });
    if (!ok) problems.push(`${asset}: signature does not verify against a trusted key`);
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let dir, version, cleanup;
  if (args[0] === '--release' && args[1]) {
    const tag = args[1];
    version = tag.replace(/^v/u, '');
    dir = mkdtempSync(join(tmpdir(), 'frely-release-sig-'));
    cleanup = () => rmSync(dir, { recursive: true, force: true });
    // Only the small checksum and signature files are downloaded; the executables are known from the asset list (an empty placeholder stands for each).
    const names = JSON.parse(execFileSync('gh', ['release', 'view', tag, '-R', 'FrelyHQ/frely-cli', '--json', 'assets'], { encoding: 'utf8' })).assets.map((a) => a.name);
    for (const name of names) if (/^frely-/u.test(name) && !/\.(sha256|sig)$/u.test(name)) writeFileSync(join(dir, name), '');
    execFileSync('gh', ['release', 'download', tag, '-R', 'FrelyHQ/frely-cli', '-p', 'frely-*.sha256*', '-D', dir, '--clobber'], { stdio: 'inherit' });
  } else [dir, version] = args;
  if (!dir || !version) throw new Error('usage: release-verify-signatures.mjs <dir> <version> | --release <tag>');
  const problems = signatureProblems(dir, version);
  cleanup?.();
  if (problems.length > 0) { console.error(`Release ${version} is not fully signed:\n${problems.map((p) => `  - ${p}`).join('\n')}`); process.exit(1); }
  console.log(`Release ${version}: every executable asset has a valid signature.`);
}
