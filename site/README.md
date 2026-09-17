# Frely CLI landing page

Static landing page prepared for https://cli.frely.cloud/.

## Develop

No build step or package installation is required. From the repository root:

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory site
```

Open http://localhost:8080. Any static HTTP server works.

## Deploy

Publish `index.html`, `styles.css` and `app.js` together from this directory
with any static host, with no build command. The website does not use the CLI's
root `dist/` directory; `npm run build` builds the CLI, not the website. Configure
cli.frely.cloud using that host's custom-domain setup and the DNS records it
provides. A source commit does not configure DNS or make the domain live.

The site needs no backend, secrets, analytics, third-party fonts, or environment
variables. Keep this directory as the canonical source and copy the same assets
when deploying. Provider account configuration does not belong in source control.

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
