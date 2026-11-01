# Claude Code settings for controlling devices

`frely` keeps this computer's login tokens (the account access token and this machine's FreyMCP side token) under `~/.config/frely`.
Anything running as your user can read that folder, including a model's shell, so tell Claude Code not to. Merge this into `~/.claude/settings.json`
(or a project's `.claude/settings.json`):

```json
{
  "permissions": {
    "deny": [
      "Read(~/.config/frely/**)",
      "Read(~/.local/state/frely/**)",
      "Bash(cat ~/.config/frely/*)",
      "Bash(cat ~/.local/state/frely/*)"
    ],
    "allow": ["Bash(frely devices:*)", "Bash(frely read:*)", "Bash(frely ls:*)", "Bash(frely grep:*)", "Bash(frely tools:*)"]
  },
  "env": { "BASH_DEFAULT_TIMEOUT_MS": "120000" }
}
```

The `allow` lines are only the read-only commands. `frely run`, `edit`, `kill` and `call` stay behind Claude Code's own prompt.
A leaked token works until it is disconnected, so the deny rules matter; this machine's connection can be revoked any time on the web
(My Devices) or by `frely logout`.

When the OS credential store is unavailable (a Linux server or container without a Secret Service, a locked keychain over SSH), the login is
stored in private session files under `~/.config/frely/basic-credentials-v1`. Set `FRELY_CREDENTIAL_KEY` (a 64-hex-character key from your
secret manager) to keep them in an encrypted file instead.
