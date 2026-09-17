# Frely CLI landing page

Static landing page for https://cli.frely.cloud/, hosted on GitHub Pages.

## Develop

The dependency-free static generator requires Node.js 22 or newer. No package
installation is required. From the repository root:

```sh
node site/build.mjs
python3 -m http.server 8080 --bind 127.0.0.1 --directory _site
```

Open http://localhost:8080. Any static HTTP server works. Rebuild after editing
the template or translation catalogs. Generated `_site/` files are ignored by Git.

## Languages

- `/en/`: English; `/zh/`: Simplified Chinese. Both are complete static pages,
  including translated metadata, navigation, accessibility labels and copy feedback.
- `/`: an English fallback page that selects the first supported browser language
  when JavaScript is available. Chinese language variants select Simplified Chinese;
  unsupported language lists fall back to English.
- The header's **English / 中文** links remember an explicit selection locally.
  That preference wins on later visits to `/`. Direct language URLs always keep
  their language, regardless of browser settings or the saved preference.
- Switching preserves the query string and section anchor. Disabled browser storage
  does not prevent navigation. With JavaScript disabled, both languages and the
  language links still work; automatic selection and preference storage are unavailable.

Edit `template.html` for shared markup and `locales/en.json` / `locales/zh-CN.json`
for copy. Keep the same keys in both catalogs. `{{key}}` values are HTML-escaped;
put markup in the template, never in translation values. The build rejects missing,
empty and unused translations. CLI commands, flags, manifest placeholders and
product identifiers remain unchanged between languages. Documentation links still
point to the existing repository documentation.

Each language has its own canonical URL, `hreflang` alternatives and Open Graph
metadata. The generated `sitemap.xml` lists both canonical pages. Relative asset and
language URLs also support GitHub Pages project paths.

## Deploy

The `Deploy CLI landing` GitHub Actions workflow publishes changes to `site/`
on `main`. It can also be run manually. GitHub Pages must use **GitHub Actions**
as its publishing source. No separate deployment branch or application server
is needed.

The workflow validates the scripts, runs language routing checks and builds the
static pages. It publishes only the generated HTML pages, `styles.css`, `app.js`,
`locale.js`, `sitemap.xml`, `.nojekyll`, the repository license and trademark notices,
and a generated `release.json` containing the source commit SHA. It does not publish
the template, translation catalogs, repository or CLI build output.
The root `npm run build` still builds only the CLI.

Set the repository's Pages custom domain to `cli.frely.cloud`. In the
`frely.cloud` DNS zone, configure:

| Type | Name | Target | Proxy |
| --- | --- | --- | --- |
| CNAME | cli | frelyhq.github.io | DNS only |

Replace any conflicting A, AAAA, or CNAME record at that exact hostname.
Wait for GitHub Pages domain validation and certificate issuance, then enable
**Enforce HTTPS** in Pages settings. DNS configuration and certificate issuance
are separate from a successful workflow deployment. GitHub Actions deployments
use the custom domain in repository settings; a source `CNAME` file is not needed.

The site needs no backend, secrets, analytics, third-party fonts, or environment
variables. Keep this directory as the canonical source.

## Maintain

Keep examples aligned with released CLI functionality and the root README.
The npm package requires Node.js 22 or newer; standalone releases contain their
runtime. Remote Agent use, local MCP authorization and Provider sharing have
separate setup flows. Never describe the workspace as a shell sandbox.

Run `node --check site/app.js`, `node --check site/locale.js`,
`node --test site/locale.test.mjs` and `node site/build.mjs`. Review keyboard tab
navigation, copy controls, mobile layouts and text enlargement after changes.
The page remains readable without JavaScript and respects reduced motion.

## License

This page is covered by the repository's Apache-2.0 license. Frely's existing
TRADEMARKS.md still applies. The hosted Relay is a separate service dependency.
The website is outside package.json's npm files allowlist.
