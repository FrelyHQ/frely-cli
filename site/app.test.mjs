// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const script = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
function fixture({ url = 'https://cli.frely.cloud/zh/?ref=docs#install', lang = 'zh-CN', copyFails = false, storageBlocked = false } = {}) {
  const messages = JSON.parse(readFileSync(new URL('./locales/' + lang + '.json', import.meta.url), 'utf8'));
  const location = new URL(url);
  const events = new Map();
  const timers = [];
  const saved = [];
  let copied;
  let selected;
  const element = (attrs = {}, extra = {}) => ({
    attrs, events: new Map(), ...extra,
    getAttribute(name) { return this.attrs[name]; },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, callback) { this.events.set(name, callback); },
    focus() { this.focused = true; },
    scrollIntoView() { this.scrolled = true; },
  });
  const tabs = ['tools', 'agents', 'models'].map((name) => element({ 'aria-controls': 'panel-' + name, 'aria-selected': String(name === 'tools') }));
  const panels = Object.fromEntries(tabs.map((tab, index) => [tab.getAttribute('aria-controls'), element({}, { hidden: index !== 0 })]));
  const links = ['en', 'zh'].map((language) => element({}, { href: new URL('../' + language + '/', location).href, dataset: { language } }));
  const command = { textContent: ' frely doctor ' };
  const button = element({}, { dataset: { copy: 'doctor-command' }, textContent: messages['copy.idle'] });
  const status = { textContent: '', dataset: Object.fromEntries(['idle', 'copied', 'selected', 'success', 'failure'].map((key) => [key, messages['copy.' + key]])) };
  runInNewContext(script, {
    URL,
    document: {
      querySelectorAll(selector) { return selector === '[role="tab"]' ? tabs : selector === '[data-copy]' ? [button] : links; },
      getElementById(id) { return id === 'copy-status' ? status : id === 'doctor-command' ? command : panels[id]; },
      createRange() { return { selectNodeContents(node) { selected = node; } }; },
    },
    navigator: { clipboard: { async writeText(value) { if (copyFails) throw new Error('Denied'); copied = value; } } },
    window: {
      location,
      localStorage: { setItem(key, value) { if (storageBlocked) throw new Error('Blocked'); saved.push([key, value]); } },
      addEventListener(name, callback) { events.set(name, callback); },
      getSelection() { return { removeAllRanges() {}, addRange() {} }; },
      setTimeout(callback) { timers.push(callback); },
    },
  });
  return { location, links, tabs, panels, button, status, command, saved, timers,
    copied: () => copied, selected: () => selected,
    hash(value) { location.hash = value; events.get('hashchange')(); },
  };
}

test('language links retain queries and updated anchors on project paths even with blocked storage', () => {
  const f = fixture({ url: 'https://frelyhq.github.io/frely-cli/zh/?ref=docs#install', storageBlocked: true });
  assert.equal(f.links[0].href, 'https://frelyhq.github.io/frely-cli/en/?ref=docs#install');
  f.hash('#panel-models');
  assert.equal(f.links[0].href, 'https://frelyhq.github.io/frely-cli/en/?ref=docs#panel-models');
  assert.doesNotThrow(() => f.links[0].events.get('click')());
  const enabled = fixture();
  enabled.links[0].events.get('click')();
  assert.deepEqual(enabled.saved, [['frely-cli-language', 'en']]);
});

test('direct workflow links reveal the right panel on load, hash changes and language switches', () => {
  const f = fixture({ url: 'https://cli.frely.cloud/en/?ref=docs#panel-models' });
  assert.equal(f.panels['panel-models'].hidden, false);
  assert.equal(f.panels['panel-tools'].hidden, true);
  assert.equal(f.panels['panel-models'].scrolled, true);
  assert.equal(f.tabs[2].attrs['aria-selected'], 'true');
  const translated = fixture({ url: f.links[1].href });
  assert.equal(translated.panels['panel-models'].hidden, false);
  f.hash('#panel-tools');
  assert.equal(f.panels['panel-tools'].hidden, false);
  assert.equal(f.panels['panel-models'].hidden, true);
});

for (const lang of ['en', 'zh-CN']) {
  test(lang + ' copy success and denied clipboard use localized feedback', async () => {
    const messages = JSON.parse(readFileSync(new URL('./locales/' + lang + '.json', import.meta.url), 'utf8'));
    const success = fixture({ lang });
    await success.button.events.get('click')();
    assert.equal(success.copied(), 'frely doctor');
    assert.equal(success.status.textContent, messages['copy.success']);
    assert.equal(success.button.textContent, messages['copy.copied']);
    success.timers[0]();
    assert.equal(success.button.textContent, messages['copy.idle']);
    const failure = fixture({ lang, copyFails: true });
    await failure.button.events.get('click')();
    assert.equal(failure.selected(), failure.command);
    assert.equal(failure.status.textContent, messages['copy.failure']);
    assert.equal(failure.button.textContent, messages['copy.selected']);
  });
}
