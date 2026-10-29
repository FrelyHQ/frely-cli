// SPDX-License-Identifier: Apache-2.0
// Source for https://cli.frely.cloud/docs. The pages live in the public docs repository (FrelyHQ/docs, en/cli/<slug>.md
// with `site: cli`); the build fetches the commit pinned in docs.pin.json into .docs/. English only for now.
// Set DOCS_DIR to read a local checkout instead (nothing is fetched).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** The docs checkout: DOCS_DIR, or the pinned commit fetched into .docs/. */
export function syncDocs(env = process.env) {
  if (env.DOCS_DIR) return resolve(env.DOCS_DIR);
  const target = resolve(root, '.docs');
  const pin = JSON.parse(readFileSync(new URL('./docs.pin.json', import.meta.url), 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(pin.sha)) throw new Error('docs.pin.json: sha must be a full commit SHA');
  const git = (...args) => execFileSync('git', args, { cwd: target, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  let current = '';
  if (existsSync(resolve(target, '.git'))) {
    try { current = git('rev-parse', 'HEAD'); } catch { current = ''; }
  }
  if (current !== pin.sha) {
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    git('init', '-q');
    git('remote', 'add', 'origin', pin.repo);
    git('fetch', '-q', '--depth', '1', 'origin', pin.sha);
    git('checkout', '-q', '--detach', 'FETCH_HEAD');
  }
  return target;
}

function parse(folder, file, raw) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`${folder}/${file}: missing frontmatter`);
  const meta = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) meta[key.trim()] = rest.join(':').trim();
  }
  return { folder, slug: file.replace(/\.md$/, ''), meta, site: meta.site ?? 'frely', body: match[2] };
}

/** Every English page of the docs checkout, from en/<folder>/<slug>.md. */
export function readPages(docsDir) {
  const base = resolve(docsDir, 'en');
  if (!existsSync(base)) throw new Error(`Docs checkout has no en/ folder: ${docsDir}`);
  const pages = [];
  for (const folder of readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    for (const file of readdirSync(resolve(base, folder)).filter((name) => name.endsWith('.md')).sort()) {
      pages.push(parse(folder, file, readFileSync(resolve(base, folder, file), 'utf8')));
    }
  }
  for (const page of pages) {
    if (page.site !== 'frely' && page.site !== 'cli') throw new Error(`${page.folder}/${page.slug}: site must be frely or cli`);
  }
  return pages;
}

const linkPattern = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/** The Q&A entries: pages with `site: cli`, ordered by `order`; each category sits where its first page sits. */
export function cliEntries(pages) {
  const entries = pages.filter((page) => page.site === 'cli').map((page) => {
    for (const key of ['title', 'category', 'order']) if (!page.meta[key]) throw new Error(`Invalid docs entry: ${page.slug} needs ${key}`);
    const lines = page.body.trim().split('\n').filter((line) => !/^# /.test(line));
    const related = lines.findIndex((line) => line.startsWith('Related: '));
    const links = related < 0 ? [] : [...lines[related].matchAll(linkPattern)].map(([, label, href]) => ({ label, href }));
    const answer = (related < 0 ? lines : lines.slice(0, related)).join('\n').trim();
    return { slug: page.slug, category: page.meta.category, order: Number(page.meta.order), question: page.meta.title, answer, links };
  }).sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
  const categories = [...new Set(entries.map((entry) => entry.category))];
  return { categories, entries };
}

/** The `site: frely` pages as links to frely.cloud, for the "On frely.cloud" group of the docs index. */
export function frelyLinks(pages) {
  const byOrder = (a, b) => Number(a.meta.order ?? 99) - Number(b.meta.order ?? 99) || a.slug.localeCompare(b.slug);
  const own = pages.filter((page) => page.site === 'frely' && page.meta.draft !== 'true');
  const of = (folder) => own.filter((page) => page.folder === folder);
  const link = (page, path) => ({ title: page.meta.title, href: `https://frely.cloud${path}` });
  return [
    ...of('guides').sort(byOrder).map((page) => link(page, `/docs/${page.slug}/`)),
    ...of('faq').sort(byOrder).map((page) => link(page, `/docs/faq/${page.slug}/`)),
    ...of('blog').sort((a, b) => (b.meta.date ?? '').localeCompare(a.meta.date ?? '') || a.slug.localeCompare(b.slug)).map((page) => link(page, `/blog/${page.slug}/`)),
  ];
}

const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const safeHref = (href) => {
  if (!/^(https?:\/\/|mailto:|\/|#)/.test(href)) throw new Error(`Unsupported link in docs: ${href}`);
  return escapeHtml(href);
};

/** `code`, **bold** and [links](url); the rest is text. */
export function inline(text) {
  return text.split(/(`[^`]+`)/).map((part, index) => index % 2
    ? `<code>${escapeHtml(part.slice(1, -1))}</code>`
    : escapeHtml(part).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => `<a href="${safeHref(href.replace(/&amp;/g, '&'))}">${label}</a>`)).join('');
}

/** Answers use paragraphs, bullet and numbered lists, fenced code, `code`, **bold** and [links](url). */
export function markdownHtml(text) {
  const blocks = [];
  let paragraph = [];
  let list = null;
  let fence = null;
  const flush = () => {
    if (paragraph.length) blocks.push(`<p>${paragraph.map(inline).join('\n')}</p>`);
    if (list) blocks.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.tag}>`);
    paragraph = [];
    list = null;
  };
  for (const line of text.split('\n')) {
    if (fence) {
      if (line.startsWith('```')) { blocks.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`); fence = null; } else fence.push(line);
      continue;
    }
    const item = /^(?:([-*])|\d+\.) (.*)$/.exec(line);
    if (line.startsWith('```')) { flush(); fence = []; }
    else if (!line.trim()) flush();
    else if (item) {
      const tag = item[1] ? 'ul' : 'ol';
      if (list?.tag !== tag) { flush(); list = { tag, items: [] }; }
      list.items.push(item[2]);
    } else { if (list) flush(); paragraph.push(line); }
  }
  if (fence) throw new Error('Unclosed code fence in docs');
  flush();
  return blocks.join('\n');
}

/** The answer as plain text, for the page description. */
export const plainText = (text) => text.replace(linkPattern, '$1').replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');

export const entryUrl = (entry) => `/docs/help/${entry.slug}/`;
