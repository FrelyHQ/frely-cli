# Contributing to frely-cli

`frely-cli` is the open-source local client and MCP runtime for Frely. The
hosted Friday Relay control plane remains a separate service dependency.

Before adding code for something the CLI may already do (sign-in, controller or approval flows, credential storage, relay calls), check [docs/capability-owners.md](docs/capability-owners.md) and reuse the owner.

## Development setup

Requirements:

- Node.js 22 or newer;
- npm;
- an OS credential store for manually exercising `frely login` and
  `frely doctor`.

Install dependencies and run the local checks:

```sh
npm ci
npm run check
npm test
npm run build
```

The automated tests replace the credential store with an in-memory test
double. This keeps tests reproducible on machines without an interactive
Keychain or Secret Service. Use `frely doctor` separately when validating the
native OS credential store.

### Install from a local checkout

To try the current source as the `frely` command with Bun:

```sh
bun install
bun run build
bun install --global "$PWD"
```

Use the absolute `$PWD` path. If `frely` is not found, add the Bun global bin
to your `PATH`: `export PATH="$(bun pm bin -g):$PATH"`.

npm is the canonical package manager for CI and releases and
`package-lock.json` is committed; Bun is for local development. Dependency
installation supports `npm ci --ignore-scripts` and
`bun install --ignore-scripts`. Keep both lockfiles in sync when changing
dependencies.

## Pull requests

- Keep changes focused and explain user-visible or protocol changes.
- Add or update documentation when commands, security behavior, or the
  Device Relay contract changes.
- Do not include credentials, private MCP URLs, access tokens, workspace
  contents, or production configuration in commits or tests.
- Run the checks above before requesting review.

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md),
not in a public issue or pull request.
