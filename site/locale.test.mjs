// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const script = readFileSync(new URL('./locale.js', import.meta.url), 'utf8');
function visit({ entry = true, languages = ['en-US'], language = 'en-US', saved, storageBlocked = false, url = 'https://cli.frely.cloud/' } = {}) {
  let redirect;
  const location = new URL(url);
  runInNewContext(script, {
    URL,
    document: { documentElement: { dataset: { localeEntry: String(entry) } } },
    navigator: { languages, language },
    window: {
      localStorage: { getItem() { if (storageBlocked) throw new Error('Storage blocked'); return saved; } },
      location: { href: location.href, search: location.search, hash: location.hash, replace(value) { redirect = value; } },
    },
  });
  return redirect;
}

test('Chinese browser variants select Chinese and unsupported languages fall back to English', () => {
  for (const language of ['zh', 'zh-CN', 'zh-TW', 'zh-Hant-HK']) {
    assert.equal(visit({ languages: [language] }), 'https://cli.frely.cloud/zh/');
  }
  assert.equal(visit({ languages: ['fr-FR', 'de-DE'] }), 'https://cli.frely.cloud/en/');
  assert.equal(visit({ languages: ['fr-FR', 'zh-CN', 'en-US'] }), 'https://cli.frely.cloud/zh/');
  assert.equal(visit({ languages: ['en-US', 'zh-CN'] }), 'https://cli.frely.cloud/en/');
  assert.equal(visit({ languages: [], language: 'zh-CN' }), 'https://cli.frely.cloud/zh/');
});

test('manual preference wins; disabled storage and invalid preferences remain usable', () => {
  assert.equal(visit({ languages: ['zh-CN'], saved: 'en' }), 'https://cli.frely.cloud/en/');
  assert.equal(visit({ saved: 'zh' }), 'https://cli.frely.cloud/zh/');
  assert.equal(visit({ languages: ['zh-CN'], saved: 'invalid' }), 'https://cli.frely.cloud/zh/');
  assert.equal(visit({ languages: ['zh-CN'], storageBlocked: true }), 'https://cli.frely.cloud/zh/');
});

test('explicit locale URLs are stable regardless of preference or browser language', () => {
  assert.equal(visit({ entry: false, saved: 'en', url: 'https://cli.frely.cloud/zh/' }), undefined);
  assert.equal(visit({ entry: false, languages: ['zh-CN'], url: 'https://cli.frely.cloud/en/' }), undefined);
});

test('entry redirect preserves query strings, anchors and GitHub project subpaths', () => {
  assert.equal(visit({ languages: ['zh-CN'], url: 'https://cli.frely.cloud/?ref=docs#install' }), 'https://cli.frely.cloud/zh/?ref=docs#install');
  assert.equal(visit({ saved: 'zh', url: 'https://frelyhq.github.io/frely-cli/index.html#workflows' }), 'https://frelyhq.github.io/frely-cli/zh/#workflows');
});
