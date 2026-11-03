# Tasks on this computer

`frely task` defines commands that run on this computer, by hand or on a cron schedule, inside the Frely command sandbox.

```
frely task add <name> [--cwd <dir>] [--net <site>]... [--env K=V]... [--timeout <seconds>] [--cron "<m h dom mon dow>" [--tz <zone>]] [--replace] -- <command...>
frely task list | show <name> | remove <name>
frely task schedule <name> (--cron "<m h dom mon dow>" [--tz <zone>] | --pause | --resume | --clear)
frely task approve <name>
frely task start <name> [--wait [--wait-sec <n>]]
frely task status | result [<runId>|--last] [--wait [--wait-sec <n>]]
frely task cancel [<runId>|--last]
frely task runs [<name>] | logs [<runId>|--last] [--lines <n>] [--follow]
```

## How a run works

- **Its own worker.** `start` (and the schedule) creates a run record and starts a detached worker process. The run keeps going when the terminal closes, the command that started it is cut off, or the device's connection to Frely drops and reconnects. A run whose worker died (reboot, kill) is reported as `interrupted`.
- **Sandbox.** The command can write its folder (`--cwd`) and the temp folder, cannot read credential folders, and can reach only the sites given with `--net`, each approved by the owner through an approval link (`frely task approve`; a schedule uses only the sites approved when it fires). A computer that cannot sandbox (Windows, Linux without bubblewrap) refuses to run tasks.
- **A fixed copy.** A run uses the definition as it was when it started. Definitions, run records and logs live under `~/.config/frely/tasks`, outside every task's folder, so a task cannot edit its own definition.
- **Result.** Status, exit code and the end of the log. `result --wait` waits at most 100 seconds; call it again if the run is still going.
- **Limits.** At most 8 runs at the same time on a computer (`FRELY_TASK_MAX_CONCURRENT` lowers or raises it, 1 to 64). Runs and logs are kept for 14 days; a log is capped at 8 MiB.

## Schedules

Five cron fields in an IANA time zone (default: this computer's). When both day-of-month and day-of-week are restricted, either matching is enough. The background service (`frely link on`) holds the clock. A slot missed while the computer was off or asleep runs once when the service is back, if it is at most a day old. A task still running from the last slot is skipped (a `skipped` run is recorded), not doubled.
