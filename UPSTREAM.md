# Vendored and upstream reuse inventory

The ignored `upstream/` directory may contain scratch clones used only for research. The Pi packages TripleTeam actually uses are copied into `vendor/pi` with both source and official build output; all Pi runtime dependencies resolve through those local `file:` packages. Other third-party integrations remain exact package or immutable Git pins.

## Runtime dependencies

| Upstream | Pin | License | Reused responsibility |
|---|---:|---|---|
| earendil-works/pi | seven used packages vendored at 0.86.1 / `7f06f9c` | MIT | Agent loop, RPC client, process/session lifecycle, providers, tools, context, compaction, events, SQLite capability |
| mjakl/pi-subagent | HTTPS commit tarball 8e1b40b; source declares 3.0.3, npm latest is 3.0.1 | MIT | Agent definition discovery and persistent-session locking through a thin compatibility adapter |

## Design/source references

These are reviewed locally but are not automatically runtime dependencies:

| Upstream | Reviewed commit | License | What is borrowed |
|---|---:|---|---|
| tintinweb/pi-subagents | e955e29 (0.19.0) | MIT | Agent-manager lifecycle, concurrency queue, strict worktree startup, pre-cleanup gate, resume/steer and mailbox lessons |
| tintinweb/pi-tasks | 29180d7 | MIT | Task-list UX; its completion coupling is rejected |
| QuintinShaw/pi-dynamic-workflows | bd27cf0 (3.13.0) | MIT | Versioned head + append-only hash-chain log, writer mutex/run lease, checkpoint/resume, orphan settlement and workflow-gate patterns |
| jayminwest/warren | ae4028d | MIT | Control-plane separation, reconciliation and judge boundaries |
| gastownhall/gastown | 649b832 | MIT | Durable work ledger, patrol and integration-queue patterns |
| teelicht/pi-superagents | c09aa1c (1.14.3) | MIT | Recon/research/implementation/review/debug role comparison; no runtime dependency |

## Default profile decision

Current source comparison supports four built-in product defaults, not a fixed four-agent team:

- Pi's official subagent example ships `scout`, `planner`, `worker`, and `reviewer`, including scout→planner→worker and worker→reviewer→worker chains.
- Claude Code currently ships Explore, Plan, and general-purpose but lets any built-in or custom definition become a teammate.
- tintinweb/pi-subagents ships general-purpose, Explore, and Plan plus arbitrary custom definitions.
- Warren treats roles as prompt/policy configuration over a harness, while its judge is an optional observer.
- pi-superagents has more domain-specific profiles because it targets Superpowers workflows; those names are not a universal role ontology.

This product therefore includes `explorer`, `planner`, `implementer`, and `reviewer` as overrideable defaults. Runtime instances are created only when the task graph and policy require them; workflow function and Pi profile identity are stored separately.

## Why the product does not run inside a subagent extension

Existing extensions assume Pi owns the parent session and extension context. This product must also operate when its CLI or daemon starts the run directly, and it must retain authoritative state after any Pi process exits. Therefore:

- Pi is launched and controlled through its public SDK/RPC surface.
- Reusable extension modules are consumed only where they expose a coherent library boundary.
- Extension-managed task completion and shared mutable state are not imported.
- The core product does not ship as a Pi extension. Any independently distributed Pi entry integration is only allowed to be a thin client of the same standalone daemon and can never contain control-plane state.

Controlled workers pass Pi's public `--no-extensions` flag, which disables ambient extension discovery while still allowing explicitly supplied extension paths. This makes a read-only profile's tool boundary meaningful without reimplementing Pi's tool runtime. Project-level agent definitions are loaded only after Pi's own project trust store approves the repository.

The product uses Pi's official `defineTool` / `registerTool` extension API for one bundled Worker adapter. It exposes only scoped coordination context, typed messaging, and task-change proposals over an attempt-scoped loopback capability. Pi still owns tool dispatch and validation; the adapter has no direct SQLite or integration-ref access. This explicit child-process adapter does not make the standalone control plane a Pi plugin.

The current tintinweb source no longer silently continues in the main checkout when its `AgentManager` requested worktree creation fails: the low-level helper returns `undefined`, and the manager turns that into a startup error. Its cleanup still performs implicit commit/branch creation and best-effort removal, so the product does not directly use that helper for authoritative candidates. This is a domain-boundary decision, not a claim that the current upstream lacks strict startup handling.

Pi Dynamic Workflows 3.13.0 is treated as mature durability prior art. The product rejects its JavaScript workflow DSL as the authoritative coding domain only because workflow-call success is not the same fact as candidate identity, post-integration verification and acceptance.

## Claude Code reference boundary

Claude Code Subagents and Agent Teams are the primary product/coordination semantics reference: isolated contexts, delegation, dynamic teammate count, shared task visibility, teammate messaging, lead coordination, background work, reusable subagent definitions and worktree-based parallelism. Warren is the primary open-source control-plane correctness reference; Pi remains the executable runtime source. Publicly documented Claude behavior may be adopted directly, and plausible internal mechanisms may be inferred and implemented when the inference is clearly identified. Because the implementation source is not public, this project does not claim source-level compatibility or identical internals.

Every executable runtime mechanism comes from one of two places:

- Pi or a pinned Pi ecosystem package when a coherent reusable implementation exists.
- This repository's control plane when the mechanism is an authoritative-state invariant that Pi does not own.

Claude-inspired behavior is implemented with Pi-owned runtime primitives where possible and with this repository's control-plane primitives where authority, evidence, or recovery semantics are required.

## Current harness adaptations

The audit follow-up continues to consume the same fixed upstream snapshot. Public RPC events and `getSessionStats` supply incremental usage and session-total reconciliation; the control plane owns shared admission reservations, partial/unknown accounting and run limits. Public model/reasoning settings are applied and checked against resolved state. The effective profile and initial context identity are frozen for new attempts and resume, while new failure evidence is supplied as an observation through Pi.

Candidate replay, contract evidence, retry diagnosis, verification and terminal acceptance are repository-level policies. They do not replace Pi's loop, session, compaction, provider retry or cancellation implementation. No Codex or Claude Code worker backend is implemented. Current implementation evidence is in [the implementation report](docs/IMPLEMENTATION_STATUS.md).

## Snapshot rule

Pi does not update automatically. `vendor/pi/SNAPSHOT.md` records its identity, and the repository lockfile resolves local packages rather than registry Pi packages. A deliberate replacement of the snapshot must preserve the upstream license and pass Pi adapter contracts plus the complete TripleTeam suite. If an internal subpath disappears, only its adapter may change; domain and control-plane packages must remain unaffected.
