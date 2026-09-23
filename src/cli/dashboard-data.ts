import { access } from "node:fs/promises";
import { createNodeSqliteFactory } from "@earendil-works/pi-session-backend-sqlite-node";
import { executionPolicyFor } from "../config/execution.ts";
import { projectPaths } from "../config/paths.ts";
import { type CheckCommand, checkCommandVersion } from "../config/project.ts";
import { ControlCatalog } from "../control/catalog.ts";
import type { ControlDatabase } from "../store/database.ts";
import { MIGRATIONS } from "../store/schema.ts";

export interface DashboardSnapshot {
	repository: string;
	sample?: boolean;
	run: {
		id: string;
		state: string;
		objective: string;
		integrationHead: string;
		createdAt: string;
		updatedAt: string;
		reason: string | null;
	} | null;
	policy: string;
	maxParallelism: number;
	model: string;
	tasks: Array<{ id: string; title: string; state: string; scope: string; risk: string; epoch: number }>;
	checks: Record<string, number>;
	contracts: { total: number; satisfied: number };
	usage: { cost: number; tokens: number; unsettled: number; executions: number; live: number; limit?: number };
	coordination: { mode: string; rationale: string } | null;
	explanation: {
		liveWriters: number;
		baseline: string;
		finalChecks: Array<{ name: string; state: string }>;
		allocations: Array<{ task: string; action: string; reason: string }>;
		observationsReused: number;
	};
	decisions: Array<{ id: string; question: string; options: string[] }>;
	events: Array<{ id: string; type: string; time: string; detail: string }>;
	delivery: { result: string; ref: string | null; tree: string; manifest: string } | null;
}

export function emptyDashboard(repository: string): DashboardSnapshot {
	return {
		repository,
		run: null,
		policy: "ADAPTIVE",
		maxParallelism: 4,
		model: "Configured provider",
		tasks: [],
		checks: {},
		contracts: { total: 0, satisfied: 0 },
		usage: { cost: 0, tokens: 0, unsettled: 0, executions: 0, live: 0 },
		coordination: null,
		explanation: { liveWriters: 0, baseline: "Not recorded", finalChecks: [], allocations: [], observationsReused: 0 },
		decisions: [],
		events: [],
		delivery: null,
	};
}

/** Uses Pi's public read-only SQLite adapter. Viewing never initializes or migrates a project. */
export async function readDashboard(repository: string, runId?: string): Promise<DashboardSnapshot> {
	const file = projectPaths(repository).database;
	try {
		await access(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !runId) return emptyDashboard(repository);
		throw error;
	}
	const sql = await createNodeSqliteFactory().openReadOnly(file);
	try {
		sql.exec("PRAGMA busy_timeout = 1000");
		const version = sql.prepare("PRAGMA user_version").get<{ user_version: number }>()?.user_version;
		if (version !== MIGRATIONS.at(-1)?.version)
			throw new Error("Project state needs migration. Run tripleteam continue first.");
		sql.exec("BEGIN");
		const database: ControlDatabase = { sql, path: file, close: () => sql.close() };
		const catalog = new ControlCatalog(database);
		const run = runId ? catalog.getRun(runId) : catalog.latestRun();
		if (!run) return emptyDashboard(repository);
		const snapshot = emptyDashboard(repository);
		const timestamps = sql
			.prepare("SELECT created_at, updated_at FROM runs WHERE id = ?")
			.get<{ created_at: string; updated_at: string }>(run.id);
		snapshot.run = {
			id: run.id,
			state: run.state,
			objective: run.objective,
			integrationHead: run.integrationHead,
			createdAt: timestamps?.created_at ?? "",
			updatedAt: timestamps?.updated_at ?? "",
			reason: run.terminalReason,
		};
		const policy = executionPolicyFor(run.goalContract);
		snapshot.policy = policy.policy;
		snapshot.maxParallelism = policy.maxParallelism;
		snapshot.model = policy.model ? [policy.provider, policy.model].filter(Boolean).join(" / ") : "Pi configured model";
		snapshot.tasks = catalog.listTasks(run.id).map((task) => ({
			id: task.id,
			title: task.title,
			state: task.state,
			scope: Array.isArray(task.scope) ? task.scope.join(", ") : ".",
			risk: task.riskClass,
			epoch: task.attemptEpoch,
		}));
		snapshot.checks = Object.fromEntries(
			sql
				.prepare("SELECT state, COUNT(*) AS count FROM check_runs WHERE run_id = ? GROUP BY state")
				.all<{ state: string; count: number }>(run.id)
				.map((row) => [row.state, row.count]),
		);
		snapshot.contracts = sql
			.prepare(
				"SELECT COUNT(*) AS total, COALESCE(SUM(state = 'SATISFIED'), 0) AS satisfied FROM coordination_contracts WHERE run_id = ?",
			)
			.get<{ total: number; satisfied: number }>(run.id) ?? { total: 0, satisfied: 0 };
		const usage = sql
			.prepare(
				"SELECT COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(cache_read_tokens,0) + COALESCE(cache_write_tokens,0)), 0) AS tokens FROM usage_records WHERE run_id = ? AND kind = 'AGENT'",
			)
			.get<{ cost: number; tokens: number }>(run.id);
		const executions = sql
			.prepare(
				"SELECT COUNT(*) AS executions, COALESCE(SUM(e.state IN ('STARTING','LIVE')), 0) AS live FROM executions e JOIN attempts a ON a.id = e.attempt_id WHERE a.run_id = ?",
			)
			.get<{ executions: number; live: number }>(run.id);
		const unsettled =
			sql
				.prepare(
					"SELECT COUNT(*) AS count FROM compute_reservations WHERE run_id = ? AND state IN ('HELD','INTERRUPTED')",
				)
				.get<{ count: number }>(run.id)?.count ?? 0;
		snapshot.usage = {
			cost: usage?.cost ?? 0,
			tokens: usage?.tokens ?? 0,
			unsettled,
			executions: executions?.executions ?? 0,
			live: executions?.live ?? 0,
			limit: policy.costLimitUsd,
		};
		snapshot.coordination =
			sql
				.prepare(
					"SELECT mode, rationale FROM coordination_decisions WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
				)
				.get<{ mode: string; rationale: string }>(run.id) ?? null;
		const actions = catalog.listControlActions(run.id);
		const baseline = actions.findLast((action) => action.kind === "BASELINE_VERIFIED");
		const receipt = baseline ? (JSON.parse(baseline.detail_json) as { checks: Array<{ state: string }> }) : null;
		const tree = sql
			.prepare("SELECT integration_tree_hash AS tree FROM runs WHERE id=?")
			.get<{ tree: string | null }>(run.id)?.tree;
		const frozenChecks = (run.goalContract as { runChecks?: CheckCommand[] }).runChecks ?? [];
		snapshot.explanation = {
			liveWriters:
				sql
					.prepare(
						"SELECT COUNT(*) AS n FROM executions e JOIN attempts a ON a.id=e.attempt_id WHERE a.run_id=? AND a.workflow_function='IMPLEMENT' AND e.state='LIVE'",
					)
					.get<{ n: number }>(run.id)?.n ?? 0,
			baseline: receipt
				? `${receipt.checks.filter((c) => c.state === "PASSED").length}/${receipt.checks.length} checks passed on input tree`
				: actions.some((a) => a.kind === "BASELINE_STARTED")
					? "Checking input tree"
					: "Not recorded",
			finalChecks: frozenChecks.map((check) => ({
				name: check.name,
				state: tree
					? (sql
							.prepare(
								"SELECT state FROM check_runs WHERE run_id=? AND subject_kind='RUN' AND subject_id=? AND tree_hash=? AND check_kind=? AND check_version=? ORDER BY rowid DESC LIMIT 1",
							)
							.get<{ state: string }>(run.id, run.id, tree, check.name, checkCommandVersion(check))?.state ?? "PENDING")
					: "PENDING",
			})),
			allocations: actions
				.filter((a) => a.kind === "VERIFICATION_ALLOCATION")
				.slice(-5)
				.map((a) => {
					const detail = JSON.parse(a.detail_json);
					return {
						task: snapshot.tasks.find((t) => t.id === a.task_id)?.title ?? "Task",
						action: detail.action,
						reason: detail.reason,
					};
				}),
			observationsReused: actions.filter((a) => a.kind === "EXPLORATION_REUSED").length,
		};
		snapshot.decisions = catalog
			.listOpenDecisionRequests(run.id)
			.map(({ id, question, options }) => ({ id, question, options }));
		snapshot.events = sql
			.prepare(
				"SELECT id, event_type, created_at, payload_json FROM domain_events WHERE run_id = ? ORDER BY rowid DESC LIMIT 80",
			)
			.all<{ id: string; event_type: string; created_at: string; payload_json: string }>(run.id)
			.map((event) => {
				const payload = JSON.parse(event.payload_json) as Record<string, unknown> | null;
				const detail = payload?.reason ?? payload?.rationale ?? payload?.title ?? payload?.detail ?? "";
				return {
					id: event.id,
					type: event.event_type,
					time: event.created_at,
					detail: typeof detail === "string" ? detail : "",
				};
			});
		snapshot.delivery =
			sql
				.prepare(
					"SELECT result, delivery_ref AS ref, final_tree_hash AS tree, manifest_path AS manifest FROM run_reports WHERE run_id = ? ORDER BY run_version DESC LIMIT 1",
				)
				.get<NonNullable<DashboardSnapshot["delivery"]>>(run.id) ?? null;
		return snapshot;
	} finally {
		sql.close();
	}
}

/** Explicit UI fixture: no repository, model calls, performance claims or hidden state. */
export function demoDashboard(): DashboardSnapshot {
	return {
		...emptyDashboard("~/workspace/atlas"),
		sample: true,
		run: {
			id: "demo-run",
			state: "OPEN",
			objective: "Build a resumable export workflow across API, workers and SDK.",
			integrationHead: "a83f72c9d01b",
			createdAt: "2026-01-01T12:00:00Z",
			updatedAt: "2026-01-01T12:00:00Z",
			reason: null,
		},
		model: "Your configured model",
		tasks: [
			{
				id: "contract",
				title: "Define and verify the export contract",
				state: "ACCEPTED",
				scope: "packages/contracts",
				risk: "MEDIUM",
				epoch: 1,
			},
			{
				id: "storage",
				title: "Persist resumable job checkpoints",
				state: "ACCEPTED",
				scope: "packages/storage",
				risk: "MEDIUM",
				epoch: 1,
			},
			{ id: "api", title: "Implement the export API", state: "ACTIVE", scope: "apps/api", risk: "MEDIUM", epoch: 1 },
			{
				id: "sdk",
				title: "Add SDK progress and resume support",
				state: "ACTIVE",
				scope: "packages/sdk",
				risk: "MEDIUM",
				epoch: 1,
			},
			{
				id: "integration",
				title: "Verify the complete export workflow",
				state: "PROPOSED",
				scope: "tests/integration",
				risk: "HIGH",
				epoch: 0,
			},
		],
		checks: { PASSED: 6, RUNNING: 1 },
		contracts: { total: 2, satisfied: 2 },
		usage: { cost: 0, tokens: 0, unsettled: 0, executions: 0, live: 2 },
		explanation: {
			liveWriters: 2,
			baseline: "Existing behavior checks passed (sample)",
			finalChecks: [{ name: "Complete export workflow", state: "PENDING" }],
			allocations: [
				{
					task: "Implement the export API",
					action: "IMPLEMENT_WITH_FROZEN_CHECKS",
					reason: "The verified contract and frozen behavior checks support this increment (sample)",
				},
			],
			observationsReused: 0,
		},
		coordination: {
			mode: "PARALLEL_TASKS",
			rationale:
				"The export contract is verified. API and SDK scopes are independent; implementation can proceed in parallel.",
		},
		events: [
			{
				id: "3",
				type: "TASK_STARTED",
				time: "2026-01-01T12:00:00Z",
				detail: "API and SDK implementations started in isolated worktrees",
			},
			{
				id: "2",
				type: "CONTRACT_VERIFIED",
				time: "2026-01-01T11:59:00Z",
				detail: "Export schema and checkpoint obligations satisfied",
			},
			{
				id: "1",
				type: "TASK_ACCEPTED",
				time: "2026-01-01T11:58:00Z",
				detail: "Checkpoint storage integrated and reverified",
			},
		],
	};
}
