// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, cp, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The build reads the docs pages from a fixture checkout instead of fetching the pinned commit.
const buildSite = (temp, options = {}) => execFileSync(process.execPath, [resolve(temp, 'site/build.mjs')], { ...options, env: { ...process.env, DOCS_DIR: resolve(temp, 'site/test-docs') } });

test('new HTML requests changed assets under new URLs, consistently across all language routes', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temp = await mkdtemp(resolve(tmpdir(), 'frely-site-assets-'));
  try {
    await cp(resolve(root, 'site'), resolve(temp, 'site'), { recursive: true });
    for (const name of ['LICENSE', 'NOTICE', 'TRADEMARKS.md', 'install.sh', 'install.ps1', 'start.sh', 'start.ps1']) await cp(resolve(root, name), resolve(temp, name));
    const assets = ['app.js', 'locale.js', 'styles.css'];
    async function build() {
      buildSite(temp);
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

test('component, command and translation errors preserve the last valid site output', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temp = await mkdtemp(resolve(tmpdir(), 'frely-site-validation-'));
  try {
    await cp(resolve(root, 'site'), resolve(temp, 'site'), { recursive: true });
    for (const name of ['LICENSE', 'NOTICE', 'TRADEMARKS.md', 'install.sh', 'install.ps1', 'start.sh', 'start.ps1']) await cp(resolve(root, name), resolve(temp, name));
    const build = () => buildSite(temp, { stdio: 'pipe' });
    build();
    const output = resolve(temp, '_site/zh/index.html');
    const before = await readFile(output, 'utf8');
    for (const [path, mutate, message] of [
      ['site/template.html', (text) => text + '\n{{> missing-section}}', /ENOENT/],
      ['site/commands.json', (text) => { const data = JSON.parse(text); data.install = ''; return JSON.stringify(data); }, /Missing or empty command/],
      ['site/locales/zh-CN.json', (text) => { const data = JSON.parse(text); delete data['hero.line1']; return JSON.stringify(data); }, /missing\/empty translations/],
    ]) {
      const file = resolve(temp, path);
      const original = await readFile(file, 'utf8');
      await writeFile(file, mutate(original));
      assert.throws(build, (error) => message.test(error.stderr.toString()));
      assert.equal(await readFile(output, 'utf8'), before);
      await writeFile(file, original);
    }
    const commandsPath = resolve(temp, 'site/commands.json');
    const commands = JSON.parse(await readFile(commandsPath, 'utf8'));
    commands.install = 'echo "<preview>&"';
    await writeFile(commandsPath, JSON.stringify(commands));
    build();
    assert.match(await readFile(output, 'utf8'), /echo &quot;&lt;preview&gt;&amp;&quot;/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('docs pages are static, crawlable and listed in the sitemap', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temp = await mkdtemp(resolve(tmpdir(), 'frely-site-docs-'));
  try {
    await cp(resolve(root, 'site'), resolve(temp, 'site'), { recursive: true });
    for (const name of ['LICENSE', 'NOTICE', 'TRADEMARKS.md', 'install.sh', 'install.ps1', 'start.sh', 'start.ps1']) await cp(resolve(root, name), resolve(temp, name));
    buildSite(temp);
    const sitemap = await readFile(resolve(temp, '_site/sitemap.xml'), 'utf8');
    const index = await readFile(resolve(temp, '_site/docs/index.html'), 'utf8');
    const help = await readFile(resolve(temp, '_site/docs/help/index.html'), 'utf8');
    for (const path of ['/', '/zh/', '/docs/', '/docs/help/']) assert.ok(sitemap.includes(`<loc>https://cli.frely.cloud${path}</loc>`), 'sitemap lists ' + path);
    assert.ok(!sitemap.includes('https://cli.frely.cloud/en/'), 'sitemap lists the English root, not /en/');
    // English is canonical at the root; /en/ is a duplicate that points there.
    for (const [route, canonical] of [['', '/'], ['en', '/'], ['zh', '/zh/']]) {
      const html = await readFile(resolve(temp, '_site', route, 'index.html'), 'utf8');
      assert.ok(html.includes(`<link rel="canonical" href="https://cli.frely.cloud${canonical}">`), (route || 'root') + ': canonical ' + canonical);
      assert.ok(html.includes('<link rel="alternate" hreflang="en" href="https://cli.frely.cloud/">'), (route || 'root') + ': hreflang en is the root');
      assert.ok(html.includes('<meta property="og:image" content="https://cli.frely.cloud/assets/og.png">'), (route || 'root') + ': og:image');
    }
    assert.ok((await readFile(resolve(temp, '_site/assets/og.png'))).length > 0, 'og:image is published');
    const notFound = await readFile(resolve(temp, '_site/404.html'), 'utf8');
    assert.ok(notFound.includes('noindex'), '404 page is not indexed');
    for (const path of ['/', '/zh/', '/docs/', '/#install']) assert.ok(notFound.includes(`href="${path}"`), `404 page links to ${path}`);
    const slugs = ['first-question', 'second-question', 'third-question'];
    // Categories appear in the order of their first page; pages sort by `order`.
    assert.ok(index.indexOf('<h2>Getting started</h2>') < index.indexOf('<h2>Maintenance</h2>'), 'categories follow page order');
    assert.ok(index.indexOf('/docs/help/first-question/') < index.indexOf('/docs/help/third-question/'), 'pages follow order');
    for (const slug of slugs) {
      const entry = { slug };
      const page = await readFile(resolve(temp, '_site/docs/help', entry.slug, 'index.html'), 'utf8');
      assert.ok(page.includes('<h1>'), entry.slug + ': page has a heading');
      assert.ok(index.includes(`/docs/help/${entry.slug}/`), entry.slug + ': linked from index');
      assert.ok(help.includes(`id="${entry.slug}"`), entry.slug + ': listed on help page');
      assert.ok(sitemap.includes(`/docs/help/${entry.slug}/`), entry.slug + ': in sitemap');
    }
    const first = await readFile(resolve(temp, '_site/docs/help/first-question/index.html'), 'utf8');
    assert.ok(first.includes('Run <code>frely doctor</code> first.'), 'inline code renders');
    assert.ok(first.includes('<a href="https://example.test/guide?a=1&amp;b=2">guide</a> for &lt;details&gt; &amp; more.'), 'links render and text is escaped');
    assert.ok(first.includes('<ul><li>First item with <code>code</code></li><li>Second item</li></ul>'), 'lists render');
    assert.ok(first.includes('<ul class="links"><li><a href="https://cli.frely.cloud/#install">Install page</a></li><li><a href="https://example.test/README.md">README</a></li></ul>'), 'related links render in order');
    assert.ok(first.includes('content="Run frely doctor first. See the guide for &lt;details&gt; &amp; more.'), 'description is plain text');
    // Pages that belong to frely.cloud are not rendered here; the index links to them.
    assert.ok(index.includes('<h2>On frely.cloud</h2>'), 'index has the frely.cloud group');
    for (const href of ['https://frely.cloud/docs/frely-guide/', 'https://frely.cloud/docs/faq/frely-faq/']) assert.ok(index.includes(`href="${href}"`), 'index links ' + href);
    assert.ok(index.indexOf('frely-guide') < index.indexOf('frely-faq'), 'guides come before FAQ pages');
    assert.ok(!sitemap.includes('frely-guide') && !sitemap.includes('frely-faq'), 'sitemap lists only pages of this site');
    await assert.rejects(readFile(resolve(temp, '_site/docs/help/frely-guide/index.html')), 'frely pages have no page here');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('header has a no-JavaScript Products dropdown with the current product marked', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temp = await mkdtemp(resolve(tmpdir(), 'frely-site-products-'));
  try {
    await cp(resolve(root, 'site'), resolve(temp, 'site'), { recursive: true });
    for (const name of ['LICENSE', 'NOTICE', 'TRADEMARKS.md', 'install.sh', 'install.ps1', 'start.sh', 'start.ps1']) await cp(resolve(root, name), resolve(temp, name));
    buildSite(temp);
    for (const route of ['en', 'zh']) {
      const html = await readFile(resolve(temp, '_site', route, 'index.html'), 'utf8');
      const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
      assert.ok(header.includes('<details class="nav-products">') && header.includes('<summary>'), route + ': dropdown uses details');
      for (const href of ['https://frely.cloud/"', 'https://frely.cloud/app/"']) assert.ok(header.includes(`href="${href}`), route + ': links ' + href);
      assert.equal(header.match(/aria-current="page"><span class="product-name">/g)?.length, 1, route + ': one current product');
      assert.ok(header.includes('aria-current="page"><span class="product-name">Frely CLI'), route + ': CLI is current');
      assert.ok(!header.includes('nav-app'), route + ': no Desktop app header link');
      assert.ok(html.includes('<footer') && html.slice(html.indexOf('<footer')).includes('https://frely.cloud/app/'), route + ': footer keeps app link');
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('the landing page leads with the Skill install and keeps frely mcp start in the FrelyMCP section', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temp = await mkdtemp(resolve(tmpdir(), 'frely-site-skill-'));
  try {
    await cp(resolve(root, 'site'), resolve(temp, 'site'), { recursive: true });
    for (const name of ['LICENSE', 'NOTICE', 'TRADEMARKS.md', 'install.sh', 'install.ps1', 'start.sh', 'start.ps1']) await cp(resolve(root, name), resolve(temp, name));
    buildSite(temp);
    for (const route of ['en/', 'zh/']) {
      const html = await readFile(resolve(temp, '_site', route, 'index.html'), 'utf8');
      const card = html.slice(html.indexOf('id="install"'), html.indexOf('id="skill"'));
      assert.ok(card.includes('frely skill install --host'), route + ': install card shows the Skill command');
      assert.equal(card.includes('frely.cloud/start.'), false, route + ': install card does not run the start script that enables Device MCP');
      assert.ok(html.indexOf('frely.cloud/start.sh') > html.indexOf('id="get-started"'), route + ': the start script sits in the FrelyMCP section');
      assert.ok(html.indexOf('id="skill"') < html.indexOf('id="get-started"'), route + ': Skill section comes before FrelyMCP');
      const figure = html.match(/<figure class="skill-demo"[^>]*>/);
      assert.ok(figure && /role="img"/.test(figure[0]) && /aria-label="[^"]+"/.test(figure[0]), route + ': Skill walkthrough has an accessible label');
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('a docs page with an unknown site or no category stops the build', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temp = await mkdtemp(resolve(tmpdir(), 'frely-site-docs-invalid-'));
  try {
    await cp(resolve(root, 'site'), resolve(temp, 'site'), { recursive: true });
    for (const name of ['LICENSE', 'NOTICE', 'TRADEMARKS.md', 'install.sh', 'install.ps1', 'start.sh', 'start.ps1']) await cp(resolve(root, name), resolve(temp, name));
    const page = resolve(temp, 'site/test-docs/en/cli/second-question.md');
    const original = await readFile(page, 'utf8');
    for (const [mutate, message] of [
      [(text) => text.replace('site: cli', 'site: web'), /site must be frely or cli/],
      [(text) => text.replace('category: Maintenance\n', ''), /needs category/],
    ]) {
      await writeFile(page, mutate(original));
      assert.throws(() => buildSite(temp, { stdio: 'pipe' }), (error) => message.test(error.stderr.toString()));
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
