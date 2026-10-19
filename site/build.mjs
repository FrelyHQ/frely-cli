// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile, mkdir, rm, copyFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { categories, entries, entryUrl } from './docs-content.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '_site');
const shell = await readFile(new URL('./template.html', import.meta.url), 'utf8');
const include = /\{\{> ([a-z][a-z0-9-]*)\}\}/g;
const components = new Map();
for (const [, name] of shell.matchAll(include)) {
  if (!components.has(name)) {
    const content = await readFile(new URL(`./components/${name}.html`, import.meta.url), 'utf8');
    if (content.includes('{{>')) throw new Error(`Nested component includes are unsupported: ${name}`);
    components.set(name, content.trim());
  }
}
const template = shell.replace(include, (_, name) => components.get(name));
if (template.includes('{{>')) throw new Error('Invalid component include');
const commands = JSON.parse(await readFile(new URL('./commands.json', import.meta.url), 'utf8'));
const token = /\{\{([\w.]+)\}\}/g;
const required = new Set([...template.matchAll(token)].map((match) => match[1]).filter((key) => !key.startsWith('page.') && !key.startsWith('command.')));
for (const [, key] of template.matchAll(token)) {
  if (key.startsWith('command.') && (typeof commands[key.slice(8)] !== 'string' || !commands[key.slice(8)].trim())) {
    throw new Error(`Missing or empty command: ${key}`);
  }
}
const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const locales = [
  { lang: 'en', route: 'en', ogLocale: 'en_US', ogAlternate: 'zh_CN' },
  { lang: 'zh-CN', route: 'zh', ogLocale: 'zh_CN', ogAlternate: 'en_US' },
];

// New HTML must not reuse a cached script or stylesheet from an older deployment.
// Keep stable filenames for cached HTML; the content version changes the cache key.
const assetVersions = {};
for (const [key, asset] of Object.entries({ stylesVersion: 'styles.css', appVersion: 'app.js', localeVersion: 'locale.js' })) {
  assetVersions[key] = createHash('sha256').update(await readFile(new URL(asset, import.meta.url))).digest('hex').slice(0, 16);
}

// Validate every catalog before replacing the previous build.
const pages = [];
for (const locale of locales) {
  const messages = JSON.parse(await readFile(new URL(`./locales/${locale.lang}.json`, import.meta.url), 'utf8'));
  const missing = [...required].filter((key) => typeof messages[key] !== 'string' || !messages[key].trim());
  const extra = Object.keys(messages).filter((key) => !required.has(key));
  if (missing.length || extra.length) {
    throw new Error(`${locale.lang}: missing/empty translations [${missing.join(', ')}]; unknown keys [${extra.join(', ')}]`);
  }
  for (const entry of locale.lang === 'en' ? [false, true] : [false]) {
    const page = { ...locale, ...assetVersions, entry: String(entry), base: entry ? './' : '../', enCurrent: locale.lang === 'en' ? 'page' : 'false', zhCurrent: locale.lang === 'zh-CN' ? 'page' : 'false' };
    const html = template.replace(token, (_, key) => {
      const value = key.startsWith('page.') ? page[key.slice(5)]
        : key.startsWith('command.') ? commands[key.slice(8)] : messages[key];
      if (typeof value !== 'string') throw new Error(`Unknown template key: ${key}`);
      return escapeHtml(value);
    });
    pages.push({ directory: entry ? output : resolve(output, locale.route), html });
  }
}

// Static, crawlable help pages (English only). The index lists every question; /docs/help/ holds all answers on one page.
const origin = 'https://cli.frely.cloud';
const docsStyle = `<style>*{box-sizing:border-box}body{margin:0;background:#101211;color:#eef2ee;font:16px/1.7 system-ui,-apple-system,sans-serif}header,main{max-width:860px;margin:auto;padding:1.5rem}header{display:flex;justify-content:space-between;gap:1rem}main{padding-bottom:5rem}a{color:#d3fa6a;text-underline-offset:.2rem}h1{font-size:clamp(1.8rem,5vw,2.4rem);line-height:1.2}h2{margin-top:2.5rem}h3{margin:0 0 .4rem}.muted{color:#9aa59d}.qa{border-top:1px solid #2a312d;padding:1.2rem 0}.qa p{margin:.3rem 0;color:#d6ddd8}.links{list-style:none;padding:0;margin:.6rem 0 0;display:flex;flex-wrap:wrap;gap:.4rem 1.2rem;font-size:.9rem}</style>`;
const docsPage = (title, description, path, body) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${origin}${path}">
  <title>${escapeHtml(title)} — Frely CLI</title>
  ${docsStyle}
</head>
<body>
  <header><a href="/en/">frely CLI</a><nav><a href="/docs/">Docs</a> · <a href="/en/#install">Install</a> · <a href="https://frely.cloud/app/">Frely App</a></nav></header>
  <main>
${body}
  </main>
</body>
</html>
`;
const qa = (entry, tag) => `    <article class="qa" id="${entry.slug}">
      <${tag}>${tag === 'h3' ? `<a href="${entryUrl(entry)}">${escapeHtml(entry.question)}</a>` : escapeHtml(entry.question)}</${tag}>
      <p>${escapeHtml(entry.answer)}</p>
      <ul class="links">${entry.links.map((l) => `<li><a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a></li>`).join('')}</ul>
    </article>`;
const byCategory = (render) => categories.map((category) => render(category, entries.filter((entry) => entry.category === category))).join('\n');
const slugs = new Set();
for (const entry of entries) {
  if (slugs.has(entry.slug) || !categories.includes(entry.category) || !entry.links.length) throw new Error(`Invalid docs entry: ${entry.slug}`);
  slugs.add(entry.slug);
}
pages.push({ directory: resolve(output, 'docs'), html: docsPage('Docs', 'Frely CLI documentation: questions, short answers, and links.', '/docs/', `    <h1>Frely CLI docs</h1>
    <p class="muted">Short answers about installing, connecting AI clients and using your computer. Every page is static and crawlable. The full list is also on one page at <a href="/docs/help/">/docs/help/</a>.</p>
${byCategory((category, list) => `    <section>
      <h2>${escapeHtml(category)}</h2>
      <ul>${list.map((entry) => `<li><a href="${entryUrl(entry)}">${escapeHtml(entry.question)}</a></li>`).join('')}</ul>
    </section>`)}`) });
pages.push({ directory: resolve(output, 'docs/help'), html: docsPage('Help', 'All Frely CLI questions and short answers on one page.', '/docs/help/', `    <h1>Help</h1>
    <p class="muted">Question, short answer, related links. <a href="/docs/">Back to docs</a>.</p>
${byCategory((category, list) => `    <section>
      <h2>${escapeHtml(category)}</h2>
${list.map((entry) => qa(entry, 'h3')).join('\n')}
    </section>`)}`) });
for (const entry of entries) {
  pages.push({ directory: resolve(output, 'docs/help', entry.slug), html: docsPage(entry.question, entry.answer, entryUrl(entry), `    <p class="muted"><a href="/docs/">Docs</a> / <a href="/docs/help/">Help</a> / ${escapeHtml(entry.category)}</p>
${qa(entry, 'h1')}`) });
}

await rm(output, { recursive: true, force: true });
for (const { directory, html } of pages) {
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'index.html'), html);
}
for (const asset of ['styles.css', 'app.js', 'locale.js']) {
  await copyFile(resolve(root, 'site', asset), resolve(output, asset));
}
// Client logos ship with the landing; sources are re-fetched from each vendor's official assets.
await mkdir(resolve(output, 'assets/clients'), { recursive: true });
for (const client of await readdir(new URL('./assets/clients/', import.meta.url))) {
  await copyFile(new URL('./assets/clients/' + client, import.meta.url), resolve(output, 'assets/clients', client));
}
// The one-line installers are served from the landing domain so both commands share one host.
for (const installer of ['install.sh', 'install.ps1', 'start.sh', 'start.ps1']) {
  await copyFile(resolve(root, installer), resolve(output, installer));
}
for (const notice of ['LICENSE', 'NOTICE', 'TRADEMARKS.md']) {
  await copyFile(resolve(root, notice), resolve(output, notice));
}
await writeFile(resolve(output, '.nojekyll'), '');
await writeFile(resolve(output, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...locales.map(({ route }) => `/${route}/`), '/docs/', '/docs/help/', ...entries.map(entryUrl)].map((path) => `  <url><loc>https://cli.frely.cloud${path}</loc></url>`).join('\n')}
</urlset>
`);
console.log('Built landing page: / (language selection), /en/, /zh/, /docs/');
