import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// One npm package per release target: @frelyhq/cli-<target> holds package/frely[.exe] and its .sha256.
// install.sh / install.ps1 and `frely update` download these tarballs from npmmirror or npmjs when GitHub is unreachable.
export const TARGETS = {
  'darwin-arm64': { os: 'darwin', cpu: 'arm64' },
  'darwin-x64': { os: 'darwin', cpu: 'x64' },
  'linux-arm64': { os: 'linux', cpu: 'arm64', libc: 'glibc' },
  'linux-x64': { os: 'linux', cpu: 'x64', libc: 'glibc' },
  'linux-arm64-musl': { os: 'linux', cpu: 'arm64', libc: 'musl' },
  'linux-x64-musl': { os: 'linux', cpu: 'x64', libc: 'musl' },
  'windows-arm64': { os: 'win32', cpu: 'arm64' },
  'windows-x64': { os: 'win32', cpu: 'x64' },
};

export function platformPackageName(target) { return `@frelyhq/cli-${target}`; }

export function buildPlatformPackages(artifacts, version, output) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error(`Invalid version: ${version}`);
  const root = resolve(process.cwd(), 'package.json');
  const { license, repository, homepage } = JSON.parse(readFileSync(root, 'utf8'));
  const directories = [];
  for (const [target, platform] of Object.entries(TARGETS)) {
    const windows = target.startsWith('windows');
    const asset = `frely-${target}${windows ? '.exe' : ''}`;
    const binary = windows ? 'frely.exe' : 'frely';
    const directory = join(output, target);
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    copyFileSync(join(artifacts, asset), join(directory, binary));
    const hash = readFileSync(join(artifacts, `${asset}.sha256`), 'utf8').trim().split(/\s+/u)[0];
    if (!/^[0-9a-f]{64}$/iu.test(hash ?? '')) throw new Error(`Invalid checksum for ${asset}`);
    writeFileSync(join(directory, `${binary}.sha256`), `${hash.toLowerCase()}  ${binary}\n`);
    writeFileSync(join(directory, 'package.json'), `${JSON.stringify({
      name: platformPackageName(target), version,
      description: `Frely CLI executable for ${target}. Installed by https://frely.cloud/install.sh; not meant to be required.`,
      license, repository, homepage,
      os: [platform.os], cpu: [platform.cpu], ...(platform.libc ? { libc: [platform.libc] } : {}),
      files: [binary, `${binary}.sha256`],
      preferUnplugged: true,
    }, null, 2)}\n`);
    directories.push(directory);
  }
  return directories;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [artifacts, version, ...flags] = process.argv.slice(2);
  if (!artifacts || !version) throw new Error('Usage: release-platform-packages.mjs <artifacts-dir> <version> [--publish]');
  const directories = buildPlatformPackages(resolve(artifacts), version, resolve('platform-packages'));
  if (flags.includes('--publish')) {
    const tag = version.includes('-') ? 'next' : 'latest';
    for (const directory of directories) execFileSync('npm', ['publish', '--access', 'public', '--tag', tag], { cwd: directory, stdio: 'inherit' });
  } else process.stdout.write(`${directories.join('\n')}\n`);
}
