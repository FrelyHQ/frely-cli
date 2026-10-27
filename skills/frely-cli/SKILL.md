---
name: frely-cli
description: Use the installed Frely CLI to access Frely Agents, manage their local Skills, or inspect Frely access and usage.
---

Run `frely help --agent --json` for the installed CLI's current capabilities and instructions.

Follow the returned command contract instead of remembered command syntax. If the command is unavailable, report that the installed CLI needs an update.

When `frely api call` is refused because the owner must approve it, rerun it with `--wait`: tell the user the approval link first, then run the command in the foreground (tool timeout of at least 10 minutes, never backgrounded or killed). It returns the real result by itself once the user approves on their phone or the web, so the user does not need to tell you.
