# The TripleTeam terminal

[← README](../README.md)

Open TripleTeam in a Git repository and type what you want to build. The workspace shows your goal, current work and the next action. Commands remain available while an execution is running.

`/why` explains the latest coordination decision, live writer count, baseline observations, per-task verification allocation and final checks on the current integration tree. For scripts use `tripleteam why [repository] [run-id] --json`.

`tripleteam demo create <new-directory> [immutable-python-image]` creates a real repository task. It is separate from the sample UI preview. See [the runnable demonstration](ACCEPTANCE.md).

```bash
cd /path/to/your/git/repository
tripleteam
```

```text
› Add pagination to the search API and cover the edge cases
```

Use `tripleteam shell /path/to/repository` to select a repository, or `tripleteam demo` to try the interface with labeled sample data. The demo needs no repository or credentials, makes no model calls and writes no files.

![Interactive shell showing sample data](assets/terminal.svg)

## Everyday commands

| Command | Action |
| --- | --- |
| An objective, or `/new <objective>` | Start a new goal |
| `/new` | Prepare to enter your next goal |
| `/status [run-id]` | Return to progress and the next action |
| `/tasks [number]` | List the plan; inspect a task's scope and attempt |
| `/continue [run-id]` | Recover and continue a saved run |
| `/delivery` | Show the terminal result, delivery ref, tree and evidence |
| `/models` | Show effective model selections for the next run |
| `/settings` | Show common settings and configuration groups |
| `/help [command or group]` | Browse commands and their syntax |
| `/quit` | Close the interface when local work is idle |

The default view omits internal IDs and raw event payloads. Details are available through `/tasks <number>`, `/events` and the inspection commands below. A passed check and an accepted task have separate meanings; the final delivery label comes from the recorded delivery report.

## Models and settings

Model selections can differ by role: `planner`, `explorer`, `implementer`, `reviewer` and `verifier`.

```text
/models
/models anthropic
/model implementer <provider>/<model> high
/model reviewer <provider>/<model> low
/model all <provider>/<model> medium
/model reviewer default
```

`/models <filter>` reads Pi's local model registry and shows whether authentication is configured. This does not test connectivity. `/profiles` shows the effective role selections, including profile inheritance. `default` restores inheritance for the selected role; `all default` clears all role overrides. Provider credentials belong in Pi's configuration or environment, outside project settings.

`/settings` starts with strategy, parallelism, token and cost budgets, and verification mode. Browse one of the six groups:

| Command | Settings |
| --- | --- |
| `/settings execution` | Global model, reasoning, coordination, budgets and planning limits |
| `/settings roles` | Model, provider and reasoning overrides by role |
| `/settings assurance` | Independent specification and counterexample verification |
| `/settings checks` | Candidate, integration and final checks; review requirements |
| `/settings profiles` | Agent profile names by role |
| `/settings recovery` | Worker, attempt, lease and recovery limits |
| `/settings all` | Every supported setting |

Query an exact key to see its description, choices and value. Complex check arrays display the complete JSON so you can inspect the command and evidence requirements before editing.

```text
/settings execution.maxParallelism 2
/settings execution.tokenLimit 1000000
/settings execution.costLimitUsd 10
/settings execution.policy SINGLE
/settings candidateChecks
/settings reviewRequiredFor ["NORMAL","HIGH"]
/settings execution.roles.planner {"provider":"example","model":"model-id","reasoning":"high"}
/settings reset execution.costLimitUsd
```

Values accept numbers, booleans, strings or JSON. Settings are validated and saved atomically in `.tripleteam.json`. **Changes apply to new runs.** Existing runs retain their frozen models, budgets, checks and other runtime configuration, including after recovery. A running daemon reloads the file when starting a new run. See [Configuration](CONFIGURATION.md) for the full schema and check examples.

## Control and decisions

| Command | Action |
| --- | --- |
| `/pause` | Pause new dispatch; currently active work continues |
| `/resume` | Resume dispatch after a pause |
| `/cancel <reason>` | End the selected run |
| `/retry <task-number-or-id>` | Retry a blocked task |
| `/decisions` | Show pending questions and numbered choices |
| `/decision <number-or-id> <option-number-or-value> "reason"` | Record your answer and continue when allowed |
| `/message <attempt-id> "direction"` | Record direction for a live attempt |
| `/proposal accept <id>` | Accept a proposed task change |
| `/proposal reject <id> "reason"` | Reject a proposed task change |

These commands call the same authority checks as the headless CLI. A frozen noninteractive run rejects human answers and steering. `/tasks <number>` shows the active attempt ID for `/message`. `/decisions` shows the options for `/decision`.

Only one execution request can run from a shell at a time. `/status`, `/tasks`, settings and control commands remain usable. To start another goal, wait for the current request to settle or cancel it first.

## Inspect the workspace

| Command | Action |
| --- | --- |
| `/events` | Read recent recorded activity |
| `/diagnostics` | Inspect subprocess diagnostics from this interface session |
| `/messages` | Read coordination messages |
| `/proposals` | Inspect proposed task changes |
| `/artifacts` | List verification artifacts and their locations |
| `/profiles` | Inspect effective models by role |
| `/doctor` | Check local Git, Pi and search tools |
| `/init` | Snapshot the repository without starting an agent |

The status projection opens SQLite read-only and does not initialize or migrate a run. Starting work and changing settings are explicit actions. Delivery refs can be reviewed or merged through your usual Git workflow; the CLI does not switch or merge your checkout automatically.

While the shell is open, subprocess stderr goes to a private local diagnostic log so it does not interrupt the input area. `/diagnostics` shows recent output and the file location; the log path is also printed on exit. Logs are capped at 2 MiB per shell session. Request failures still appear in the main view. No log is created until diagnostic output is received, and demo mode does not capture or write logs.

## Keyboard and exit behavior

| Key | Action |
| --- | --- |
| `Enter` | Submit the goal or command |
| `Tab` | Complete a slash command; show matching commands |
| `Up` / `Down` | Recall input history |
| `PgUp` / `PgDn` | Scroll long command output |
| `Esc` | Clear the input |
| `Ctrl+D` on empty input | Request `/quit` |
| `Ctrl+C` | Restore the terminal and interrupt the CLI process |

Without a daemon, work runs in this CLI process. `/quit` while local work is active explains how to `/cancel <reason>` or use `Ctrl+C`, followed by `/continue` on the next visit. Closing a view does not turn local work into a background job.

An interrupted shell exits with status `130` for `Ctrl+C`/`SIGINT`, or `143` for `SIGTERM`, after restoring the terminal and diagnostic stream. Interruption does not mark the run successful or record a cancellation.

For work that should continue after the interface closes, first start the local daemon in a dedicated or managed terminal:

```bash
tripleteamd /path/to/repository
tripleteam shell /path/to/repository
```

The shell discovers it automatically. `/quit` closes the client interface; the daemon continues its work. Keep the daemon itself running. `/pause` pauses new resource dispatch in either mode.

The input stays in one place, and long output scrolls above it. Widths are measured in terminal cells, including Chinese text. `NO_COLOR=1 tripleteam` disables product colors. Status uses readable labels as well as color. [Narrow terminal preview](assets/terminal-narrow.svg).

## Headless commands and scripts

All original commands remain available:

```bash
tripleteam run "your engineering objective" [repository]
tripleteam continue [repository] [run-id]
tripleteam status [repository] [run-id]
tripleteam result [repository] [run-id]
tripleteam init [repository]
tripleteam models [filter]
tripleteam profiles [repository]
tripleteam doctor

# Settings/model edits use the current repository.
tripleteam settings [key [value]]
tripleteam settings reset KEY
tripleteam model ROLE PROVIDER/MODEL [reasoning]

tripleteam pause [repository]
tripleteam resume [repository]
tripleteam retry TASK_ID [repository]
tripleteam cancel "reason" [repository] [run-id]
tripleteam decisions [repository] [run-id]
tripleteam decision REQUEST_ID OPTION "rationale" [repository]
tripleteam message ATTEMPT_ID "direction" [repository]
tripleteam proposal accept PROPOSAL_ID [repository]
tripleteam proposal reject PROPOSAL_ID "reason" [repository]
tripleteam events [repository] [run-id]
tripleteam messages [repository] [run-id]
tripleteam proposals [repository] [run-id]
tripleteam artifacts [repository] [run-id]
```

Piped output is JSON by default for data commands. `--json` selects JSON explicitly; `--plain` produces static human-readable output. Use `--` before literal positional values that match an output flag.

```bash
tripleteam status --json
tripleteam result --json > delivery.json
tripleteam settings execution.tokenLimit 1000000 --json
tripleteam status --plain
tripleteam demo --plain
```

`tripleteam dashboard [repository] [run-id]` and `tripleteam status --watch` remain available as observation-only views. Their keys are `1`/`2`/`3` for overview, tasks and activity; `j`/`k` to scroll; `q`/`Esc` to close. A headless `run` command in a TTY uses this live view and prints the result when work settles; `q` closes only that view while the foreground command continues.

Without global linking, use `node /path/to/TripleTeam/dist/cli.js` or `npm start -- <command>` from the source checkout. See the [README](../README.md) for installation.
