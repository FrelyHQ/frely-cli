// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, cp, readFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('new HTML requests changed assets under new URLs, consistently across all language routes', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temp = await mkdtemp(resolve(tmpdir(), 'frely-site-assets-'));
  try {
    await cp(resolve(root, 'site'), resolve(temp, 'site'), { recursive: true });
    for (const name of ['LICENSE', 'NOTICE', 'TRADEMARKS.md']) await cp(resolve(root, name), resolve(temp, name));
    const assets = ['app.js', 'locale.js', 'styles.css'];
    async function build() {
      execFileSync(process.execPath, [resolve(temp, 'site/build.mjs')]);
      const versions = {};
      for (const route of ['', 'en/', 'zh/']) {
        const html = await readFile(resolve(temp, '_site', route, 'index.html'), 'utf8');
        assert.equal(html.includes('{{'), false);
        const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => new URL(match[1], 'https://cli.frely.cloud/' + route));
        for (const asset of assets) {
          const url = urls.find((value) => value.pathname === '/' + asset);
          assert.ok(url, route + ': asset referenced');
          assert.ok(url.searchParams.get('v'), route + ': versioned cache key');
          assert.equal(await readFile(resolve(temp, '_site', asset), 'utf8'), await readFile(resolve(temp, 'site', asset), 'utf8'));
          if (versions[asset]) assert.equal(url.href, versions[asset]);
          versions[asset] = url.href;
        }
      }
      return versions;
    }
    const first = await build();
    assert.deepEqual(await build(), first, 'unchanged content keeps cache URLs stable');
    for (const asset of assets) await appendFile(resolve(temp, 'site', asset), '\n/* next deployment */\n');
    const changed = await build();
    for (const asset of assets) assert.notEqual(changed[asset], first[asset], asset + ': old cached bytes cannot satisfy the new URL');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
