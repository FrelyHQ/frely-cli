# Agents on this computer

`frely agent local` runs an open-source Agent's repository on your computer, inside the Frely command sandbox.

```
frely agent local add <username/name | https://github.com/owner/repo> [--name <folder-name>]
frely agent local start <name> [--foreground]
frely agent local stop <name>
frely agent local logs <name> [--lines <n>] [--follow]
frely agent local list [--json]
frely agent local remove <name>
frely agent local key --api-key-stdin | --clear
```

## What the repository declares

The repository needs a `frely.yaml` with a `local:` section:

```yaml
name: My Agent            # optional
local:
  setup: uv sync          # optional, runs once after the download
  run: uv run main.py     # required, starts the Agent
  network:                # optional: sites beyond Frely's API
    - pypi.org
    - files.pythonhosted.org
```

`network` entries are exact site names (no wildcards, ports or addresses), at most 20.

## What the sandbox allows

- **Files**: the Agent can write only its own folder (`~/frely-agents/<name>`, or `$FRELY_AGENTS_DIR/<name>`) and the system temp folder. Credential folders such as `~/.ssh` and `~/.aws` cannot be read. Frely's own records live outside that folder, so the program cannot change them.
- **Network**: only Frely's API, the model proxy below, and the sites you approved. Everything else is refused, including other ports on your own computer.
- **Environment**: the program starts with a short environment (`PATH`, `HOME`, `LANG`, ...). Keys exported in your shell are not passed on.
- **Refused, never bare**: if this computer cannot run the sandbox (Windows, or Linux without bubblewrap, socat and ripgrep), `add` and `start` stop instead of running the program unprotected.

## Approving sites

When the Agent is added or started, each site in `local.network` that is not approved yet is requested through the same approval link as any other device permission (resource `net:<site>`; you choose how long). With a person at the terminal the command waits; otherwise it prints the link and ends with exit code 3, and you run the same command again after approving. A declined site stays blocked and the Agent runs without it. New approvals apply the next time the Agent starts.

## Model calls and your API key

The program gets `OPENAI_BASE_URL=http://frely-model.local/v1` and `ANTHROPIC_BASE_URL=http://frely-model.local` with a placeholder key. The sandbox's proxy hands those requests to a Unix socket served by the CLI, which adds your real Frely API key and forwards only the model endpoints (`/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/messages`, `/v1/models`) to Frely's gateway. The program never holds the key, and calls are billed to it like any other API call.

Save a key once with `frely agent local key --api-key-stdin` (or set `FRELY_API_KEY`). Create one in the Frely console under Keys.

Clients that ignore `HTTP_PROXY` (Node's built-in `fetch` without `NODE_USE_ENV_PROXY=1`) cannot reach the proxy; the Agent should use a client that honors proxy variables or set that variable in its `run` command.
