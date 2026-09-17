# Frely CLI landing page

Static landing page for https://cli.frely.cloud/, hosted on GitHub Pages.

## Develop

No build step or package installation is required. From the repository root:

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory site
```

Open http://localhost:8080. Any static HTTP server works.

## Deploy

The `Deploy CLI landing` GitHub Actions workflow publishes changes to `site/`
on `main`. It can also be run manually. GitHub Pages must use **GitHub Actions**
as its publishing source. No separate deployment branch or application server
is needed.

The workflow publishes only `index.html`, `styles.css`, `app.js`, the repository
license and trademark notices, and a generated `release.json` containing the
source commit SHA. It does not publish the repository or CLI build output.
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

Check JavaScript syntax with `node --check site/app.js`. Review keyboard tab
navigation, copy controls, mobile layouts and text enlargement after changes.
The page remains readable without JavaScript and respects reduced motion.

## License

This page is covered by the repository's Apache-2.0 license. Frely's existing
TRADEMARKS.md still applies. The hosted Relay is a separate service dependency.
The website is outside package.json's npm files allowlist.
