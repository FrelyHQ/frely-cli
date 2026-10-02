# Get started with Frely CLI

## Install Frely CLI

Choose your installation method:

### npm
Requires Node.js 22+.

```bash
npm install -g @frelyhq/frely-cli
```

### Download standalone executable
Standalone releases include their runtime and don't require Node.js.

Download from [GitHub Releases](https://github.com/FrelyHQ/frely-cli/releases/latest).

## Sign in

Once installed, sign in with your email:

```bash
frely login --email your-email@example.com
```

Frely CLI sends a verification code to your email. Use it to complete your account setup:

```bash
frely login --code 123456
```

If this is your first sign-in, a new account will be created.

## Enable device MCP

After signing in, enable the device MCP connection:

```bash
frely mcp
```

Approve the device and workspace in your browser. Your MCP address will be printed.

Use this address to connect agents from any compatible client (ChatGPT, Claude Code, Codex, etc.).

## Check your setup

Verify the connection at any time:

```bash
frely doctor
```

Add `-v` for detailed diagnostics:

```bash
frely doctor -v
```

---

## What's next?

- **Connect your browser agent**: Add the MCP address in ChatGPT or another compatible client, authorize with your Frely account, and ask the agent to read files or run commands on your device.
- **Connect your CLI agent**: Run the MCP address setup on a different computer running Codex, Claude Code, or another command-line agent.
- **Share a local model**: Set up a local model provider to share Ollama or another local LLM through Frely.
