# Project instructions

Read 调研.md before changing architecture-sensitive code.

This is a standalone local-first runtime for long-horizon agentic software engineering. It supports adaptive single-/multi-Agent execution, but is not positioned as a multi-agent framework. It is not a Pi plugin, a CooperBench patch, or a generic multi-harness abstraction.

## Hard architecture rules

- Pi owns the agent loop, providers, tools, sessions, history, context, compaction, retry, abort, steer, and runtime events.
- Reuse the vendored Pi public APIs and pinned subagent package before writing runtime glue.
- Treat Claude Code as the primary closed-source reference for collaboration product semantics, but not as the sole system-architecture or control-plane source. Separate documented behavior, evidence-backed implementation inference, and this project's own decisions.
- It is valid to infer and implement mechanisms suggested by Claude Code's public behavior when the inference is useful and explicitly labeled; do not claim source-level parity or reimplement Pi-owned runtime capabilities.
- Map adopted Claude collaboration mechanisms into this product's authoritative Task/Attempt/Evidence model and drive execution through Pi.
- Third-party integration lives behind thin adapters and contract tests.
- Never let an agent, lead, process exit, or chat message mark a task accepted.
- Keep GoalContract, Task, Attempt, Execution, Pi Session, Workspace, Candidate, Check, Review, Integration, Acceptance, and terminal DeliveryReport distinct.
- Every writer attempt has an epoch. Reject stale writes.
- Every candidate and check is bound to an exact Git tree.
- The integration ref is updated serially.
- SQLite is the single authoritative store.
- CooperBench is an evaluator adapter only.

## Dependency discipline

- Pi is intentionally vendored at `vendor/pi` as a fixed MIT-licensed source/build snapshot. Do not automatically sync it with upstream or replace its local `file:` dependencies with floating registry versions.
- Pin every non-vendored direct dependency to an exact version or immutable Git commit.
- Before implementing any agent lifecycle, profile discovery, session, tool, event forwarding, cancellation, or concurrency helper, inspect `vendor/pi` and the pinned Pi-plugin sources for a reusable implementation.
- Do not import undocumented Pi internals when a public export exists.
- Internal subpaths from a third-party package require an adapter, a pinned version, and a contract test.
- Keep `upstream/` ignored; it is scratch research material. The authoritative Pi snapshot is `vendor/pi`.
- Install dependencies with npm install --ignore-scripts.

## Checks

Run before handing off implementation changes:

~~~bash
npm run check
npm test
~~~
