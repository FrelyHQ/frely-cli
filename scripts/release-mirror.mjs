import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Upload one release to the static mirror: <MIRROR_PATH>/v<version>/<assets>, then <MIRROR_PATH>/latest.
// `latest` is written last and only for stable versions, so a client that reads it always finds a complete directory.
const [artifacts, version] = process.argv.slice(2);
if (!artifacts || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/u.test(version ?? '')) {
  throw new Error('Usage: release-mirror.mjs <artifacts-dir> <version>');
}
const { MIRROR_HOST: host, MIRROR_USER: user, MIRROR_PATH: base } = process.env;
if (!host || !user || !base?.startsWith('/')) throw new Error('MIRROR_HOST, MIRROR_USER and an absolute MIRROR_PATH are required.');
const files = readdirSync(artifacts).filter((name) => /^(frely-.+|install\.(sh|ps1)|start\.(sh|ps1))$/u.test(name));
if (!files.some((name) => name.endsWith('.sha256'))) throw new Error('No release assets found.');
const ssh = ['-i', join(process.env.HOME, '.ssh/mirror_key'), '-o', 'StrictHostKeyChecking=yes'];
const target = `${user}@${host}`;
const sh = (...args) => execFileSync('ssh', [...ssh, target, ...args], { stdio: 'inherit' });
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const directory = `${base.replace(/\/+$/u, '')}/v${version}`;
sh(`mkdir -p ${quote(directory)}`);
execFileSync('rsync', ['-av', '-e', `ssh ${ssh.join(' ')}`, ...files.map((name) => join(artifacts, name)), `${target}:${directory}/`], { stdio: 'inherit' });
if (!version.includes('-')) {
  const latest = join(mkdtempSync(join(tmpdir(), 'frely-mirror-')), 'latest');
  writeFileSync(latest, `${version}\n`);
  execFileSync('rsync', ['-av', '-e', `ssh ${ssh.join(' ')}`, latest, `${target}:${base.replace(/\/+$/u, '')}/latest`], { stdio: 'inherit' });
}
