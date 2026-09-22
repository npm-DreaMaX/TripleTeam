# The TripleTeam terminal

[← README](../README.md)

TripleTeam is an independent CLI with a live terminal workspace. Its screens are projections of the authoritative task state; opening or closing the dashboard does not accept a task or cancel a run.

## Start here

```bash
tripleteam demo                  # Sample UI; no credentials, no repository, no model calls
tripleteam doctor                # Local dependency check
tripleteam models anthropic      # Inspect model IDs
tripleteam profiles /path/repo   # Effective model choices by role
```

After configuring your provider and the target repository, run:

```bash
cd /path/to/your/git/repository
tripleteam run "Implement your engineering objective"
```

A terminal run opens the live dashboard and prints its result when execution settles. `q` hides the panel while the command continues. `Ctrl+C` interrupts the foreground process; `continue` reconciles durable state on the next execution.

## Observe work

```bash
tripleteam                       # Open the latest run in the current repository
tripleteam dashboard /path/repo
tripleteam dashboard /path/repo RUN_ID
tripleteam status
tripleteam status --watch
```

| Key | Action |
| --- | --- |
| `1`, `2`, `3` or `Tab` | Overview, tasks, activity |
| `j` / `k` or arrow keys | Scroll task/activity entries |
| `q` / `Esc` | Close the view without changing the run |
| `Ctrl+C` | Restore the terminal and interrupt the foreground process |

The view refreshes from SQLite using a read-only connection. It does not initialize, migrate or modify the observed project. Narrow windows use a compact layout; states have text labels as well as color. `NO_COLOR=1` disables color.

Task acceptance and passed-check counts are separate. A completed task count does not generate a verified-delivery label; delivery classification comes from the terminal report. Dollar amounts in a live view are **recorded usage**, not an invoice total.

## Resume, inspect and deliver

```bash
tripleteam continue [repository] [run-id]
tripleteam result [repository] [run-id]
tripleteam events [repository] [run-id]
tripleteam artifacts [repository] [run-id]
tripleteam messages [repository] [run-id]
```

`result` shows the delivery ref, final tree and evidence-manifest path. Review or merge that ref through your normal Git workflow. TripleTeam does not automatically switch or merge into your checkout.

## Decisions and control

```bash
tripleteam decisions [repository] [run-id]
tripleteam decision REQUEST_ID OPTION "rationale" [repository]
tripleteam retry TASK_ID [repository]
tripleteam cancel "reason" [repository] [run-id]
tripleteam message ATTEMPT_ID "direction" [repository]
tripleteam proposals [repository] [run-id]
tripleteam proposal accept PROPOSAL_ID [repository]
tripleteam proposal reject PROPOSAL_ID "reason" [repository]
```

These commands use the same authority checks as the runtime. A frozen noninteractive run rejects human answers and steering.

## Local daemon

Keep execution in a dedicated terminal:

```bash
tripleteamd /path/to/repository
```

From another terminal:

```bash
tripleteam run "your goal" /path/to/repository
tripleteam dashboard /path/to/repository
tripleteam pause /path/to/repository
tripleteam resume /path/to/repository
```

The CLI discovers the local daemon automatically. `pause` stops new dispatch; active work keeps its existing authority. For background runs, keep the daemon in a managed terminal session such as your usual terminal multiplexer.

## Scripts and accessibility

```bash
tripleteam status --json
tripleteam result --json > delivery.json
tripleteam status --plain
NO_COLOR=1 tripleteam dashboard
```

Piped output is JSON by default for data commands. `--plain` requests human-readable static output. Interactive dashboards require a TTY. Use `--` before literal positional values that happen to match an output flag.

## Build without global linking

```bash
node /path/to/TripleTeam/dist/cli.js demo
node /path/to/TripleTeam/dist/cli.js run "your goal" /path/to/repository
node /path/to/TripleTeam/dist/daemon.js /path/to/repository
```

The development equivalent is `npm start -- <command>`. Installation and model setup are in the [README](../README.md) and [configuration guide](CONFIGURATION.md).
