import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPlatformPackages, TARGETS } from './release-platform-packages.mjs';

test('one package per release target with the executable and its checksum', () => {
  const artifacts = mkdtempSync(join(tmpdir(), 'frely-artifacts-'));
  for (const target of Object.keys(TARGETS)) {
    const asset = `frely-${target}${target.startsWith('windows') ? '.exe' : ''}`;
    writeFileSync(join(artifacts, asset), target);
    writeFileSync(join(artifacts, `${asset}.sha256`), `${createHash('sha256').update(target).digest('hex')}  ${asset}\n`);
  }
  const directories = buildPlatformPackages(artifacts, '1.2.3', mkdtempSync(join(tmpdir(), 'frely-packages-')));
  assert.equal(directories.length, 8);
  const musl = JSON.parse(readFileSync(join(directories.find((d) => d.endsWith('linux-x64-musl')), 'package.json'), 'utf8'));
  assert.deepEqual([musl.name, musl.version, musl.os, musl.cpu, musl.libc], ['@frelyhq/cli-linux-x64-musl', '1.2.3', ['linux'], ['x64'], ['musl']]);
  const windows = directories.find((d) => d.endsWith('windows-x64'));
  assert.match(readFileSync(join(windows, 'frely.exe.sha256'), 'utf8'), /^[0-9a-f]{64} {2}frely\.exe\n$/u);
  assert.throws(() => buildPlatformPackages(artifacts, 'v1', mkdtempSync(join(tmpdir(), 'x-'))), /Invalid version/u);
});
