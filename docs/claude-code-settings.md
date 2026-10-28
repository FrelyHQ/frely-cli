# Claude Code settings for controlling devices

`frely` keeps this computer's controller session (its tokens and the key they are bound to) under `~/.config/frely`. Anything running as
your user can read that folder, including a model's shell, so tell Claude Code not to. Merge this into `~/.claude/settings.json`
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
Tokens are also bound to a key (DPoP), so a copied token file does nothing on another computer; the deny rules close the same-computer case
as far as a rule can.

On a Linux machine without a Secret Service (a server, a container) the session is stored in an encrypted file under
`~/.config/frely/controller-vault-v1`, with its key in `~/.local/state/frely/controller.key`. Set `FRELY_CREDENTIAL_KEY` (a 64-hex-character
key from your secret manager) to keep the key off the disk.
