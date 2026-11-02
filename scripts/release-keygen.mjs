#!/usr/bin/env node
// Generates the offline release signing key. Run once on a trusted machine; keep release-signing.pem offline.
// Put the printed public key into RELEASE_PUBLIC_KEYS in src/update/release-signature.ts.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'release-signing.pem';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
console.log(`private key written to ${out} (keep it offline)`);
console.log(`public key (base64url SPKI): ${publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`);
