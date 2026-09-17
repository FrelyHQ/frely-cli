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

## Content and entry paths

The homepage leads with “让 Agent 从任何地方访问你的设备” / “Let agents access your device from any location”. FrelyMCP lets external agents access the user's device: browser agents and command-line agents such as Codex and Claude Code are client examples. The computer running Frely CLI provides files, shell commands and processes through remote HTTP MCP with OAuth. Install Frely CLI on the target computer; the calling device uses its MCP client.

The page order is installation hero, target-computer setup, client connection choices, device-access use cases, optional CLI feature links, then open source. Client tabs are alternatives; local model sharing and hosted Agent invocation are independent optional features, not steps in device setup. Section and feature headings have no sequential numbers. The setup sequence is install → login → `frely mcp` → `frely mcp url` → client OAuth → a real tool call. Diagnostics use `frely doctor` with `-v` for details.

Frely's main site can link to `/zh/#install` or `/en/#install`. The neutral `/#install` entry selects a language and preserves the anchor. Copy targets for install, login, MCP setup, URL and diagnostics are independent. Codex and Claude Code examples label the URL placeholder. Codex command syntax was checked with the installed CLI's `mcp add --help` and `mcp login --help`; this is not a client OAuth acceptance test. The signed-in Frely Device MCP page provides a device-specific copy command.

## Copy style

Avoid adverbs in English and Chinese page copy, including metadata, labels and
status messages. Name actions, objects, conditions and results. Preserve release
availability, permission boundaries and failure meanings when rewriting sentences.
Keep commands, flags, product names and URLs faithful to the implementation.
The content decisions are recorded in the revision document linked below; the device MCP contract is in [`docs/device-mcp.md`](../docs/device-mcp.md).

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

Edit `template.html` for the document shell, `components/*.html` for section
markup, and `locales/en.json` / `locales/zh-CN.json` for copy. Keep the same keys in both catalogs. `{{key}}` values are HTML-escaped;
put markup in the template, never in translation values. The build rejects missing,
empty and unused translations. CLI commands, flags, manifest placeholders and
product identifiers remain unchanged between languages. Documentation links still
point to the existing repository documentation.

Each language has its own canonical URL, `hreflang` alternatives and Open Graph
metadata. The generated `sitemap.xml` lists both canonical pages. Relative asset and
language URLs also support GitHub Pages project paths.

## Source structure

- `template.html`: metadata, asset references and section order.
- `components/header.html`, `hero.html`, `device-mcp.html`, `setup.html`, `workflows.html`,
  `more.html`, `open-source.html`, `footer.html`: page sections.
- `commands.json`: canonical CLI command strings; referenced as `{{command.name}}`.
- `locales/*.json`: public copy, labels and status messages.
- `styles.css`: foundations, navigation, installation, setup, workflows, footer
  and responsive/accessibility rules, in that order.
- `build.mjs`: compose sections, validate values, escape content and emit static pages.

The shell includes named sections with `{{> hero}}`. Includes have a flat structure;
nested or malformed includes fail the build. Section placeholders use the same
translation and command lookup rules as the shell. Commands and translations are
HTML-escaped; missing translations, empty commands and missing components fail
before the previous build is replaced. Source components and command catalogs are
excluded from deployment output.

The desktop hero uses two columns. The installation card follows the product
description on screens up to 800px wide. Use-case cards, setup steps and client panels stack
at that breakpoint. Navigation wraps on narrow screens, copy controls have a
44px minimum height, and reduced-motion preferences disable smooth scrolling.

## Deploy

The `Deploy CLI landing` GitHub Actions workflow publishes changes to `site/`
on `main`. It can also be run manually. GitHub Pages must use **GitHub Actions**
as its publishing source. No separate deployment branch or application server
is needed.

The workflow validates the scripts, runs language, interaction, component-validation and asset-version checks and builds the
static pages. It publishes only the generated HTML pages, `styles.css`, `app.js`,
`locale.js`, `sitemap.xml`, `.nojekyll`, the repository license and trademark notices,
and a generated `release.json` containing the source commit SHA. It does not publish
the template, translation catalogs, repository or CLI build output.
The root `npm run build` still builds only the CLI.

Asset URLs include a build-generated content hash in their query string. New HTML
therefore requests the matching scripts and styles instead of reusing a previous
deployment's cached bytes. Stable filenames remain available to cached HTML.

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

Public page copy has no product version or release-status snapshot. Installation
uses `frely-cli@latest`; the download link points to the latest release. Node.js
requirements describe the installation prerequisite, not the Frely release.
On 2026-09-17, registry metadata and the npm 0.6.2 tarball were checked: device
MCP, Provider, Agent install and Agent invoke commands are included. The optional
Agent card describes invoking Frely-hosted Agents and links to the README guide.
This outbound workflow is distinct from external agents accessing the user's
device through FrelyMCP. Package inspection is not a substitute for service and
client verification.

The main install path ends with client OAuth and a real read-only device tool result. Provider setup is documented in its linked guide. `frely doctor` alone is not connection success. Links to client panels select the correct tab on entry and after a language
switch. Legacy `#panel-tools`, `#panel-models` and `#panel-agents` anchors lead to
visible device-connection and optional-feature sections.

The revision decisions and pending positioning questions live in
[`docs/landing/cli/revision-20260917.md`](../docs/landing/cli/revision-20260917.md).
The npm package requires Node.js 22 or newer; standalone releases contain their
runtime. Remote Agent use, local MCP authorization and Provider sharing have
separate setup flows. Never describe the workspace as a shell sandbox.

Run `node --check site/app.js`, `node --check site/locale.js`,
`node --test site/*.test.mjs` and `node site/build.mjs`. Review keyboard tab
navigation, copy controls, mobile layouts and text enlargement after changes.
The page remains readable without JavaScript and respects reduced motion.

## License

This page is covered by the repository's Apache-2.0 license. Frely's existing
TRADEMARKS.md still applies. The hosted Relay is a separate service dependency.
The website is outside package.json's npm files allowlist.
