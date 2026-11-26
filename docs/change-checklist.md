# What else changes with a CLI change

A change in this repository is often not finished when its PR is merged. Several places copy or serve the same facts, and each one is deployed by its own step. Use this list before you call a change done, and write in the PR which items apply.

## 1. The installers and their command (`install.sh`, `install.ps1`, `start.sh`, `start.ps1`)

- **Users do not get these files from a CLI release.** `https://frely.cloud/install.ps1` and the other three are relayed from `https://cli.frely.cloud` (GitHub Pages, built by `.github/workflows/site.yml`). They are deployed **only when a `landing/vX.Y.Z` tag is pushed**: `./scripts/release-landing --version X.Y.Z`, run through FrelyMCP on the dev machine (a plain GitHub tag push is refused). A merged PR or a new `vX.Y.Z` CLI release does not change them. `frely update` on Windows downloads `install.ps1` from there too, so a broken installer breaks upgrades until the landing tag is deployed.
- `frely.cloud` caches each script for five minutes (`apps/web/runtime/static-assets.mjs` in friday-relay).
- After deploying, download `https://frely.cloud/install.ps1` and `https://cli.frely.cloud/install.ps1` and check that your change is in both. `release-entry.mjs` also prints a reminder when these files are newer than the latest `landing/v*` tag.
- The one-line install commands with a one-time token are **generated in friday-relay**, `packages/device-relay/src/install-tokens.ts` (`installCommands()` and `shortSetupCommands()`). They are also shown in the console's "Add a computer" dialog and in the `list_devices` text. Change them there, not here, and keep their tests in step. Changing a command is a friday-relay release; changing the script is a landing release here; a change that needs both needs both.
- Installer logic that only runs in some situations (an existing `frely.exe`, a missing `curl.exe`, no GitHub access) needs a test that really runs it. `src/install-ps1.test.ts` runs the Windows replace line on the `windows-latest` job.

## 2. CLI commands, flags and operation APIs

When a command, flag, output field or an operation the CLI calls changes, update all of these that mention it:

| Place | What to change | How it is deployed |
| --- | --- | --- |
| `src/` help text and error messages | the command's own `--help`, hints that print another command | CLI release |
| `skills/frely-cli/SKILL.md` | the Skill that teaches agents the CLI; commands, triggers and flows | CLI release (installed by `frely`) |
| `README.md`, `README.zh-CN.md` | command examples | merge to main |
| `site/commands.json` and `site/locales/*.json` | the command strings shown on the CLI site (`{{command.name}}`) | landing tag |
| `FrelyHQ/docs` repository, `en/cli/<slug>.md` (and the other languages) | the CLI help pages rendered at `https://cli.frely.cloud/docs/help/<slug>/` | docs commit, then `site/docs.pin.json` points at it, then a landing tag |
| `FrelyHQ/docs`, `en/guides/` and `en/faq/` | client guides and FAQ that quote commands | same as above |
| friday-relay `apps/landing/src/content/` (`install-prompt.ts`, `client-guides.ts`) | install prompts and guides on `frely.cloud` that quote commands | friday-relay release |
| friday-relay MCP tool descriptions and `list_devices` text | tool names and arguments the CLI exposes | friday-relay release |

Rules of thumb:

- The CLI site shows the docs commit named in `site/docs.pin.json`, not the docs `main`. Changing the docs repository alone changes nothing there; bump the pin and deploy a landing tag.
- Only English is written by hand; translations are filled in later (the other languages fall back to English).
- A breaking command change also needs an older-client plan: devices already installed keep the old command until they update.

## 3. Before you finish

1. List which rows above apply and write that in the PR description.
2. For each row that is deployed separately, either deploy it or write the step and its owner in the PR.
3. Check the served files or pages after deploying; a green workflow is not the same as a changed page.
