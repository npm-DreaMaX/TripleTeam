# Interactive terminal and live runtime validation — 2026-09-23

This exercise entered a public engineering goal through the default TripleTeam terminal, used the actual Pi runtime and DeepSeek API, and inspected progress while execution was active. It used the same controlled range-parser baseline as the [earlier runtime checks](2026-09-23-controlled-runtime.md). Both development trials are retained.

## Actual runs

| Trial | Run | Result | Recorded model cost estimate |
| --- | --- | --- | --- |
| Initial terminal run | `3cdf2320-6237-4662-8a49-aa7fefcf3463` | `BLOCKED` during specification design | $0.040562124 |
| Run after protocol-feedback and terminal fixes | `416ef279-6fe8-48f8-b403-7f0b38cacf97` | `VERIFIED_DELIVERY` | $0.037247772 |

The first verifier used `source` instead of the required `FILE.path` field. The correction then returned invalid JSON and exhausted the frozen two-attempt allowance. The implementation did not bypass validation. The subsequent runtime adds complete source examples, precise field diagnostics and bounded malformed-response retention; it preserves the original retry limit and acceptance rules.

The second run completed from the same stub baseline in about 162 seconds including terminal setup, inspection and exit. It passed **24 checks**: three executable controls, eighteen repeated probes across candidate/integration/final subjects, and three protected acceptance checks. Independent candidate review also completed. No human decision answers, solution edits or runtime steering were supplied. Read-only `/settings`, `/status`, `/tasks` and `/delivery` commands were exercised while the shell remained responsive.

| Identity | Value |
| --- | --- |
| Baseline commit | `51e6bd93d51f0aeffd08b8f975dfb013d87e8169` |
| Baseline tree | `2a047e59f822b2850f70c7e7626922e8f126da0d` |
| Delivered commit | `13a5e6e3f243f3791585a56638fed37e74e897a2` |
| Delivered tree | `83eb643ad0e44d6d37f6eddc628b532d35b32ebb` |
| Model | `deepseek/deepseek-flash`, high reasoning |
| Policy | `SINGLE`, noninteractive, required independent probes |

Checks and probes used the pinned Docker image documented in the earlier fixture. The writer ran in a host worktree. Pricing uses the recorded provider rate table, including cache reads; these values are estimates rather than billing receipts. The failed trial remains part of development cost.

## Terminal behavior

Real PTY checks covered Chinese input, command completion, history, scrolling, an 80-to-40-column resize, settings persistence, and local daemon control. Wide and narrow README illustrations were generated from the actual renderer and visually inspected.

| Exit operation | Actual process exit code | Terminal restored |
| --- | --- | --- |
| Keyboard Ctrl+C | 130 | Yes |
| OS SIGINT | 130 | Yes |
| OS SIGTERM | 143 | Yes |
| `/quit` | 0 | Yes |

The signal test exposed and corrected an earlier race in re-sending a signal after stopping the terminal. Interruption is now returned explicitly to the CLI boundary. It does not mark a run accepted or cancelled. The demo created no files. A separate daemon fixture confirmed that closing the client does not send a cancellation request.

Both real API sessions displayed their delivery report and exited normally with `/quit`, without forced interruption. Diagnostics stay in a bounded local log while the terminal is active and stderr is restored on exit. A blocked delivery presents its reason and recovery commands; a verified delivery presents its actual Git ref and tree.

The [machine-readable summary](2026-09-23-terminal-runtime.summary.json) contains both outcomes, phase usage, checks, runtime hashes, terminal commands and transcript hashes. This is a controlled integration exercise; it does not estimate benchmark accuracy, parallel speedup or comparative product cost.
