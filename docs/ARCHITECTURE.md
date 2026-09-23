# Architecture and runtime guide

**面向长程软件工程任务的自适应执行与可信交付系统**

A standalone CLI and local daemon for long-horizon agentic software engineering.

New runs first verify the frozen integration baseline on clean source views. Scoped checks and atomic obligations compile the proposed DAG into verifiable increments. A task-revision allocation decides whether additional test design is worth its cost while preserving mandatory delivery gates. Read-only exploration observations carry Git read dependencies and Pi-resolved context identity; their reuse never substitutes for acceptance evidence. See [research section 21](../调研.md) and [acceptance walkthrough](ACCEPTANCE.md).

A standalone, local-first runtime for reliably delegating long-horizon repository changes. It supports adaptive single- or multi-Agent execution, crash recovery, Git-native transactional integration and evidence-gated delivery on top of the Pi Agent Runtime.

A developer supplies a repository-level goal, acceptance checks and a resource budget. TripleTeam keeps the task graph, candidate code, failure evidence and delivery obligations across executions. Successful runs publish a normal Git delivery ref plus an exact evidence manifest. Incomplete runs retain a durable `BLOCKED` or `CANCELLED` report with their stopping reason.

The fixed Pi snapshot in [`vendor/pi`](../vendor/pi) owns the agent loop, provider/tool runtime, context, session history, compaction, runtime retry, RPC, steer, follow-up and abort. TripleTeam owns the goal contract, authoritative task graph, isolated workspaces, immutable candidates, evidence, review, serialized integration, completion decisions, crash reconciliation and delivery projection.

The frozen design and source research are in [调研.md](../调研.md). Exact upstream pins, licenses and reuse boundaries are in [UPSTREAM.md](../UPSTREAM.md) and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

Current implementation and assurance limits: [implementation report](IMPLEMENTATION_STATUS.md). Interview narrative and contribution boundaries: [面试材料](INTERVIEW.md). Evaluation setup: [benchmark adapters](BENCHMARK_ADAPTERS.md), [product baselines](BASELINE_COMPARISON.md).

## Architecture in one sentence

One local control plane adaptively schedules short-lived Pi executions against a durable task graph; code becomes deliverable only after an immutable Git candidate passes checks, optional independent review, integration CAS, post-integration checks and a final run-wide gate bound to the exact final tree.

## When to use it

Use Claude Code, Codex or Pi directly for a small interactive edit. Use this runtime when the change spans enough time, modules or failure cycles that you would otherwise need to supervise several sessions, replay test failures, recover interrupted work, reconcile worktrees and decide whether “done” is actually mergeable.

The runtime may execute one Implementer or several isolated Implementers. Agent count is an execution decision, not the product identity. Its conservative policy chooses `SINGLE`, `PARALLEL_TASKS`, `SERIALIZE`, or `DIVERSE_EXPLORATION` from dependency readiness, decomposability, sequentiality, semantic/interface coupling, uncertainty, integration/reverification cost, path ownership and the local resource budget. Sealed Candidates that write outside their scope are rejected before submission. Integration remains serialized and reverified.

## Agent shape

The product includes four overrideable profile templates:

- `explorer`: read-only, invoked for bounded planning investigations, distinct hypotheses or evidence-driven failure diagnosis.
- `planner`: read-only task-graph proposal producer.
- `implementer`: the only default writer, with one isolated worktree per Attempt.
- `reviewer`: independent read-only review selected by the acceptance contract.
- `verifier`: read-only specification design before implementation; a separate reviewer session critiques its executable probes. Plans and evaluation batches are persisted and gated by the Kernel. See [independent verification](INDEPENDENT_VERIFICATION.md).

These are templates, not four resident teammates. A run creates zero or more instances on demand. User and trusted project Pi Agent definitions can override these names or add new profiles. `PLAN / EXPLORE / IMPLEMENT / REVIEW` is stored separately from the selected Pi profile identity.

Deterministic verification, scheduling, integration and acceptance are control-plane services, not pretend Agents.

Every controlled Pi execution receives four product-owned coordination tools through one explicitly loaded thin extension: read scoped task/peer/mailbox/contract context, send typed messages, submit task-graph proposals, and request a narrowly typed human decision. Durable messages are also pushed into a live addressed Pi session through Pi's public `followUp` mechanism. The extension talks to an attempt-scoped loopback capability; it cannot write SQLite, choose acceptance checks, accept a Task, move the integration ref, or bypass epoch checks. This is a Worker adapter inside the standalone product, not the product host and not a Pi plugin distribution.

## Pi harness adaptation layer

The project reuses Pi instead of forking its harness, but it does add long-horizon-specific runtime integration around Pi's public surfaces:

- freezes effective profile prompts/tools and requested model settings, binds each Pi session to an authoritative Attempt and each process incarnation to a separate Execution;
- hashes the initial authoritative context into a context manifest and rejects resume under a different assignment;
- disables ambient extension discovery and injects only the selected profile tools plus the explicit attempt-scoped control adapter;
- resumes the original Pi session and preserved worktree after a daemon crash while fencing the dead Execution;
- reclaims a persistent session lock only when the previous owner process is provably dead, using the pinned upstream guard;
- persists typed messages before best-effort live delivery through Pi `followUp`;
- preserves sealed Candidate patches across retries and feeds check output, review findings, integration conflicts and predecessor identity into the next execution;
- accounts for Pi event usage and public session-statistic deltas, including summaries and failed invocations, against one shared run budget.

These are harness-level integration mechanisms in this repository; they are not claims that Pi's internal agent loop was reimplemented or patched.

## Requirements

- Node.js 22.19 or newer
- Git
- A working Pi configuration for the provider you already use

## Install and build

~~~bash
npm install --ignore-scripts
npm run check
npm test
npm run build
~~~

The seven Pi `0.86.1` packages used by TripleTeam are checked into `vendor/pi` at upstream commit `7f06f9c`, with source and official builds colocated. npm resolves them through local `file:` dependencies, so Pi does not silently follow upstream. The snapshot identity is recorded in [`vendor/pi/SNAPSHOT.md`](../vendor/pi/SNAPSHOT.md).

The package is marked private to prevent accidental registry publication. It builds three commands plus one explicitly loaded Worker adapter:

~~~text
dist/cli.js       tripleteam
dist/daemon.js    tripleteamd
dist/benchmark.js tripleteam-benchmark
dist/control-extension.js  explicit Worker-to-control-plane tool adapter
~~~

During development, replace `tripleteam` with `npm start --` and run the daemon with `npx tsx src/daemon/main.ts`.

## Use

Run a complete coding objective directly:

~~~bash
tripleteam run "add request validation and tests" /path/to/repository
~~~

Or keep a local daemon running for pause/resume and serialized control:

~~~bash
tripleteamd /path/to/repository
tripleteam run "add request validation and tests" /path/to/repository
~~~

Useful commands:

~~~text
tripleteam status [repository] [run-id]
tripleteam continue [repository] [run-id]
tripleteam retry <task-id> [repository]
tripleteam cancel "reason" [repository] [run-id]
tripleteam pause [repository]
tripleteam resume [repository]
tripleteam profiles [repository]
tripleteam events [repository] [run-id]
tripleteam messages [repository] [run-id]
tripleteam proposals [repository] [run-id]
tripleteam decisions [repository] [run-id]
tripleteam artifacts [repository] [run-id]
tripleteam result [repository] [run-id]
tripleteam message <attempt-id> "message" [repository]
tripleteam proposal accept <proposal-id> [repository]
tripleteam proposal reject <proposal-id> "reason" [repository]
tripleteam decision <request-id> <option> "rationale" [repository]
tripleteam doctor
~~~

`continue` first reconciles SQLite, Git refs, operation intents, worktrees, executions and Pi sessions. A recoverable writer keeps the same Attempt and epoch but receives a new Execution bound to the original Pi session. If authority or workspace identity no longer matches, the old Attempt is fenced and cannot submit. `result` idempotently materializes the terminal report; successful runs publish `refs/heads/tripleteam-deliveries/<run-id>` without switching the user's checkout.

## Replanning and failure memory

This runtime has durable execution memory, not an unrelated vector-memory subsystem. SQLite state, append-only domain events, Pi session history, typed messages, artifacts and Git objects survive process restarts. A retry receives a bounded failure packet containing prior Attempt reasons, failed check output, review findings and integration conflicts. Cross-project semantic memory and permanent Agent personas are intentionally absent.

An Implementer can communicate with peers or the user and can propose a changed task graph. A bounded refinement is accepted automatically only when it adds prerequisites reachable from the current task without expanding ownership, capabilities or verification policy. Goal revisions, cancellations and cross-task ownership changes become first-class `DecisionRequest` records. Agents may request a decision only for unresolved product semantics, cross-task semantic contracts or irreversible actions; ordinary engineering uncertainty must be investigated or replanned autonomously.

Failures are fingerprinted and classified. The policy selects `RETRY`, `REPLAN`, `DELEGATE`, `DIVERSE_EXPLORE`, `REBASE_REVERIFY`, `INFRA_RETRY`, `ESCALATE`, or `BLOCK`; an identical deterministic failure cannot consume attempts forever. Infrastructure check failures are retried in place before any new coding Attempt is spent. Writer prompts receive the current `CoordinationContract` (`provides`, `requires`, `assumptions`, owned scope, shared interfaces and evidence refs), prior findings and completed exploration reports.

## Project configuration

Place `.tripleteam.json` at the repository root. All fields are optional; detected `npm run check` and `npm test` scripts become default integration and final-run checks.

~~~json
{
  "execution": {
    "decisionMode": "interactive",
    "policy": "ADAPTIVE",
    "maxParallelism": 4,
    "maxExecutions": 64,
    "maxFinalRepairs": 2,
    "maxExplorationAttempts": 2,
    "enableContracts": true,
    "enableFailureAdaptation": true
  },
  "maxAttemptsPerTask": 3,
  "maxPlannerExplorations": 3,
  "maxDiverseExplorations": 2,
  "maxRepeatedFailureFingerprints": 2,
  "workerTimeoutMs": 2700000,
  "reviewRequiredFor": ["HIGH"],
  "profiles": {
    "explorer": "explorer",
    "planner": "planner",
    "implementer": "implementer",
    "reviewer": "reviewer"
  },
  "candidateChecks": [
    {
      "name": "diff-safety",
      "argv": ["git", "diff", "--check", "$BASE", "$SUBJECT"],
      "timeoutMs": 60000,
      "lane": "LIGHT_CHECK",
      "evidenceClass": "STRUCTURAL"
    }
  ],
  "integrationChecks": [
    {
      "name": "test",
      "argv": ["npm", "test"],
      "timeoutMs": 1200000,
      "lane": "HEAVY_CHECK",
      "evidenceClass": "BUILD"
    }
  ],
  "runChecks": [
    {
      "name": "full-check",
      "argv": ["npm", "run", "check"],
      "timeoutMs": 1200000,
      "lane": "HEAVY_CHECK",
      "evidenceClass": "BUILD"
    }
  ]
}
~~~

Check arguments are passed as an argv array, never through a shell. Supported substitutions are `$BASE`, `$SUBJECT` and `$RUN_INPUT`. Evidence classes are `STRUCTURAL`, `BUILD`, `BEHAVIORAL`, and `EXTERNAL`. The native commands above produce `STRUCTURAL_HANDOFF`. A behavioral/external declaration is promoted to verified delivery only with a protected acceptance oracle and a pinned, read-only Docker check. Missing configuration fails closed to `BUILD`; command names never establish behavioral correctness. See [verification configuration and trust boundaries](VERIFICATION.md).

## Adaptive compute and executable contracts

`execution.policy` selects reproducible conditions:

| Policy | Behavior |
| --- | --- |
| `SINGLE` | One full-goal task, no model planning/exploration at initialization, one writer at a time; retries may use the shared execution budget, with the same no-progress stop rules |
| `FIXED` | Fixed maximum parallelism after dependency, ownership and semantic gates |
| `HEURISTIC` | Conservative categorical coordination baseline |
| `ADAPTIVE` | Critical-path priority and an explicit marginal-benefit estimate from runtime duration, failures, verification cost and remaining budget |

The current estimator uses declared priors and observed run history. It is an interpretable heuristic, with every estimate persisted; it is not a trained or calibrated optimal policy. Runtime scheduling refills a slot as soon as a compatible task finishes. High semantic coupling remains serial. Verified requirements can relax medium coupling only for the specific named interfaces they prove.

A planner may publish a shared interface as an independently checkable task before its consumers. Each `provides` or `assumptions` key needs an obligation, for example:

```json
{
  "key": "export-job-schema",
  "artifactPaths": ["src/contracts/export-job.ts"],
  "checkNames": ["typecheck", "contract-tests"]
}
```

Those check names must exist in the frozen integration checks and carry build/behavioral evidence. A `requires` key resolves to one producer and creates a dependency. Contract fulfillment requires exact-tree checks plus actual Git blobs and modes; a message cannot fulfill it. A consumer binds the proof at its baseline. Updating a published artifact requires fresh checks for the accepted producer and its affected accepted dependency closure. Compatible code may evolve under the same frozen contract; changing the required semantics needs a new authorized goal/specification.

## Budgets and autonomous evaluation

Optional execution fields include `model`, `provider`, `reasoning`, `costLimitUsd`, `tokenLimit`, `deadlineMs`, `reservationUsd` and `reservationTokens`. Explicit model/provider/reasoning selections are applied through Pi and checked against its resolved state. If omitted, Pi selects its configured model; that mode does not freeze external Pi default settings. Benchmark runs require explicit model/provider, a frozen manifest and `decisionMode: "noninteractive"`.

Noninteractive runs reject human answers, messages, manual retries and user task-proposal decisions. They can record a DecisionRequest and return `BLOCKED`. Pausing, observing or cancelling a process does not grant additional compute or change the frozen contract. Changed project configuration or frozen profile identity must be restored before continuation, or used in a new run.

All model roles share admission reservations and observed cost/token limits. Live usage is persisted before success, and interrupted work retains an explicit unknown-cost reservation. Unknown prices cannot count as free compute in a dollar-limited run. Limits are soft at an in-flight provider-request boundary; they do not guarantee an exact invoice ceiling. `deadlineMs` also bounds checks; cleanup can finish after cancellation. Check and integration machine time is reported separately from model API dollars.

Formal cost/quality gains over Codex or Claude Code remain unmeasured. The [sealed blind exercise](validation/2026-09-22-blind-featurebench.md) used a fresh-context subagent and an independent official grader. It was unresolved and is a development check, not a Pi runtime score.

## Local state and safety boundaries

State is outside the target repository:

~~~text
$XDG_STATE_HOME/tripleteam/projects/<repository-hash>/
  state.db
  daemon.json
  sessions/
  worktrees/
  artifacts/
  logs/
~~~

Without `XDG_STATE_HOME`, the root is `~/.local/state/tripleteam`. Set `TRIPLETEAM_STATE_DIR` to override it.

- The daemon binds only to `127.0.0.1` and uses a mode-0600 bearer-token endpoint file.
- Each project state root is mode 0700; the SQLite database, evidence logs, manifests and generated Pi system prompts are mode 0600.
- Each writer is assigned a separate worktree; the input, including dirty and untracked files, is frozen into a Git snapshot. Candidate scope checks control admission to integration. Worktrees are not an operating-system sandbox for a writer with shell access.
- Candidate and integration identities are Git commit/tree hashes. The integration ref moves through `git update-ref` compare-and-swap.
- Verification stdout/stderr are registered as content-hashed artifacts with producer provenance.
- Controlled Pi workers disable ambient extension discovery. Explicit product integrations can still be supplied deliberately; trusted project profile discovery uses Pi's own trust store.
- The built-in coordination adapter is loaded explicitly over a random attempt-scoped loopback capability. Agent messages and task changes still enter as observations/proposals and pass through the Command Kernel.
- Task proposals are bounded and schema-validated before persistence. Agents cannot supply acceptance contracts: the control plane injects pinned checks and review policy. Only narrow prerequisite refinements can be applied automatically; material changes require a user decision.
- Cancellation atomically fences live Attempts and rejects submitted-but-unpublished Candidates. A Run is never reported cancelled while an integration operation may already have crossed the Git publication boundary; that state must be reconciled first.
- Run completion publishes a normal Git delivery branch and an immutable `verified-delivery/v2` manifest containing the frozen goal contract, final commit/tree, delivery class, task outcome and evidence provenance.
- A message, Agent exit, review prose or “done” statement cannot set a Task to `ACCEPTED`.

## Development invariants

Before changing the control plane, preserve these boundaries:

- No reimplementation of Pi sessions, context, tools, providers, compaction or agent loop.
- No Agent writes authoritative SQLite state directly.
- One active writer Attempt per Task; every candidate submission validates Attempt identity and epoch.
- Task scopes are canonical repository-relative ownership prefixes; out-of-scope Candidate paths never reach integration.
- Evidence is valid only for its exact tree hash.
- Task completion requires a committed integration record and acceptance decision.
- Run completion requires fresh checks on the final integration tree and no live work.
- Dynamic replanning enters as a versioned proposal and is atomically accepted or rejected by an authorized actor.
- The Kernel derives required checks and reviews from the frozen contract; callers cannot weaken acceptance by omitting evidence identifiers.
- Additional Agents are admitted only by a persisted, explainable coordination decision; missing or stale semantic contracts force conservative serialization.

Run the contract suite before every handoff:

~~~bash
npm run check
npm test
npm run build
~~~
