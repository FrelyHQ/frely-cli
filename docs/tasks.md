# Tasks on this computer

`frely task` defines commands that run on this computer, by hand or on a cron schedule, inside the Frely command sandbox.

```
frely task local add <name> [--cwd <dir>] [--net <site>]... [--env K=V]... [--timeout <seconds>] [--cron "<m h dom mon dow>" [--tz <zone>]] [--replace] -- <command...>
frely task local list | show <name> | remove <name>
frely task local schedule <name> (--cron "<m h dom mon dow>" [--tz <zone>] | --pause | --resume | --clear)
frely task local approve <name>
frely task local start <name> [--wait [--wait-sec <n>]]
frely result list [<name>]                 # task runs and item calls share runs, result and cancel
frely result [<runId>|--last] [--wait [--wait-sec <n>]]
frely result [<runId>|--last] --log [--lines <n>] [--follow]
frely result cancel [<runId>|--last]
```

## How a run works

- **Its own worker.** `start` (and the schedule) creates a run record and starts a detached worker process. The run keeps going when the terminal closes, the command that started it is cut off, or the device's connection to Frely drops and reconnects. A run whose worker died (reboot, kill) is reported as `interrupted`.
- **Sandbox.** The command can write its folder (`--cwd`) and the temp folder, cannot read credential folders, and can reach only the sites given with `--net`, each approved by the owner through an approval link (`frely task local approve`; a schedule uses only the sites approved when it fires). A computer that cannot sandbox (Windows, Linux without bubblewrap) refuses to run tasks.
- **A fixed copy.** A run uses the definition as it was when it started. Definitions, run records and logs live under `~/.config/frely/tasks`, outside every task's folder, so a task cannot edit its own definition.
- **Result.** Status, exit code and the end of the log. `result --wait` waits at most 100 seconds; call it again if the run is still going.
- **Limits.** At most 8 runs at the same time on a computer (`FRELY_TASK_MAX_CONCURRENT` lowers or raises it, 1 to 64). Runs and logs are kept for 14 days; a log is capped at 8 MiB.

## Schedules

Five cron fields in an IANA time zone (default: this computer's). When both day-of-month and day-of-week are restricted, either matching is enough. The background service (`frely link on`) holds the clock. A slot missed while the computer was off or asleep runs once when the service is back, if it is at most a day old. A task still running from the last slot is skipped (a `skipped` run is recorded), not doubled.

## Models

`--model <name>` gives the program a model through a local proxy: `OPENAI_BASE_URL`, `OPENAI_API_KEY` (a placeholder) and `FRELY_MODEL`. The program never holds a real key.

- **Registered here first.** `frely provider add --url http://192.168.1.20:3000/v1 --key-stdin` registers a model endpoint for this computer only (loopback, or a private network IP address; a network address is confirmed by typing yes in a terminal). Nothing is created on Frely's servers and no Provider slot is used. A task that asks for one of its models calls it directly: no relay, no Credit, and it works without Frely being reachable. The endpoint's key lives in this computer's secure storage.
- **Otherwise Frely.** Any other model goes to the Frely gateway with your API key (`frely agent key --api-key-stdin`), billed as usual.
- **Fallback.** `--fallback-model` names models to try, in order, only when the first cannot be started: unreachable, not offered there, or key rejected. A slow or poor answer never switches the model, and a model is never switched in the middle of a run.
- **Limits.** Each endpoint serves a limited number of calls at once, shared with callers that use a shared Provider: 1 for a model served on this computer, 6 for a network address or the gateway (`frely provider add --max-concurrent <n>` changes it). A task waits for a free slot; a remote buyer is told the endpoint is busy, so your own tasks go first.
- **Records.** A run records how many model calls it made and how many failed, on this computer only. Nothing is reported or billed for them.

## Agent tasks (`--agent`)

`frely task local add <name> --agent pi|codex|claude-code [--model <name>] [--cwd <git-folder>] -- <prompt>` defines a task whose prompt is run by a coding agent installed on this computer (`pi -p`, `codex exec`, `claude -p`). frely-cli does not install or embed an agent; `frely agent list` shows which are installed and `frely agent status <id>` prints the vendor's install command. `frely agent run <id> "<task>"` is the one-off form of the same thing.

- The prompt is sent on stdin and the agent runs inside the Frely command sandbox, which is the boundary of the run (the agent's own approval prompts and sandbox are off). It uses its own login and model settings; Frely holds none of them. `--model` is passed to the agent as given.
- The sandbox lets a run reach only the sites you approved: the agent's own service (`api.openai.com`, `api.anthropic.com`, ...) is asked for through an approval link the first time (`frely task local approve <name>`; `frely agent run` asks by itself).
- With `--agent` the task folder should be a git repository: the agent works in its own git worktree of it, so nothing is committed to your main branch or pushed. The result holds the agent's last answer and a short summary of the changes (`frely result`).
- `frely doctor agent` checks which agents are installed. `frely agent setup <id>` gives an agent the Frely Skill.

## Sharing a task as an A2A service

`frely service share --type task <name> [--workspace none|read|worktree] [--description <text>] [--charge-my-credit]` registers the task as an A2A service (`task-<name>`) that the background service serves on `127.0.0.1` and connects to Frely through the same path as `frely service share --type a2a`.

- A caller sends only a text request (`message/send`). The runner, instructions, command, folder and workspace mode come from the approved definition; the Agent Card is generated from it.
- You approve the exact definition at a terminal on this computer. Any change to the task (or removing it) delists the share until you share it again.
- Agent tasks, `--workspace`: `none` (default) works in a one-time empty folder; `read` answers about the task folder without changing it; `worktree` uses a git worktree per call (nothing is committed to your main branch or pushed) and returns the answer plus a diff summary. After 10 calls whose changes you have not dealt with (`frely task local handled <runId>`), new worktree calls are answered busy.
- Only a model registered on this computer (`frely provider add`) is allowed. A task that uses a gateway model needs `--charge-my-credit`: each call then deducts model fees from your Credit.
- One call runs at a time and three wait; further calls get a busy answer and nothing is charged. A call that takes longer than 50 seconds returns a task id; poll it with `tasks/get`. Local tasks start first when the computer is full.
- A script task gets the request as `$FRELY_TASK_INPUT`.
- `frely service stop <id|label>` stops sharing (`frely service list` shows the id).
