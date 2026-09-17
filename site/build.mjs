// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '_site');
const template = await readFile(new URL('./template.html', import.meta.url), 'utf8');
const token = /\{\{([\w.]+)\}\}/g;
const required = new Set([...template.matchAll(token)].map((match) => match[1]).filter((key) => !key.startsWith('page.')));
const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const locales = [
  { lang: 'en', route: 'en', ogLocale: 'en_US', ogAlternate: 'zh_CN' },
  { lang: 'zh-CN', route: 'zh', ogLocale: 'zh_CN', ogAlternate: 'en_US' },
];

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
    const page = { ...locale, entry: String(entry), base: entry ? './' : '../', enCurrent: locale.lang === 'en' ? 'page' : 'false', zhCurrent: locale.lang === 'zh-CN' ? 'page' : 'false' };
    const html = template.replace(token, (_, key) => {
      const value = key.startsWith('page.') ? page[key.slice(5)] : messages[key];
      if (typeof value !== 'string') throw new Error(`Unknown template key: ${key}`);
      return escapeHtml(value);
    });
    pages.push({ directory: entry ? output : resolve(output, locale.route), html });
  }
}

await rm(output, { recursive: true, force: true });
for (const { directory, html } of pages) {
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'index.html'), html);
}
for (const asset of ['styles.css', 'app.js', 'locale.js']) {
  await copyFile(resolve(root, 'site', asset), resolve(output, asset));
}
for (const notice of ['LICENSE', 'NOTICE', 'TRADEMARKS.md']) {
  await copyFile(resolve(root, notice), resolve(output, notice));
}
await writeFile(resolve(output, '.nojekyll'), '');
await writeFile(resolve(output, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locales.map(({ route }) => `  <url><loc>https://cli.frely.cloud/${route}/</loc></url>`).join('\n')}
</urlset>
`);
console.log('Built landing page: / (language selection), /en/, /zh/');
