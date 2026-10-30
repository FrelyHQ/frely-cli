---
name: frely-cli
description: Use the installed Frely CLI to access Frely Agents, manage their local Skills, or inspect Frely access and usage.
---

Run `frely help --agent --json` for the installed CLI's current capabilities and instructions.

Follow the returned command contract instead of remembered command syntax. If the command is unavailable, report that the installed CLI needs an update.

When `frely api call` is refused because the owner must approve it, rerun it with `--wait`: tell the user the approval link first, then run the command in the foreground (tool timeout of at least 10 minutes, never backgrounded or killed). It runs the call once, by itself, as soon as the user approves on their phone or the web, so the user does not need to tell you; if you cannot keep a foreground command open, run `frely permission wait <approval code>` in the background (the refusal shows it) and rerun the call when it exits 0.

## Control the user's devices

`frely devices` lists the user's computers (online state, workspaces). Then use `frely run <device> -- <command>`, `frely read|ls|grep <device>:<path>`, `frely edit <device>:<path> --from <local file>`, and `frely tools` / `frely call <tool>` for anything else. The first of these commands asks the user to approve this computer once (a short code and a link; they type the code and confirm with a passkey or authenticator code).

Use `--out <file>` for large output instead of printing it. Exit codes: 0 done, 1 the CLI itself, 2 the tool or remote command failed, 3 approval needed, 4 not authorized (`frely controller login`), 5 device offline (the output says to run `frely mcp start` there), 6 limit reached.

On exit code 3 the output has an approval link and a `frely permission wait <approval code>` command. Give the user the link, then run `frely permission wait <short code> --then '<the original command>'` in the background: it runs the original command by itself once they approve, so they do not need to tell you. Do not read `~/.config/frely`.
