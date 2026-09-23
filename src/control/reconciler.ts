import type { SqliteDatabase } from "@earendil-works/pi-session-backend-sqlite-node";
import { writerAttemptLimit } from "../config/execution.ts";
import type { ProjectConfig } from "../config/project.ts";
import type { ControlDatabase } from "../store/database.ts";
import { type CheckContainerRecovery, reconcileCheckContainers } from "../verification/container-recovery.ts";
import type { GitWorkspaceManager } from "../workspace/git.ts";
import type { ControlCatalog } from "./catalog.ts";
import type { ControlKernel } from "./kernel.ts";
import type { OperationJournal, OperationRecord } from "./operation-journal.ts";

interface IntegrationRecoveryRow {
	id: string;
	task_id: string;
	candidate_id: string;
	state: "QUEUED" | "APPLYING" | "COMMITTED";
	expected_head: string;
	result_commit: string | null;
	result_tree_hash: string | null;
}

interface AttemptRecoveryRow {
	id: string;
	workflow_function: "PLAN" | "EXPLORE" | "IMPLEMENT" | "REVIEW";
	task_id: string | null;
}

interface PublishIntent {
	ref: string;
	expectedHead: string;
	resultCommit: string;
	resultTreeHash: string;
}

function publishIntent(operation: OperationRecord): PublishIntent {
	const value = operation.desiredState;
	if (typeof value !== "object" || value === null) throw new Error("Integration operation intent is invalid");
	const intent = value as Record<string, unknown>;
	for (const field of ["ref", "expectedHead", "resultCommit", "resultTreeHash"] as const) {
		if (typeof intent[field] !== "string" || intent[field].trim() === "") {
			throw new Error("Integration operation is missing " + field);
		}
	}
	return intent as unknown as PublishIntent;
}

export interface ReconciliationReport {
	interruptedOperations: number;
	lostExecutions: number;
	failedAttempts: number;
	resumableAttemptIds: string[];
	recoveredIntegrations: number;
	rejectedCandidates: number;
	verificationContainers?: CheckContainerRecovery;
}

export class Reconciler {
	private readonly db: SqliteDatabase;

	constructor(
		database: ControlDatabase,
		private readonly kernel: ControlKernel,
		private readonly catalog: ControlCatalog,
		private readonly journal: OperationJournal,
		private readonly workspaces: GitWorkspaceManager,
		private readonly config: ProjectConfig,
	) {
		this.db = database.sql;
	}

	async reconcile(runId: string): Promise<ReconciliationReport> {
		const verificationContainers = await reconcileCheckContainers(this.workspaces.repositoryRoot);
		const report: ReconciliationReport = {
			verificationContainers,
			interruptedOperations: this.journal.markInterruptedFailed(),
			lostExecutions: 0,
			failedAttempts: 0,
			resumableAttemptIds: [],
			recoveredIntegrations: 0,
			rejectedCandidates: 0,
		};
		this.db
			.prepare("UPDATE compute_reservations SET state='INTERRUPTED',updated_at=? WHERE run_id=? AND state='HELD'")
			.run(new Date().toISOString(), runId);
		this.db
			.prepare(
				"UPDATE exploration_records SET state='FAILED',report='Execution interrupted before exploration report was sealed',updated_at=? WHERE run_id=? AND state='RUNNING'",
			)
			.run(new Date().toISOString(), runId);
		await this.reconcileIntegrations(runId, report);
		const actor = { kind: "SYSTEM", id: "reconciler" } as const;
		const executions = this.db
			.prepare(
				"SELECT e.id FROM executions e JOIN attempts a ON a.id = e.attempt_id WHERE a.run_id = ? AND e.state IN ('REQUESTED', 'STARTING', 'LIVE')",
			)
			.all<{ id: string }>(runId);
		for (const execution of executions) {
			this.kernel.finishExecution({ executionId: execution.id, state: "LOST", actor });
			report.lostExecutions++;
		}
		const attempts = this.db
			.prepare("SELECT id, workflow_function, task_id FROM attempts WHERE run_id = ? AND state = 'RUNNING'")
			.all<AttemptRecoveryRow>(runId);
		for (const attempt of attempts) {
			if (attempt.workflow_function === "IMPLEMENT" && attempt.task_id !== null) {
				const definition = this.catalog.getAttempt(attempt.id);
				if (definition.piSessionId) {
					try {
						await this.workspaces.recoverWorktree(attempt.id, definition.baseCommit);
						report.resumableAttemptIds.push(attempt.id);
						continue;
					} catch {
						// Fall through to a fenced new attempt if its local worktree cannot be recovered.
					}
				}
			}
			const retryTask =
				attempt.workflow_function === "IMPLEMENT" &&
				attempt.task_id !== null &&
				this.catalog.countAttempts(attempt.task_id) <
					writerAttemptLimit(this.catalog.getRun(runId).goalContract, this.config.maxAttemptsPerTask);
			this.kernel.failAttempt({
				attemptId: attempt.id,
				reason: "Control process restarted before the attempt reached a durable boundary",
				retryTask,
				actor,
			});
			report.failedAttempts++;
		}
		this.finalizeCommittedIntegrations(runId);
		const orphans = this.db
			.prepare(
				`SELECT c.id, c.task_id
FROM candidates c
JOIN tasks t ON t.id = c.task_id
WHERE t.run_id = ? AND t.state = 'ACTIVE' AND c.state IN ('SUBMITTED', 'ELIGIBLE')
  AND NOT EXISTS (
    SELECT 1 FROM integrations i
    WHERE i.candidate_id = c.id AND i.state IN ('QUEUED', 'APPLYING', 'COMMITTED')
  )`,
			)
			.all<{ id: string; task_id: string }>(runId);
		for (const candidate of orphans) {
			const retryTask =
				this.catalog.countAttempts(candidate.task_id) <
				writerAttemptLimit(this.catalog.getRun(runId).goalContract, this.config.maxAttemptsPerTask);
			this.kernel.rejectCandidate({
				candidateId: candidate.id,
				reason: "Candidate pipeline was interrupted before a durable integration boundary",
				retryTask,
				actor,
			});
			report.rejectedCandidates++;
		}
		await this.workspaces.prune();
		return report;
	}

	private async reconcileIntegrations(runId: string, report: ReconciliationReport): Promise<void> {
		const actor = { kind: "SYSTEM", id: "reconciler" } as const;
		const run = this.catalog.getRun(runId);
		let refHead = await this.workspaces.resolveRef(run.integrationRef);
		const pending = this.db
			.prepare(
				"SELECT id, task_id, candidate_id, state, expected_head, result_commit, result_tree_hash FROM integrations WHERE run_id = ? AND state IN ('QUEUED', 'APPLYING') ORDER BY created_at",
			)
			.all<IntegrationRecoveryRow>(runId);
		for (const integration of pending) {
			const operation = this.journal.find("UPDATE_INTEGRATION_REF", integration.id);
			if (!operation) {
				const retryTask =
					this.catalog.countAttempts(integration.task_id) <
					writerAttemptLimit(this.catalog.getRun(runId).goalContract, this.config.maxAttemptsPerTask);
				this.kernel.failIntegration({
					integrationId: integration.id,
					conflicted: false,
					reason: "Integration was interrupted before a publish intent was durable",
					retryTask,
					actor,
				});
				continue;
			}
			const intent = publishIntent(operation);
			if (intent.ref !== run.integrationRef || intent.expectedHead !== integration.expected_head) {
				throw new Error("Integration publish intent does not match authoritative run state");
			}
			if (refHead === intent.expectedHead) {
				if (operation.phase === "COMPLETED") {
					throw new Error("Integration operation claims completion but its Git ref was not published");
				}
				this.kernel.assertIntegrationPublishable(integration.id, intent.resultTreeHash);
				await this.journal.execute(operation, async () => {
					await this.workspaces.publishIntegration({
						integrationRef: intent.ref,
						expectedHead: intent.expectedHead,
						resultCommit: intent.resultCommit,
					});
					return { commitHash: intent.resultCommit, treeHash: intent.resultTreeHash };
				});
				refHead = intent.resultCommit;
			} else if (refHead === intent.resultCommit) {
				this.journal.markObservedCompleted(operation.id, {
					commitHash: intent.resultCommit,
					treeHash: intent.resultTreeHash,
				});
			} else {
				throw new Error("Integration ref diverged from both expected and intended commits");
			}
			this.kernel.commitIntegration({
				integrationId: integration.id,
				resultCommit: intent.resultCommit,
				resultTreeHash: intent.resultTreeHash,
				actor,
			});
			report.recoveredIntegrations++;
		}
		const authoritative = this.catalog.getRun(runId);
		refHead = await this.workspaces.resolveRef(authoritative.integrationRef);
		if (refHead !== authoritative.integrationHead) {
			throw new Error("Git integration ref and authoritative SQLite head diverged without a recoverable operation");
		}
	}

	private finalizeCommittedIntegrations(runId: string): void {
		const actor = { kind: "SYSTEM", id: "reconciler" } as const;
		const rows = this.db
			.prepare(
				`SELECT i.id, i.task_id, i.candidate_id, i.state, i.expected_head, i.result_commit, i.result_tree_hash,
        r.acceptance_contract_json
FROM integrations i
JOIN tasks t ON t.id = i.task_id
JOIN task_revisions r ON r.id = t.current_revision_id
WHERE i.run_id = ? AND i.state = 'COMMITTED' AND t.state = 'ACTIVE'
  AND NOT EXISTS (SELECT 1 FROM acceptance_decisions a WHERE a.integration_id = i.id)`,
			)
			.all<IntegrationRecoveryRow & { acceptance_contract_json: string }>(runId);
		for (const integration of rows) {
			if (!integration.result_tree_hash) throw new Error("Committed integration is missing its tree hash");
			this.kernel.acceptTask({
				taskId: integration.task_id,
				integrationId: integration.id,
				actor,
			});
		}
	}
}
