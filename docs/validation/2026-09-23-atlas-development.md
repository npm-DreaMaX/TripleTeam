# Atlas workflow development trials — 2026-09-23

These four trials used the actual TripleTeam CLI, Pi and `deepseek/deepseek-flash`. The task is the public, repository-local [Atlas demonstration](../ACCEPTANCE.md), with frozen tests in a pinned Docker image. No manual solution patches or answers were supplied to the solving sessions. This is a development series with runtime/configuration changes between trials, not a blind benchmark or comparative result.

## All trials retained

| Trial | Outcome | Observed cumulative tokens | Estimated model cost | Decisive observation |
| --- | --- | ---: | ---: | --- |
| v1 | BLOCKED | 418,850 | $0.04651626 | Missing search-tool cache was fixed, then the same run was continued; planning fell back to a whole-goal task and the writer exhausted the original 400k allocation. |
| v2 | BLOCKED | 264,313 | $0.09055152 | A 2M allocation allowed design; two independent critiques produced no valid final JSON, so implementation was not authorized. |
| v3 | BLOCKED | 273,153 | $0.090228144 | The first design response was empty; the second failed independent critique. Inspection also exposed probes that depended on downstream modules before their task stage. |
| v4 | BLOCKED | 344,316 | $0.074810664 | A four-task plan integrated and accepted the shared contract. The job-store probe design received a concrete correction; the next critique and subsequent SDK calls returned HTTP 402 Insufficient Balance. |

All 1,300,632 observed tokens and $0.302106588 estimated cost are retained, including failures. v1 and v4 contain incomplete usage records: their numbers are observed lower bounds, not provider invoices. Cache-read tokens count toward the runtime's cumulative token budget. No trial completed the entire Atlas workflow.

v4 used `medium` reasoning for planner/verifier/reviewer and `high` for the global implementer selection; earlier trials used the global high setting. Its execution was noninteractive. The first trial's explicit continuation after repairing the tool cache is a development intervention. Exact identities, configurations, runtime hashes when captured, phase usage, tree identities and outcomes are in the [machine-readable summary](2026-09-23-atlas-development.summary.json).

## Changes driven by these observations

- Same-session, bounded critique-format repair uses the remaining original allocation and cannot override a valid rejection.
- Independent probes distinguish TASK and FINAL stages, with at least one local probe and all frozen probes required on the final tree. Designer and critic receive increment scope, contracts and other task scopes. Real Git regression tests cover partial integration and downstream final failure.
- A valid critique remains useful: v4 rejected an assertion requiring the `error` key to be absent, because the specification also permits clearing it to null. The correction changed the proposed test before freezing, not an accepted test to fit a writer.
- Permanent account errors are classified from Pi's public metadata. The current implementation persists `PROVIDER_UNAVAILABLE`, stops new reservations and aborts active metered work. An explicit continuation reopens the provider attempt while retaining frozen budgets. This last fix was made after v4 and verified with actual JSONL RPC transport and SQLite regression fixtures; it has not been represented as another successful API trial.

At handoff, the provider account requires replenishment before another real full-workflow trial. Prior successful API deliveries remain separately recorded under their original revisions. Final engineering checks and package validation are in the [handoff record](2026-09-23-final-handoff.md).
