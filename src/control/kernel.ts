import { createHash, randomUUID } from "node:crypto";
import type { SqliteDatabase } from "@earendil-works/pi-session-backend-sqlite-node";
import { executionPolicyFor } from "../config/execution.ts";
import { type CheckCommand, checkCommandVersion, evidenceClassForCheck } from "../config/project.ts";
import {
	type AttemptSnapshot,
	type CandidateIdentity,
	type CoordinationLevel,
	DomainInvariantError,
	type EvidenceClass,
	type ExecutionMode,
	type FailureDisposition,
	type TaskSnapshot,
} from "../domain/model.ts";
import {
	assertAcceptancePreconditions,
	assertActiveAttempt,
	assertCandidateIdentity,
	assertTaskTransition,
} from "../domain/transitions.ts";
import type { ControlDatabase } from "../store/database.ts";
import { type ContractObligation, parseObligations } from "./contract-types.ts";
import { normalizeTaskScope } from "./scope.ts";

export interface Actor {
	kind: "USER" | "SYSTEM" | "ATTEMPT";
	id: string;
}

export interface TaskGraphTaskInput {
	key: string;
	title: string;
	objective: string;
	scope: unknown;
	constraints: unknown;
	acceptanceContract: unknown;
	riskClass: string;
	priority: number;
	requiredCapabilities?: string[];
	coordination?: TaskCoordinationInput;
}

export interface TaskCoordinationInput {
	assessment: {
		decomposability: CoordinationLevel;
		sequentiality: CoordinationLevel;
		semanticCoupling: CoordinationLevel;
		integrationCost: CoordinationLevel;
		uncertainty: CoordinationLevel;
		rationale: string;
		evidenceRefs: string[];
		explorationQuestions: Array<{ key: string; hypothesis: string; question: string }>;
	};
	contract: {
		obligations?: ContractObligation[];
		provides: string[];
		requires: string[];
		assumptions: string[];
		ownedScope: string[];
		interfaces: string[];
		evidenceRefs: string[];
	};
}

export interface TaskGraphDependencyInput {
	task: string;
	dependsOn: string;
	kind: "REQUIRES" | "CONSUMES";
}

export type TaskChangeReference = { taskId: string } | { newTaskKey: string };

export interface TaskRevisionProposal extends Omit<TaskGraphTaskInput, "key"> {
	taskId: string;
	expectedVersion: number;
}

export interface TaskCancellationProposal {
	taskId: string;
	expectedVersion: number;
	reason: string;
}

export interface TaskChangeDependencyInput {
	task: TaskChangeReference;
	dependsOn: TaskChangeReference;
	kind: "REQUIRES" | "CONSUMES";
}

export interface TaskChangeSet {
	additions: TaskGraphTaskInput[];
	revisions: TaskRevisionProposal[];
	dependencies: TaskChangeDependencyInput[];
	cancellations: TaskCancellationProposal[];
}

export type MessageKind = "QUESTION" | "ANSWER" | "OBSERVATION" | "HELP_REQUEST" | "PROPOSAL" | "HANDOFF";
export type MessageRecipientKind = "TASK" | "ATTEMPT" | "USER" | "SYSTEM";

export interface MessageReference {
	kind: "TASK" | "ATTEMPT" | "CANDIDATE" | "CHECK" | "REVIEW" | "PROPOSAL";
	id: string;
}

export interface RecordedArtifactInput {
	kind: string;
	contentHash: string;
	sizeBytes: number;
	mediaType: string;
	storageKind: "LOCAL_FILE" | "GIT_OBJECT";
	storageLocator: string;
}

interface TaskRow {
	id: string;
	run_id: string;
	state: TaskSnapshot["state"];
	version: number;
	attempt_epoch: number;
	active_attempt_id: string | null;
}

interface AttemptRow {
	id: string;
	run_id: string;
	task_id: string | null;
	workflow_function: "PLAN" | "EXPLORE" | "IMPLEMENT" | "REVIEW";
	epoch: number | null;
	state: AttemptSnapshot["state"];
	base_commit: string;
}

interface CandidateRow {
	id: string;
	task_id: string;
	attempt_id: string;
	attempt_epoch: number;
	base_commit: string;
	commit_hash: string;
	tree_hash: string;
	state: string;
}

interface RunRow {
	id: string;
	integration_head: string;
	state: "OPEN" | "COMPLETED" | "BLOCKED" | "CANCELLED";
	version: number;
}

interface IntegrationRow {
	id: string;
	run_id: string;
	task_id: string;
	candidate_id: string;
	expected_head: string;
	result_commit: string | null;
	result_tree_hash: string | null;
	state: string;
}

interface ExecutionRow {
	id: string;
	state: string;
	run_id: string;
}

interface MessageRow {
	id: string;
	run_id: string;
	task_id: string | null;
	recipient_kind: MessageRecipientKind;
	recipient_id: string;
	read_at: string | null;
}

interface TaskChangeProposalRow {
	id: string;
	run_id: string;
	source_actor_kind: Actor["kind"];
	source_actor_id: string;
	expected_run_version: number;
	state: "PROPOSED" | "ACCEPTED" | "REJECTED";
	proposal_json: string;
}

function now(): string {
	return new Date().toISOString();
}

function taskChangeRefKey(reference: TaskChangeReference): string {
	if ("taskId" in reference && typeof reference.taskId === "string" && reference.taskId.trim()) {
		return "task:" + reference.taskId;
	}
	if ("newTaskKey" in reference && typeof reference.newTaskKey === "string" && reference.newTaskKey.trim()) {
		return "new:" + reference.newTaskKey;
	}
	throw new DomainInvariantError("INVALID_TASK_REFERENCE", "Task reference must contain one non-empty identity");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new DomainInvariantError("INVALID_TASK_SPEC", field + " must be a string array");
	}
}

function validateCheckCommand(value: unknown, field: string): void {
	if (!isRecord(value) || typeof value.name !== "string" || value.name.trim() === "") {
		throw new DomainInvariantError("INVALID_ACCEPTANCE_CONTRACT", field + " must be a named check object");
	}
	if (
		!Array.isArray(value.argv) ||
		value.argv.length === 0 ||
		!value.argv.every((item) => typeof item === "string") ||
		!(value.argv[0] as string).trim()
	) {
		throw new DomainInvariantError(
			"INVALID_ACCEPTANCE_CONTRACT",
			field + ".argv must be a non-empty string array with an executable",
		);
	}
	if (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1) {
		throw new DomainInvariantError("INVALID_ACCEPTANCE_CONTRACT", field + ".timeoutMs must be positive");
	}
	if (value.lane !== "LIGHT_CHECK" && value.lane !== "HEAVY_CHECK") {
		throw new DomainInvariantError("INVALID_ACCEPTANCE_CONTRACT", field + ".lane is invalid");
	}
}

function validateAcceptanceContract(value: unknown): void {
	if (!isRecord(value) || !Array.isArray(value.candidateChecks) || !Array.isArray(value.integrationChecks)) {
		throw new DomainInvariantError(
			"INVALID_ACCEPTANCE_CONTRACT",
			"Acceptance contract requires candidateChecks and integrationChecks",
		);
	}
	if (value.candidateChecks.length === 0 || value.integrationChecks.length === 0) {
		throw new DomainInvariantError(
			"INVALID_ACCEPTANCE_CONTRACT",
			"Acceptance contract requires at least one candidate and integration check",
		);
	}
	if (typeof value.requireReview !== "boolean") {
		throw new DomainInvariantError("INVALID_ACCEPTANCE_CONTRACT", "Acceptance contract review gate is invalid");
	}
	for (const [index, check] of value.candidateChecks.entries()) {
		validateCheckCommand(check, `candidateChecks[${index}]`);
	}
	for (const [index, check] of value.integrationChecks.entries()) {
		validateCheckCommand(check, `integrationChecks[${index}]`);
	}
}

function validateTaskSpec(task: Omit<TaskGraphTaskInput, "key">, label: string): void {
	if (!task.title?.trim() || !task.objective?.trim()) {
		throw new DomainInvariantError("INVALID_TASK_SPEC", label + " requires a title and objective");
	}
	assertStringArray(task.scope, label + ".scope");
	try {
		normalizeTaskScope(task.scope, label + ".scope");
	} catch (error) {
		throw new DomainInvariantError("INVALID_TASK_SPEC", error instanceof Error ? error.message : String(error));
	}
	assertStringArray(task.constraints, label + ".constraints");
	if (task.riskClass !== "LOW" && task.riskClass !== "NORMAL" && task.riskClass !== "HIGH") {
		throw new DomainInvariantError("INVALID_TASK_SPEC", label + ".riskClass is invalid");
	}
	if (!Number.isSafeInteger(task.priority)) {
		throw new DomainInvariantError("INVALID_TASK_SPEC", label + ".priority must be an integer");
	}
	if (task.requiredCapabilities !== undefined) {
		assertStringArray(task.requiredCapabilities, label + ".requiredCapabilities");
		if (task.requiredCapabilities.some((capability) => capability.trim() === "")) {
			throw new DomainInvariantError("INVALID_TASK_SPEC", label + ".requiredCapabilities cannot contain empty values");
		}
	}
	validateAcceptanceContract(task.acceptanceContract);
	if (task.coordination) validateTaskCoordination(task.coordination);
}

function validateTaskCoordination(input: TaskCoordinationInput): void {
	parseObligations(input.contract.obligations);
	const levels: CoordinationLevel[] = ["LOW", "MEDIUM", "HIGH"];
	for (const value of [
		input.assessment.decomposability,
		input.assessment.sequentiality,
		input.assessment.semanticCoupling,
		input.assessment.integrationCost,
		input.assessment.uncertainty,
	]) {
		if (!levels.includes(value)) throw new DomainInvariantError("INVALID_COORDINATION_ASSESSMENT", value);
	}
	if (!input.assessment.rationale.trim()) {
		throw new DomainInvariantError("INVALID_COORDINATION_ASSESSMENT", "Coordination rationale is required");
	}
	for (const [label, values] of Object.entries({
		assessmentEvidence: input.assessment.evidenceRefs,
		provides: input.contract.provides,
		requires: input.contract.requires,
		assumptions: input.contract.assumptions,
		ownedScope: input.contract.ownedScope,
		interfaces: input.contract.interfaces,
		contractEvidence: input.contract.evidenceRefs,
	})) {
		assertStringArray(values, label);
	}
	if (
		!Array.isArray(input.assessment.explorationQuestions) ||
		!input.assessment.explorationQuestions.every(
			(question) => question.key.trim() && question.hypothesis.trim() && question.question.trim(),
		)
	) {
		throw new DomainInvariantError("INVALID_COORDINATION_ASSESSMENT", "Exploration questions are invalid");
	}
}

function validateTaskChangeSet(changeSet: TaskChangeSet): Record<string, unknown> {
	if (
		!Array.isArray(changeSet.additions) ||
		!Array.isArray(changeSet.revisions) ||
		!Array.isArray(changeSet.dependencies) ||
		!Array.isArray(changeSet.cancellations)
	) {
		throw new DomainInvariantError("INVALID_TASK_CHANGE", "Task change proposal arrays are required");
	}
	const total =
		changeSet.additions.length +
		changeSet.revisions.length +
		changeSet.dependencies.length +
		changeSet.cancellations.length;
	if (total === 0) throw new DomainInvariantError("EMPTY_TASK_CHANGE", "Task change proposal cannot be empty");
	if (
		changeSet.additions.length > 32 ||
		changeSet.revisions.length > 32 ||
		changeSet.dependencies.length > 128 ||
		changeSet.cancellations.length > 32
	) {
		throw new DomainInvariantError("TASK_CHANGE_TOO_LARGE", "Task change proposal exceeds bounded graph limits");
	}
	const newKeys = new Set<string>();
	for (const addition of changeSet.additions) {
		if (!addition.key?.trim() || !/^[A-Za-z0-9._-]+$/.test(addition.key) || newKeys.has(addition.key)) {
			throw new DomainInvariantError("INVALID_TASK_KEY", "Added task keys must be non-empty and unique");
		}
		validateTaskSpec(addition, `addition[${addition.key}]`);
		newKeys.add(addition.key);
	}
	const revised = new Set<string>();
	for (const revision of changeSet.revisions) {
		if (!revision.taskId?.trim() || !Number.isSafeInteger(revision.expectedVersion) || revision.expectedVersion < 1) {
			throw new DomainInvariantError("INVALID_TASK_REVISION", "Task revision requires an id and expected version");
		}
		if (revised.has(revision.taskId))
			throw new DomainInvariantError("DUPLICATE_TASK_REVISION", "A task can be revised only once per proposal");
		validateTaskSpec(revision, `revision[${revision.taskId}]`);
		revised.add(revision.taskId);
	}
	const cancelled = new Set<string>();
	for (const cancellation of changeSet.cancellations) {
		if (
			!cancellation.taskId?.trim() ||
			!Number.isSafeInteger(cancellation.expectedVersion) ||
			cancellation.expectedVersion < 1 ||
			!cancellation.reason?.trim()
		) {
			throw new DomainInvariantError("INVALID_TASK_CANCELLATION", "Task cancellation is missing required fields");
		}
		if (cancelled.has(cancellation.taskId) || revised.has(cancellation.taskId)) {
			throw new DomainInvariantError("CONFLICTING_TASK_CHANGE", "A task cannot be revised and cancelled together");
		}
		cancelled.add(cancellation.taskId);
	}
	const dependencyKeys = new Set<string>();
	for (const dependency of changeSet.dependencies) {
		if (dependency.kind !== "REQUIRES" && dependency.kind !== "CONSUMES") {
			throw new DomainInvariantError("INVALID_DEPENDENCY_KIND", "Dependency kind is invalid");
		}
		const task = taskChangeRefKey(dependency.task);
		const upstream = taskChangeRefKey(dependency.dependsOn);
		if (task === upstream) throw new DomainInvariantError("DEPENDENCY_CYCLE", "Task cannot depend on itself");
		for (const reference of [task, upstream]) {
			if (reference.startsWith("new:") && !newKeys.has(reference.slice(4))) {
				throw new DomainInvariantError("UNKNOWN_TASK_DEPENDENCY", "Dependency references an unknown added task");
			}
		}
		const key = `${task}\0${upstream}\0${dependency.kind}`;
		if (dependencyKeys.has(key))
			throw new DomainInvariantError("DUPLICATE_DEPENDENCY", "Task change contains a duplicate dependency");
		dependencyKeys.add(key);
	}
	return {
		schema: "task-change/v1",
		additionCount: changeSet.additions.length,
		revisionCount: changeSet.revisions.length,
		dependencyCount: changeSet.dependencies.length,
		cancellationCount: changeSet.cancellations.length,
	};
}

function taskSnapshot(row: TaskRow): TaskSnapshot {
	return {
		id: row.id,
		runId: row.run_id,
		state: row.state,
		version: row.version,
		attemptEpoch: row.attempt_epoch,
		activeAttemptId: row.active_attempt_id,
	};
}

function attemptSnapshot(row: AttemptRow): AttemptSnapshot {
	if (row.workflow_function !== "IMPLEMENT" || row.task_id === null || row.epoch === null) {
		throw new DomainInvariantError("NOT_IMPLEMENTER_ATTEMPT", "Attempt does not own a task writer epoch");
	}
	return {
		id: row.id,
		taskId: row.task_id,
		epoch: row.epoch,
		state: row.state,
		baseCommit: row.base_commit,
	};
}

export class ControlKernel {
	private readonly db: SqliteDatabase;

	constructor(database: ControlDatabase) {
		this.db = database.sql;
	}

	private transactionDepth = 0;
	private savepointSequence = 0;

	/** Compose authoritative state changes without splitting their durable boundary. */
	atomic<T>(operation: () => T): T {
		if (this.transactionDepth === 0)
			return this.db.transaction(() => {
				this.transactionDepth++;
				try {
					return operation();
				} finally {
					this.transactionDepth--;
				}
			});
		const savepoint = `kernel_${++this.savepointSequence}`;
		this.db.exec(`SAVEPOINT ${savepoint}`);
		try {
			const result = operation();
			if (result && typeof (result as { then?: unknown }).then === "function")
				throw new Error("Kernel transactions must be synchronous");
			this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
			return result;
		} catch (error) {
			this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
			this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
			throw error;
		}
	}

	private graphHash(runId: string): string {
		const tasks = this.db
			.prepare(
				"SELECT id, current_revision_id, state = 'CANCELLED' AS cancelled FROM tasks WHERE run_id = ? ORDER BY id",
			)
			.all(runId);
		const edges = this.db
			.prepare(
				"SELECT d.task_id, d.depends_on_task_id, d.kind FROM dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.run_id=? ORDER BY d.task_id,d.depends_on_task_id,d.kind",
			)
			.all(runId);
		return createHash("sha256").update(JSON.stringify({ tasks, edges })).digest("hex");
	}

	taskProposalIsCurrent(proposalId: string): boolean {
		const row = this.db
			.prepare("SELECT run_id, expected_graph_hash FROM task_change_proposals WHERE id=?")
			.get<{ run_id: string; expected_graph_hash: string | null }>(proposalId);
		return Boolean(row?.expected_graph_hash && row.expected_graph_hash === this.graphHash(row.run_id));
	}

	assertHumanInputAllowed(runId: string): void {
		if (executionPolicyFor(this.goalContract(runId)).decisionMode === "noninteractive") {
			throw new DomainInvariantError(
				"NONINTERACTIVE_RUN",
				"This run's frozen policy forbids human answers, steering, graph edits and extra attempts",
			);
		}
	}

	goalContract(runId: string): unknown {
		const row = this.db
			.prepare("SELECT goal_contract_json FROM runs WHERE id=?")
			.get<{ goal_contract_json: string }>(runId);
		if (!row) throw new DomainInvariantError("RUN_NOT_FOUND", runId);
		return JSON.parse(row.goal_contract_json);
	}

	bindIntegrationTree(runId: string, commit: string, tree: string): void {
		const result = this.db
			.prepare(
				"UPDATE runs SET integration_tree_hash=? WHERE id=? AND integration_head=? AND (integration_tree_hash IS NULL OR integration_tree_hash=?)",
			)
			.run(tree, runId, commit, tree);
		if (result.changes !== 1)
			throw new DomainInvariantError("FINAL_TREE_MISMATCH", "Integration commit/tree binding changed");
	}

	computeSnapshot(runId: string): {
		costUsd: number;
		tokens: number;
		reservedUsd: number;
		reservedTokens: number;
		executions: number;
		remainingMs: number | null;
		unavailableReason: string | null;
	} {
		const policy = executionPolicyFor(this.goalContract(runId));
		const usage = this.db
			.prepare(
				"SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)),0) AS tokens FROM usage_records WHERE run_id=?",
			)
			.get<{ cost: number; tokens: number }>(runId) ?? { cost: 0, tokens: 0 };
		const reserved = this.db
			.prepare(
				"SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(tokens),0) AS tokens FROM compute_reservations WHERE run_id=? AND state IN ('HELD','INTERRUPTED')",
			)
			.get<{ cost: number; tokens: number }>(runId) ?? { cost: 0, tokens: 0 };
		const executions =
			this.db
				.prepare("SELECT COUNT(*) AS n FROM executions e JOIN attempts a ON a.id=e.attempt_id WHERE a.run_id=?")
				.get<{ n: number }>(runId)?.n ?? 0;
		const started = this.db.prepare("SELECT created_at FROM runs WHERE id=?").get<{ created_at: string }>(runId);
		if (!started) throw new DomainInvariantError("RUN_NOT_FOUND", runId);
		const remainingMs =
			policy.deadlineMs === undefined
				? null
				: Math.max(0, Date.parse(started.created_at) + policy.deadlineMs - Date.now());
		const unavailableReason =
			remainingMs === 0
				? "Run deadline exhausted"
				: policy.costLimitUsd !== undefined && usage.cost + reserved.cost >= policy.costLimitUsd
					? "Run cost budget exhausted or reserved"
					: policy.tokenLimit !== undefined && usage.tokens + reserved.tokens >= policy.tokenLimit
						? "Run token budget exhausted or reserved"
						: executions >= policy.maxExecutions
							? "Run execution limit reached"
							: null;
		return {
			costUsd: usage.cost,
			tokens: usage.tokens,
			reservedUsd: reserved.cost,
			reservedTokens: reserved.tokens,
			executions,
			remainingMs,
			unavailableReason,
		};
	}

	reserveCompute(input: { id: string; runId: string; executionId: string }): void {
		this.atomic(() => {
			this.assertRunOpen(this.requireRun(input.runId));
			if (this.requireExecution(input.executionId).run_id !== input.runId)
				throw new DomainInvariantError("CROSS_RUN_BUDGET", "Execution belongs to another run");
			const policy = executionPolicyFor(this.goalContract(input.runId));
			const snapshot = this.computeSnapshot(input.runId);
			if (snapshot.remainingMs === 0 || snapshot.executions > policy.maxExecutions)
				throw new DomainInvariantError("BUDGET_EXHAUSTED", "Execution/deadline budget exhausted");
			const cost =
				policy.costLimitUsd === undefined
					? policy.reservationUsd
					: Math.min(policy.reservationUsd, policy.costLimitUsd - snapshot.costUsd - snapshot.reservedUsd);
			const tokens =
				policy.tokenLimit === undefined
					? policy.reservationTokens
					: Math.min(policy.reservationTokens, policy.tokenLimit - snapshot.tokens - snapshot.reservedTokens);
			if (cost <= 0 || tokens < 1)
				throw new DomainInvariantError(
					"BUDGET_EXHAUSTED",
					"Available compute is exhausted or reserved by another execution",
				);
			this.db
				.prepare(
					"INSERT INTO compute_reservations (id,run_id,execution_id,cost_usd,tokens,state,created_at,updated_at) VALUES (?,?,?,?,?,'HELD',?,?)",
				)
				.run(input.id, input.runId, input.executionId, cost, tokens, now(), now());
		});
	}

	checkComputeReservation(id: string, usedCost: number, usedTokens: number): void {
		const { policy, snapshot } = this.atomic(() => {
			const row = this.db
				.prepare("SELECT run_id,state,cost_usd,tokens,used_cost,used_tokens FROM compute_reservations WHERE id=?")
				.get<{
					run_id: string;
					state: string;
					cost_usd: number;
					tokens: number;
					used_cost: number;
					used_tokens: number;
				}>(id);
			if (!row || row.state !== "HELD")
				throw new DomainInvariantError("BUDGET_RESERVATION_LOST", "Compute reservation is no longer active");
			const policy = executionPolicyFor(this.goalContract(row.run_id));
			this.db
				.prepare(
					"UPDATE compute_reservations SET cost_usd=?,tokens=?,used_cost=?,used_tokens=?,updated_at=? WHERE id=?",
				)
				.run(
					Math.max(0, row.cost_usd - Math.max(0, usedCost - row.used_cost)),
					Math.max(0, row.tokens - Math.max(0, usedTokens - row.used_tokens)),
					usedCost,
					usedTokens,
					now(),
					id,
				);
			const snapshot = this.computeSnapshot(row.run_id);
			return { policy, snapshot };
		});
		if (
			snapshot.remainingMs === 0 ||
			(policy.costLimitUsd !== undefined && snapshot.costUsd >= policy.costLimitUsd) ||
			(policy.tokenLimit !== undefined && snapshot.tokens >= policy.tokenLimit)
		)
			throw new DomainInvariantError("BUDGET_EXHAUSTED", "Actual usage or deadline reached the frozen run limit");
	}

	releaseCompute(id: string, interrupted = false): void {
		this.db
			.prepare("UPDATE compute_reservations SET state=?,updated_at=? WHERE id=? AND state='HELD'")
			.run(interrupted ? "INTERRUPTED" : "RELEASED", now(), id);
	}

	recordControlAction(input: {
		runId: string;
		taskId?: string;
		kind: string;
		detail: unknown;
		state?: string;
	}): string {
		this.requireRun(input.runId);
		const id = randomUUID();
		this.db
			.prepare("INSERT INTO control_actions VALUES (?,?,?,?,?,?,?,?)")
			.run(
				id,
				input.runId,
				input.taskId ?? null,
				input.kind,
				input.state ?? "COMPLETED",
				JSON.stringify(input.detail),
				now(),
				now(),
			);
		return id;
	}

	recordContractEvidence(input: {
		taskId: string;
		obligation: string;
		commitHash: string;
		treeHash: string;
		artifacts: Array<{ path: string; blobHash: string }>;
		checkIds: string[];
	}): string {
		return this.atomic(() => {
			const task = this.requireTask(input.taskId);
			const row = this.db
				.prepare(
					"SELECT c.id,c.version,c.obligations_json FROM coordination_contracts c JOIN tasks t ON t.current_revision_id=c.task_revision_id WHERE t.id=?",
				)
				.get<{ id: string; version: number; obligations_json: string }>(task.id);
			if (!row) throw new DomainInvariantError("CONTRACT_NOT_FOUND", task.id);
			const obligation = parseObligations(JSON.parse(row.obligations_json)).find((o) => o.key === input.obligation);
			if (
				!obligation ||
				!obligation.artifactPaths.every((path) =>
					input.artifacts.some((a) => a.path === path && /^[0-9a-f]{40,64}$/.test(a.blobHash)),
				)
			)
				throw new DomainInvariantError("MISSING_CONTRACT_ARTIFACT", input.obligation);
			const allowed = this.requireAcceptanceContract(task.id).integrationChecks;
			for (const name of obligation.checkNames) {
				const definition = allowed.find((check) => check.name === name);
				if (!definition || evidenceClassForCheck(definition) === "STRUCTURAL")
					throw new DomainInvariantError("INSUFFICIENT_CONTRACT_CHECK", name);
				const evidence = input.checkIds.some((id) =>
					Boolean(
						this.db
							.prepare(
								"SELECT id FROM check_runs WHERE id=? AND run_id=? AND tree_hash=? AND check_kind=? AND check_version=? AND state='PASSED'",
							)
							.get(id, task.run_id, input.treeHash, name, checkCommandVersion(definition)),
					),
				);
				if (!evidence) throw new DomainInvariantError("MISSING_CONTRACT_CHECK", name);
			}
			const existing = this.db
				.prepare("SELECT id FROM contract_evidence WHERE contract_id=? AND version=? AND obligation=? AND tree_hash=?")
				.get<{ id: string }>(row.id, row.version, input.obligation, input.treeHash);
			if (existing) return existing.id;
			const id = randomUUID();
			this.db
				.prepare("INSERT INTO contract_evidence VALUES (?,?,?,?,?,?,?,?,?)")
				.run(
					id,
					row.id,
					row.version,
					input.obligation,
					input.treeHash,
					input.commitHash,
					JSON.stringify(input.artifacts),
					JSON.stringify(input.checkIds),
					now(),
				);
			return id;
		});
	}

	satisfyCoordinationContract(taskId: string, treeHash: string): void {
		const row = this.db
			.prepare(
				"SELECT c.* FROM coordination_contracts c JOIN tasks t ON t.current_revision_id=c.task_revision_id WHERE t.id=?",
			)
			.get<{ id: string; version: number; provides_json: string; assumptions_json: string; obligations_json: string }>(
				taskId,
			);
		if (!row) return;
		const keys = [...JSON.parse(row.provides_json), ...JSON.parse(row.assumptions_json)] as string[];
		for (const key of keys) {
			if (
				!this.db
					.prepare(
						"SELECT id FROM contract_evidence WHERE contract_id=? AND version=? AND obligation=? AND tree_hash=?",
					)
					.get(row.id, row.version, key, treeHash)
			)
				throw new DomainInvariantError("UNPROVEN_CONTRACT", `No exact-tree artifact/check proof for ${key}`);
		}
		this.db.prepare("UPDATE coordination_contracts SET state='SATISFIED',updated_at=? WHERE id=?").run(now(), row.id);
	}

	bindContractConsumption(
		attemptId: string,
		contractId: string,
		version: number,
		baseline: string,
		evidenceIds: string[],
	): void {
		const attempt = this.requireAttempt(attemptId);
		if (attempt.state !== "RUNNING" || attempt.base_commit !== baseline || attempt.task_id === null)
			throw new DomainInvariantError("STALE_CONTRACT_CONSUMER", attemptId);
		assertActiveAttempt(taskSnapshot(this.requireTask(attempt.task_id)), attemptSnapshot(attempt), attempt.epoch ?? -1);
		const contract = this.db
			.prepare("SELECT run_id,version,state FROM coordination_contracts WHERE id=?")
			.get<{ run_id: string; version: number; state: string }>(contractId);
		if (
			!contract ||
			contract.run_id !== attempt.run_id ||
			contract.version !== version ||
			contract.state !== "SATISFIED"
		)
			throw new DomainInvariantError("STALE_CONTRACT_PROVIDER", contractId);
		for (const id of evidenceIds)
			if (
				!this.db
					.prepare("SELECT id FROM contract_evidence WHERE id=? AND contract_id=? AND version=?")
					.get(id, contractId, version)
			)
				throw new DomainInvariantError("INVALID_CONTRACT_EVIDENCE", id);
		if (!evidenceIds.length) throw new DomainInvariantError("MISSING_CONTRACT_EVIDENCE", contractId);
		const prior = this.db
			.prepare(
				"SELECT evidence_ids_json FROM contract_consumptions WHERE attempt_id=? AND contract_id=? AND version=? AND baseline_commit=?",
			)
			.get<{ evidence_ids_json: string }>(attemptId, contractId, version, baseline);
		const merged = [...new Set([...(prior ? (JSON.parse(prior.evidence_ids_json) as string[]) : []), ...evidenceIds])];
		this.db
			.prepare(
				"INSERT INTO contract_consumptions VALUES (?,?,?,?,?) ON CONFLICT(attempt_id,contract_id) DO UPDATE SET evidence_ids_json=excluded.evidence_ids_json",
			)
			.run(attemptId, contractId, version, baseline, JSON.stringify(merged));
	}

	private requireCoordinationEvidence(taskId: string, attemptId: string, treeHash: string): void {
		const task = this.requireTask(taskId);
		if (!executionPolicyFor(this.goalContract(task.run_id)).enableContracts) return;
		const row = this.db
			.prepare(
				"SELECT c.id,c.version,c.state,c.provides_json,c.requires_json,c.assumptions_json FROM coordination_contracts c JOIN tasks t ON t.current_revision_id=c.task_revision_id WHERE t.id=?",
			)
			.get<{
				id: string;
				version: number;
				state: string;
				provides_json: string;
				requires_json: string;
				assumptions_json: string;
			}>(taskId);
		if (!row) return;
		for (const key of [...JSON.parse(row.provides_json), ...JSON.parse(row.assumptions_json)] as string[]) {
			if (
				row.state !== "SATISFIED" ||
				!this.db
					.prepare(
						"SELECT id FROM contract_evidence WHERE contract_id=? AND version=? AND obligation=? AND tree_hash=?",
					)
					.get(row.id, row.version, key, treeHash)
			)
				throw new DomainInvariantError("UNPROVEN_CONTRACT", `Cannot accept ${key} without exact-tree evidence`);
		}
		for (const key of JSON.parse(row.requires_json) as string[]) {
			const providers = this.db
				.prepare(
					"SELECT c.id,c.version,c.state,t.state AS task_state FROM coordination_contracts c JOIN tasks t ON t.current_revision_id=c.task_revision_id JOIN json_each(c.provides_json) p WHERE c.run_id=? AND p.value=? AND t.state<>'CANCELLED'",
				)
				.all<{ id: string; version: number; state: string; task_state: string }>(task.run_id, key);
			const provider = providers[0];
			if (providers.length !== 1 || !provider || provider.state !== "SATISFIED" || provider.task_state !== "ACCEPTED")
				throw new DomainInvariantError("UNRESOLVED_CONTRACT", key);
			const consumption = this.db
				.prepare(
					"SELECT evidence_ids_json FROM contract_consumptions WHERE attempt_id=? AND contract_id=? AND version=?",
				)
				.get<{ evidence_ids_json: string }>(attemptId, provider.id, provider.version);
			if (
				!consumption ||
				!(JSON.parse(consumption.evidence_ids_json) as string[]).some((id) =>
					this.db
						.prepare("SELECT id FROM contract_evidence WHERE id=? AND contract_id=? AND version=? AND obligation=?")
						.get(id, provider.id, provider.version, key),
				)
			)
				throw new DomainInvariantError("UNBOUND_CONTRACT_CONSUMER", key);
		}
	}

	private bindCoordinationDependencies(runId: string, actor: Actor): void {
		const contracts = this.db
			.prepare(
				"SELECT c.task_id,c.provides_json,c.requires_json FROM coordination_contracts c JOIN tasks t ON t.current_revision_id=c.task_revision_id WHERE c.run_id=? AND t.state<>'CANCELLED'",
			)
			.all<{ task_id: string; provides_json: string; requires_json: string }>(runId);
		for (const consumer of contracts)
			for (const key of JSON.parse(consumer.requires_json) as string[]) {
				const providers = contracts.filter((provider) =>
					(JSON.parse(provider.provides_json) as string[]).includes(key),
				);
				if (providers.length !== 1 || !providers[0] || providers[0].task_id === consumer.task_id)
					throw new DomainInvariantError("UNRESOLVED_CONTRACT", `Interface ${key} needs one other producer`);
				const producer = providers[0].task_id;
				if (
					!this.db
						.prepare("SELECT task_id FROM dependencies WHERE task_id=? AND depends_on_task_id=?")
						.get(consumer.task_id, producer)
				)
					this.addDependency({ taskId: consumer.task_id, dependsOnTaskId: producer, kind: "CONSUMES", actor });
			}
	}

	recordTaskCoordination(input: {
		id?: string;
		contractId?: string;
		taskId: string;
		assessment: TaskCoordinationInput["assessment"];
		contract: TaskCoordinationInput["contract"];
		actor: Actor;
	}): { assessmentId: string; contractId: string } {
		const assessmentId = input.id ?? randomUUID();
		const contractId = input.contractId ?? randomUUID();
		validateTaskCoordination({ assessment: input.assessment, contract: input.contract });
		const timestamp = now();
		this.atomic(() => {
			const task = this.requireTask(input.taskId);
			const revision = this.db
				.prepare("SELECT current_revision_id FROM tasks WHERE id = ?")
				.get<{ current_revision_id: string }>(task.id)?.current_revision_id;
			if (!revision) throw new DomainInvariantError("TASK_REVISION_NOT_FOUND", "Task has no current revision");
			if (["COMPLETED", "CANCELLED"].includes(this.requireRun(task.run_id).state))
				throw new DomainInvariantError("RUN_TERMINAL", "Cannot bind a contract for a terminal run");
			this.db
				.prepare(
					`INSERT INTO coordination_assessments (
id, run_id, task_id, task_revision_id, decomposability, sequentiality, semantic_coupling,
integration_cost, uncertainty, rationale, evidence_refs_json, exploration_questions_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					assessmentId,
					task.run_id,
					task.id,
					revision,
					input.assessment.decomposability,
					input.assessment.sequentiality,
					input.assessment.semanticCoupling,
					input.assessment.integrationCost,
					input.assessment.uncertainty,
					input.assessment.rationale,
					JSON.stringify(input.assessment.evidenceRefs),
					JSON.stringify(input.assessment.explorationQuestions),
					timestamp,
				);
			this.db
				.prepare(
					`INSERT INTO coordination_contracts (
id, run_id, task_id, task_revision_id, version, state, provides_json, requires_json,
assumptions_json, owned_scope_json, interfaces_json, evidence_refs_json, created_at, updated_at
) VALUES (?, ?, ?, ?, 1, 'BOUND', ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					contractId,
					task.run_id,
					task.id,
					revision,
					JSON.stringify(input.contract.provides),
					JSON.stringify(input.contract.requires),
					JSON.stringify(input.contract.assumptions),
					JSON.stringify(input.contract.ownedScope),
					JSON.stringify(input.contract.interfaces),
					JSON.stringify(input.contract.evidenceRefs),
					timestamp,
					timestamp,
				);
			this.db
				.prepare("UPDATE coordination_contracts SET obligations_json=? WHERE id=?")
				.run(JSON.stringify(input.contract.obligations ?? []), contractId);
			this.event({
				runId: task.run_id,
				aggregateType: "COORDINATION_CONTRACT",
				aggregateId: contractId,
				aggregateVersion: 1,
				eventType: "CoordinationContractBound",
				actor: input.actor,
				payload: { taskId: task.id, revisionId: revision, assessmentId },
			});
		});
		return { assessmentId, contractId };
	}

	recordCoordinationDecision(input: {
		id?: string;
		runId: string;
		expectedRunVersion: number;
		integrationHead: string;
		mode: ExecutionMode;
		taskIds: string[];
		policyInputs: unknown;
		rationale: string;
		actor: Actor;
	}): string {
		const id = input.id ?? randomUUID();
		this.atomic(() => {
			const run = this.requireRun(input.runId);
			this.assertRunOpen(run);
			if (run.version !== input.expectedRunVersion || run.integration_head !== input.integrationHead) {
				throw new DomainInvariantError("STALE_COORDINATION_DECISION", "Run changed during scheduling decision");
			}
			// An empty selection durably records the decision to wait for active work.
			for (const taskId of input.taskIds) {
				const task = this.requireTask(taskId);
				if (task.run_id !== run.id || task.state !== "READY") {
					throw new DomainInvariantError("INVALID_COORDINATION_TASK", "Selected task is not ready in this run");
				}
			}
			const timestamp = now();
			this.db
				.prepare(
					"INSERT INTO coordination_decisions (id, run_id, expected_run_version, integration_head, mode, task_ids_json, policy_inputs_json, rationale, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					run.id,
					run.version,
					run.integration_head,
					input.mode,
					JSON.stringify(input.taskIds),
					JSON.stringify(input.policyInputs),
					input.rationale,
					timestamp,
				);
			this.event({
				runId: run.id,
				aggregateType: "COORDINATION_DECISION",
				aggregateId: id,
				aggregateVersion: 1,
				eventType: "ExecutionModeSelected",
				actor: input.actor,
				payload: { mode: input.mode, taskIds: input.taskIds, rationale: input.rationale },
			});
		});
		return id;
	}

	recordFailureDiagnosis(input: {
		id?: string;
		runId: string;
		taskId?: string;
		attemptId?: string;
		phase: string;
		classification: string;
		fingerprint: string;
		disposition: FailureDisposition;
		detail: string;
		evidenceRefs?: string[];
		actor: Actor;
	}): { id: string; occurrence: number } {
		const id = input.id ?? randomUUID();
		let occurrence = 0;
		this.atomic(() => {
			const run = this.requireRun(input.runId);
			if (input.taskId && this.requireTask(input.taskId).run_id !== run.id) {
				throw new DomainInvariantError("CROSS_RUN_FAILURE", "Failure task belongs to another run");
			}
			occurrence =
				(this.db
					.prepare(
						"SELECT COUNT(*) AS count FROM failure_diagnoses WHERE run_id = ? AND fingerprint = ? AND task_id IS ?",
					)
					.get<{ count: number }>(run.id, input.fingerprint, input.taskId ?? null)?.count ?? 0) + 1;
			const timestamp = now();
			this.db
				.prepare(
					"INSERT INTO failure_diagnoses (id, run_id, task_id, attempt_id, phase, classification, fingerprint, occurrence, disposition, detail, evidence_refs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					run.id,
					input.taskId ?? null,
					input.attemptId ?? null,
					input.phase,
					input.classification,
					input.fingerprint,
					occurrence,
					input.disposition,
					input.detail,
					JSON.stringify(input.evidenceRefs ?? []),
					timestamp,
				);
			this.event({
				runId: run.id,
				aggregateType: "FAILURE_DIAGNOSIS",
				aggregateId: id,
				aggregateVersion: 1,
				eventType: "FailureDispositionSelected",
				actor: input.actor,
				payload: { taskId: input.taskId ?? null, occurrence, disposition: input.disposition },
			});
		});
		return { id, occurrence };
	}

	beginExploration(input: {
		id?: string;
		taskId: string;
		baselineCommit: string;
		investigationKey: string;
		hypothesis: string;
		question: string;
		maxExecutions?: number;
		actor: Actor;
	}): string {
		const id = input.id ?? randomUUID();
		this.atomic(() => {
			const task = this.requireTask(input.taskId);
			const run = this.requireRun(task.run_id);
			this.assertRunOpen(run);
			const revision = this.db
				.prepare("SELECT current_revision_id FROM tasks WHERE id = ?")
				.get<{ current_revision_id: string }>(task.id)?.current_revision_id;
			if (!revision) throw new DomainInvariantError("TASK_REVISION_NOT_FOUND", "Task has no current revision");
			const prior =
				this.db
					.prepare(
						"SELECT COUNT(*) AS count FROM exploration_records WHERE task_revision_id = ? AND baseline_commit = ? AND investigation_key = ? AND hypothesis = ?",
					)
					.get<{ count: number }>(revision, input.baselineCommit, input.investigationKey, input.hypothesis)?.count ?? 0;
			if (prior >= (input.maxExecutions ?? 2))
				throw new DomainInvariantError("EXPLORATION_EXHAUSTED", "Investigation execution budget exhausted");
			const timestamp = now();
			try {
				this.db
					.prepare(
						"INSERT INTO exploration_records (id, run_id, task_id, task_revision_id, baseline_commit, investigation_key, hypothesis, question, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?)",
					)
					.run(
						id,
						run.id,
						task.id,
						revision,
						input.baselineCommit,
						input.investigationKey,
						input.hypothesis,
						input.question,
						timestamp,
						timestamp,
					);
			} catch {
				throw new DomainInvariantError(
					"DUPLICATE_EXPLORATION",
					"The same hypothesis was already explored on this task revision and baseline",
				);
			}
			this.event({
				runId: run.id,
				aggregateType: "EXPLORATION",
				aggregateId: id,
				aggregateVersion: 1,
				eventType: "DiverseExplorationStarted",
				actor: input.actor,
				payload: { taskId: task.id, investigationKey: input.investigationKey, hypothesis: input.hypothesis },
			});
		});
		return id;
	}

	finishExploration(input: {
		explorationId: string;
		attemptId?: string;
		state: "COMPLETED" | "FAILED";
		report: string;
		actor: Actor;
	}): void {
		this.atomic(() => {
			const record = this.db
				.prepare("SELECT run_id, state FROM exploration_records WHERE id = ?")
				.get<{ run_id: string; state: string }>(input.explorationId);
			if (!record) throw new DomainInvariantError("EXPLORATION_NOT_FOUND", "Exploration record was not found");
			if (record.state !== "RUNNING") {
				throw new DomainInvariantError("EXPLORATION_TERMINAL", "Exploration is already terminal");
			}
			this.db
				.prepare(
					"UPDATE exploration_records SET state = ?, attempt_id = ?, report = ?, updated_at = ? WHERE id = ? AND state = 'RUNNING'",
				)
				.run(input.state, input.attemptId ?? null, input.report, now(), input.explorationId);
			this.event({
				runId: record.run_id,
				aggregateType: "EXPLORATION",
				aggregateId: input.explorationId,
				aggregateVersion: 2,
				eventType: input.state === "COMPLETED" ? "DiverseExplorationCompleted" : "DiverseExplorationFailed",
				actor: input.actor,
				payload: { attemptId: input.attemptId ?? null },
			});
		});
	}

	createDecisionRequest(input: {
		id?: string;
		runId: string;
		taskId?: string;
		kind:
			| "REQUIREMENT_CHOICE"
			| "AUTHORITY_EXPANSION"
			| "ACCEPTANCE_CHANGE"
			| "IRREVERSIBLE_ACTION"
			| "BUDGET_EXTENSION"
			| "SEMANTIC_CONTRACT";
		question: string;
		options: string[];
		recommendedOption?: string;
		evidenceRefs?: string[];
		sourceKind?: string;
		sourceId?: string;
		actor: Actor;
	}): string {
		const id = input.id ?? randomUUID();
		if (!input.question.trim() || input.options.length < 2 || input.options.some((option) => !option.trim())) {
			throw new DomainInvariantError(
				"INVALID_DECISION_REQUEST",
				"A concrete question and at least two options are required",
			);
		}
		if (new Set(input.options).size !== input.options.length) {
			throw new DomainInvariantError("INVALID_DECISION_REQUEST", "Decision options must be unique");
		}
		if (input.recommendedOption && !input.options.includes(input.recommendedOption)) {
			throw new DomainInvariantError("INVALID_DECISION_REQUEST", "Recommended option must be one of the choices");
		}
		this.atomic(() => {
			const run = this.requireRun(input.runId);
			if (run.state === "COMPLETED" || run.state === "CANCELLED") {
				throw new DomainInvariantError("RUN_TERMINAL", "Cannot request a decision for a terminal run");
			}
			if (input.taskId && this.requireTask(input.taskId).run_id !== run.id) {
				throw new DomainInvariantError("CROSS_RUN_DECISION", "Decision task belongs to another run");
			}
			if (input.actor.kind === "ATTEMPT") {
				const attempt = this.requireAttempt(input.actor.id);
				if (attempt.run_id !== run.id || attempt.task_id !== (input.taskId ?? null) || attempt.state !== "RUNNING") {
					throw new DomainInvariantError(
						"STALE_DECISION_REQUEST",
						"Only the active scoped attempt may request a human decision",
					);
				}
			}
			const timestamp = now();
			this.db
				.prepare(
					"INSERT INTO decision_requests (id, run_id, task_id, expected_run_version, kind, question, options_json, recommended_option, evidence_refs_json, source_kind, source_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)",
				)
				.run(
					id,
					run.id,
					input.taskId ?? null,
					run.version,
					input.kind,
					input.question,
					JSON.stringify(input.options),
					input.recommendedOption ?? null,
					JSON.stringify(input.evidenceRefs ?? []),
					input.sourceKind ?? null,
					input.sourceId ?? null,
					timestamp,
				);
			this.event({
				runId: run.id,
				aggregateType: "DECISION_REQUEST",
				aggregateId: id,
				aggregateVersion: 1,
				eventType: "HumanDecisionRequested",
				actor: input.actor,
				payload: { taskId: input.taskId ?? null, kind: input.kind, options: input.options },
			});
		});
		return id;
	}

	resolveDecisionRequest(input: {
		id?: string;
		requestId: string;
		selectedOption: string;
		rationale: string;
		actor: { kind: "USER" | "SYSTEM"; id: string };
	}): string {
		const id = input.id ?? randomUUID();
		this.atomic(() => {
			const request = this.db
				.prepare("SELECT run_id, state, options_json, created_at FROM decision_requests WHERE id = ?")
				.get<{ run_id: string; state: string; options_json: string; created_at: string }>(input.requestId);
			if (!request) throw new DomainInvariantError("DECISION_REQUEST_NOT_FOUND", "Decision request was not found");
			if (request.state !== "OPEN") throw new DomainInvariantError("DECISION_ALREADY_RECORDED", "Request is not open");
			this.assertHumanInputAllowed(request.run_id);
			const options = JSON.parse(request.options_json) as unknown;
			if (!Array.isArray(options) || !options.includes(input.selectedOption)) {
				throw new DomainInvariantError("INVALID_DECISION_OPTION", "Selected option is not offered by the request");
			}
			const timestamp = now();
			this.db
				.prepare(
					"INSERT INTO decisions (id, request_id, selected_option, rationale, actor_kind, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(id, input.requestId, input.selectedOption, input.rationale, input.actor.kind, input.actor.id, timestamp);
			this.db
				.prepare("UPDATE decision_requests SET state = 'DECIDED', decided_at = ? WHERE id = ? AND state = 'OPEN'")
				.run(timestamp, input.requestId);
			const waitMs = Math.max(0, Date.parse(timestamp) - Date.parse(request.created_at));
			this.recordUsageInternal({
				runId: request.run_id,
				kind: "HUMAN_WAIT",
				phase: "DECISION_REQUEST",
				startedAt: request.created_at,
				finishedAt: timestamp,
				durationMs: waitMs,
				details: { requestId: input.requestId, selectedOption: input.selectedOption },
			});
			this.event({
				runId: request.run_id,
				aggregateType: "DECISION_REQUEST",
				aggregateId: input.requestId,
				aggregateVersion: 2,
				eventType: "HumanDecisionRecorded",
				actor: input.actor,
				payload: { decisionId: id, selectedOption: input.selectedOption },
			});
		});
		return id;
	}

	recordUsage(input: {
		id?: string;
		runId: string;
		taskId?: string;
		attemptId?: string;
		kind: "AGENT" | "CHECK" | "REVIEW" | "INTEGRATION" | "COORDINATION" | "HUMAN_WAIT";
		phase: string;
		startedAt: string;
		finishedAt: string;
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		costUsd?: number;
		toolCalls?: number;
		details?: unknown;
	}): string {
		this.requireRun(input.runId);
		for (const value of [
			input.inputTokens,
			input.outputTokens,
			input.cacheReadTokens,
			input.cacheWriteTokens,
			input.costUsd,
			input.toolCalls,
		]) {
			if (value !== undefined && (!Number.isFinite(value) || value < 0))
				throw new DomainInvariantError("INVALID_USAGE", "Usage must be finite and nonnegative");
		}
		if (input.id) {
			const previous = this.db
				.prepare("SELECT run_id, attempt_id FROM usage_records WHERE id = ?")
				.get<{ run_id: string; attempt_id: string | null }>(input.id);
			if (previous && (previous.run_id !== input.runId || previous.attempt_id !== (input.attemptId ?? null)))
				throw new DomainInvariantError("USAGE_IDENTITY_MISMATCH", "Cannot replace another execution's usage");
		}
		return this.recordUsageInternal({
			...input,
			durationMs: Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.startedAt)),
		});
	}

	private recordUsageInternal(input: {
		id?: string;
		runId: string;
		taskId?: string;
		attemptId?: string;
		kind: "AGENT" | "CHECK" | "REVIEW" | "INTEGRATION" | "COORDINATION" | "HUMAN_WAIT";
		phase: string;
		startedAt: string;
		finishedAt: string;
		durationMs: number;
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		costUsd?: number;
		toolCalls?: number;
		details?: unknown;
	}): string {
		const id = input.id ?? randomUUID();
		this.db
			.prepare(
				`INSERT INTO usage_records (
id, run_id, task_id, attempt_id, kind, phase, started_at, finished_at, duration_ms,
input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, tool_calls, details_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET finished_at=excluded.finished_at, duration_ms=excluded.duration_ms,
input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, cache_read_tokens=excluded.cache_read_tokens,
cache_write_tokens=excluded.cache_write_tokens, cost_usd=excluded.cost_usd, tool_calls=excluded.tool_calls, details_json=excluded.details_json`,
			)
			.run(
				id,
				input.runId,
				input.taskId ?? null,
				input.attemptId ?? null,
				input.kind,
				input.phase,
				input.startedAt,
				input.finishedAt,
				input.durationMs,
				input.inputTokens ?? null,
				input.outputTokens ?? null,
				input.cacheReadTokens ?? null,
				input.cacheWriteTokens ?? null,
				input.costUsd ?? null,
				input.toolCalls ?? null,
				JSON.stringify(input.details ?? {}),
			);
		return id;
	}

	startAuxiliaryAttempt(input: {
		id?: string;
		runId: string;
		taskId?: string;
		workflowFunction: "PLAN" | "EXPLORE" | "REVIEW";
		baseCommit: string;
		profileName: string;
		profileVersion: string;
		actor: Actor;
	}): string {
		const id = input.id ?? randomUUID();
		const timestamp = now();
		this.atomic(() => {
			this.assertRunOpen(this.requireRun(input.runId));
			if (input.workflowFunction === "PLAN" && input.taskId !== undefined) {
				throw new DomainInvariantError("INVALID_AUXILIARY_ATTEMPT", "Planner attempts are run-scoped");
			}
			if (input.workflowFunction === "REVIEW" || (input.workflowFunction === "EXPLORE" && input.taskId)) {
				if (!input.taskId)
					throw new DomainInvariantError("INVALID_AUXILIARY_ATTEMPT", "Reviewer attempts require a task");
				const task = this.requireTask(input.taskId);
				if (task.run_id !== input.runId)
					throw new DomainInvariantError("CROSS_RUN_ATTEMPT", "Task belongs to another run");
			}
			this.db
				.prepare(
					"INSERT INTO attempts (id, run_id, task_id, workflow_function, epoch, state, base_commit, profile_name, profile_version, last_heartbeat, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 'RUNNING', ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					input.runId,
					input.taskId ?? null,
					input.workflowFunction,
					input.baseCommit,
					input.profileName,
					input.profileVersion,
					timestamp,
					timestamp,
					timestamp,
				);
			this.event({
				runId: input.runId,
				aggregateType: "ATTEMPT",
				aggregateId: id,
				aggregateVersion: 1,
				eventType:
					input.workflowFunction === "PLAN"
						? "PlannerAttemptStarted"
						: input.workflowFunction === "EXPLORE"
							? "ExplorerAttemptStarted"
							: "ReviewerAttemptStarted",
				actor: input.actor,
				payload: { taskId: input.taskId ?? null, baseCommit: input.baseCommit },
			});
		});
		return id;
	}

	completeAuxiliaryAttempt(attemptId: string, actor: Actor): void {
		this.atomic(() => {
			const attempt = this.requireAttempt(attemptId);
			if (attempt.workflow_function === "IMPLEMENT") {
				throw new DomainInvariantError(
					"NOT_AUXILIARY_ATTEMPT",
					"Implementer attempts complete through candidate submission",
				);
			}
			if (attempt.state !== "RUNNING") throw new DomainInvariantError("ATTEMPT_NOT_RUNNING", "Attempt is not running");
			this.db.prepare("UPDATE attempts SET state = 'SUBMITTED', updated_at = ? WHERE id = ?").run(now(), attemptId);
			this.event({
				runId: attempt.run_id,
				aggregateType: "ATTEMPT",
				aggregateId: attempt.id,
				aggregateVersion: 2,
				eventType: "AuxiliaryAttemptCompleted",
				actor,
				payload: { workflowFunction: attempt.workflow_function },
			});
		});
	}

	createExecution(input: {
		id?: string;
		attemptId: string;
		piSessionId: string;
		contextManifestHash: string;
		actor: Actor;
	}): string {
		const id = input.id ?? randomUUID();
		const bindingId = randomUUID();
		const timestamp = now();
		this.atomic(() => {
			const attempt = this.requireAttempt(input.attemptId);
			if (attempt.state !== "RUNNING") throw new DomainInvariantError("ATTEMPT_NOT_RUNNING", "Attempt is not running");
			const existingBinding = this.db
				.prepare("SELECT context_manifest_hash FROM session_bindings WHERE attempt_id = ? AND pi_session_id = ?")
				.get<{ context_manifest_hash: string }>(attempt.id, input.piSessionId);
			if (existingBinding && existingBinding.context_manifest_hash !== input.contextManifestHash) {
				throw new DomainInvariantError(
					"CONTEXT_MANIFEST_MISMATCH",
					"A resumed Pi session cannot be rebound to different authoritative context",
				);
			}
			this.db
				.prepare(
					"INSERT INTO executions (id, attempt_id, state, created_at, updated_at) VALUES (?, ?, 'STARTING', ?, ?)",
				)
				.run(id, attempt.id, timestamp, timestamp);
			this.db
				.prepare(
					`INSERT INTO session_bindings (id, attempt_id, execution_id, pi_session_id, context_manifest_hash, created_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(attempt_id, pi_session_id) DO UPDATE SET
  execution_id = excluded.execution_id`,
				)
				.run(bindingId, attempt.id, id, input.piSessionId, input.contextManifestHash, timestamp);
			this.event({
				runId: attempt.run_id,
				aggregateType: "EXECUTION",
				aggregateId: id,
				aggregateVersion: 1,
				eventType: "ExecutionStarting",
				actor: input.actor,
				payload: { attemptId: attempt.id, piSessionId: input.piSessionId },
			});
		});
		return id;
	}

	markExecutionLive(input: { executionId: string; sessionFile?: string; actor: Actor }): void {
		this.atomic(() => {
			const row = this.requireExecution(input.executionId);
			if (row.state !== "STARTING")
				throw new DomainInvariantError("EXECUTION_NOT_STARTING", "Execution is not starting");
			const timestamp = now();
			this.db
				.prepare(
					"UPDATE executions SET state = 'LIVE', process_started_at = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
				)
				.run(timestamp, timestamp, timestamp, row.id);
			if (input.sessionFile) {
				this.db
					.prepare("UPDATE session_bindings SET session_file = ? WHERE execution_id = ?")
					.run(input.sessionFile, row.id);
			}
			this.event({
				runId: row.run_id,
				aggregateType: "EXECUTION",
				aggregateId: row.id,
				aggregateVersion: 2,
				eventType: "ExecutionLive",
				actor: input.actor,
				payload: {},
			});
		});
	}

	finishExecution(input: {
		executionId: string;
		state: "EXITED" | "LOST" | "KILLED";
		exitCode?: number;
		exitSignal?: string;
		actor: Actor;
	}): void {
		this.atomic(() => {
			const row = this.requireExecution(input.executionId);
			if (row.state === "EXITED" || row.state === "LOST" || row.state === "KILLED") return;
			const timestamp = now();
			this.db
				.prepare("UPDATE executions SET state = ?, exit_code = ?, exit_signal = ?, updated_at = ? WHERE id = ?")
				.run(input.state, input.exitCode ?? null, input.exitSignal ?? null, timestamp, row.id);
			this.event({
				runId: row.run_id,
				aggregateType: "EXECUTION",
				aggregateId: row.id,
				aggregateVersion: 3,
				eventType: "Execution" + input.state,
				actor: input.actor,
				payload: { exitCode: input.exitCode ?? null, exitSignal: input.exitSignal ?? null },
			});
		});
	}

	failAttempt(input: { attemptId: string; reason: string; retryTask: boolean; actor: Actor }): void {
		this.atomic(() => {
			const attempt = this.requireAttempt(input.attemptId);
			if (attempt.state !== "RUNNING") throw new DomainInvariantError("ATTEMPT_NOT_RUNNING", "Attempt is not running");
			const timestamp = now();
			this.db
				.prepare("UPDATE attempts SET state = 'FAILED', terminal_reason = ?, updated_at = ? WHERE id = ?")
				.run(input.reason, timestamp, attempt.id);
			if (attempt.workflow_function === "IMPLEMENT") {
				if (!attempt.task_id || attempt.epoch === null)
					throw new DomainInvariantError("INVALID_IMPLEMENTER", "Writer identity is incomplete");
				const task = this.requireTask(attempt.task_id);
				const target = input.retryTask ? "READY" : "BLOCKED";
				assertTaskTransition(task.state, target);
				this.updateTaskState(task, target, task.version + 1, null);
			}
			this.event({
				runId: attempt.run_id,
				aggregateType: "ATTEMPT",
				aggregateId: attempt.id,
				aggregateVersion: 2,
				eventType: "AttemptFailed",
				actor: input.actor,
				payload: { reason: input.reason, retryTask: input.retryTask },
			});
		});
	}

	sendMessage(input: {
		id?: string;
		runId: string;
		taskId?: string;
		recipientKind: MessageRecipientKind;
		recipientId: string;
		kind: MessageKind;
		body: string;
		references?: MessageReference[];
		replyToId?: string;
		actor: Actor;
	}): string {
		const id = input.id ?? randomUUID();
		const body = input.body.trim();
		if (!body) throw new DomainInvariantError("EMPTY_MESSAGE", "Message body cannot be empty");
		if (body.length > 32_000)
			throw new DomainInvariantError("MESSAGE_TOO_LARGE", "Message body exceeds 32,000 characters");
		if (!input.recipientId.trim()) {
			throw new DomainInvariantError("INVALID_MESSAGE_RECIPIENT", "Message recipient id cannot be empty");
		}
		const references = input.references ?? [];
		for (const reference of references) {
			if (!reference.id.trim())
				throw new DomainInvariantError("INVALID_MESSAGE_REFERENCE", "Reference id cannot be empty");
		}
		this.atomic(() => {
			this.requireRun(input.runId);
			if (input.actor.kind === "USER") this.assertHumanInputAllowed(input.runId);
			let taskId = input.taskId;
			if (taskId) {
				const task = this.requireTask(taskId);
				if (task.run_id !== input.runId)
					throw new DomainInvariantError("CROSS_RUN_MESSAGE", "Message task belongs to another run");
			}
			if (input.actor.kind === "ATTEMPT") {
				const sender = this.requireAttempt(input.actor.id);
				if (sender.run_id !== input.runId)
					throw new DomainInvariantError("CROSS_RUN_MESSAGE", "Message sender belongs to another run");
				if (sender.state !== "RUNNING")
					throw new DomainInvariantError("INACTIVE_MESSAGE_SENDER", "Only a running attempt can send a message");
			}
			if (input.recipientKind === "ATTEMPT") {
				const recipient = this.requireAttempt(input.recipientId);
				if (recipient.run_id !== input.runId)
					throw new DomainInvariantError("CROSS_RUN_MESSAGE", "Message recipient belongs to another run");
			} else if (input.recipientKind === "TASK") {
				const recipient = this.requireTask(input.recipientId);
				if (recipient.run_id !== input.runId)
					throw new DomainInvariantError("CROSS_RUN_MESSAGE", "Message recipient belongs to another run");
				taskId ??= recipient.id;
			}
			if (input.replyToId) {
				const replyTo = this.requireMessage(input.replyToId);
				if (replyTo.run_id !== input.runId)
					throw new DomainInvariantError("CROSS_RUN_MESSAGE", "Reply target belongs to another run");
			}
			const timestamp = now();
			this.db
				.prepare(
					"INSERT INTO messages (id, run_id, task_id, sender_kind, sender_id, recipient_kind, recipient_id, kind, body, references_json, reply_to_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					input.runId,
					taskId ?? null,
					input.actor.kind,
					input.actor.id,
					input.recipientKind,
					input.recipientId,
					input.kind,
					body,
					JSON.stringify(references),
					input.replyToId ?? null,
					timestamp,
				);
			this.event({
				runId: input.runId,
				aggregateType: "MESSAGE",
				aggregateId: id,
				aggregateVersion: 1,
				eventType: "MessageSent",
				actor: input.actor,
				payload: { taskId: taskId ?? null, recipientKind: input.recipientKind, recipientId: input.recipientId },
			});
		});
		return id;
	}

	markMessageRead(input: {
		messageId: string;
		recipientKind: MessageRecipientKind;
		recipientId: string;
		actor: Actor;
	}): void {
		this.atomic(() => {
			const message = this.requireMessage(input.messageId);
			if (message.recipient_kind !== input.recipientKind || message.recipient_id !== input.recipientId) {
				throw new DomainInvariantError("WRONG_MESSAGE_RECIPIENT", "Message is addressed to another recipient");
			}
			if (input.actor.kind !== "SYSTEM") {
				const direct = input.actor.kind === input.recipientKind && input.actor.id === input.recipientId;
				let taskScoped = false;
				if (input.recipientKind === "TASK" && input.actor.kind === "ATTEMPT") {
					const attempt = this.requireAttempt(input.actor.id);
					taskScoped = attempt.task_id === input.recipientId;
				}
				if (!direct && !taskScoped) {
					throw new DomainInvariantError("MESSAGE_READ_FORBIDDEN", "Actor cannot acknowledge this message");
				}
			}
			if (message.read_at) return;
			this.db.prepare("UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL").run(now(), message.id);
			this.event({
				runId: message.run_id,
				aggregateType: "MESSAGE",
				aggregateId: message.id,
				aggregateVersion: 2,
				eventType: "MessageRead",
				actor: input.actor,
				payload: { recipientKind: input.recipientKind, recipientId: input.recipientId },
			});
		});
	}

	createRun(input: {
		id?: string;
		repositoryRoot: string;
		objective?: string;
		inputCommit: string;
		inputTreeHash?: string;
		integrationRef: string;
		goalContract?: unknown;
		actor: Actor;
	}): string {
		const id = input.id ?? randomUUID();
		const timestamp = now();
		this.atomic(() => {
			this.db
				.prepare(
					"INSERT INTO runs (id, repository_root, objective, input_commit, integration_ref, integration_head, state, goal_contract_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)",
				)
				.run(
					id,
					input.repositoryRoot,
					input.objective ?? "",
					input.inputCommit,
					input.integrationRef,
					input.inputCommit,
					JSON.stringify(input.goalContract ?? {}),
					timestamp,
					timestamp,
				);
			if (input.inputTreeHash) this.bindIntegrationTree(id, input.inputCommit, input.inputTreeHash);
			this.event({
				runId: id,
				aggregateType: "RUN",
				aggregateId: id,
				aggregateVersion: 1,
				eventType: "RunCreated",
				actor: input.actor,
				payload: {
					objective: input.objective ?? "",
					inputCommit: input.inputCommit,
					integrationRef: input.integrationRef,
					goalContract: input.goalContract ?? {},
				},
			});
		});
		return id;
	}

	createTask(input: {
		id?: string;
		revisionId?: string;
		runId: string;
		parentTaskId?: string;
		title: string;
		objective: string;
		scope: unknown;
		constraints: unknown;
		acceptanceContract: unknown;
		riskClass: string;
		requiredCapabilities?: string[];
		priority?: number;
		actor: Actor;
	}): string {
		validateTaskSpec(
			{
				title: input.title,
				objective: input.objective,
				scope: input.scope,
				constraints: input.constraints,
				acceptanceContract: input.acceptanceContract,
				riskClass: input.riskClass,
				priority: input.priority ?? 0,
				requiredCapabilities: input.requiredCapabilities,
			},
			"task",
		);
		const id = input.id ?? randomUUID();
		const revisionId = input.revisionId ?? randomUUID();
		const timestamp = now();
		this.atomic(() => {
			this.assertRunOpen(this.requireRun(input.runId));
			this.db
				.prepare(
					"INSERT INTO tasks (id, run_id, parent_task_id, state, priority, risk_class, required_capabilities_json, created_at, updated_at) VALUES (?, ?, ?, 'PROPOSED', ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					input.runId,
					input.parentTaskId ?? null,
					input.priority ?? 0,
					input.riskClass,
					JSON.stringify(input.requiredCapabilities ?? []),
					timestamp,
					timestamp,
				);
			this.db
				.prepare(
					"INSERT INTO task_revisions (id, task_id, revision, title, objective, scope_json, constraints_json, acceptance_contract_json, provenance_json, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					revisionId,
					id,
					input.title,
					input.objective,
					JSON.stringify(input.scope),
					JSON.stringify(input.constraints),
					JSON.stringify(input.acceptanceContract),
					JSON.stringify({ actor: input.actor }),
					timestamp,
				);
			this.db.prepare("UPDATE tasks SET current_revision_id = ? WHERE id = ?").run(revisionId, id);
			this.event({
				runId: input.runId,
				aggregateType: "TASK",
				aggregateId: id,
				aggregateVersion: 1,
				eventType: "TaskProposed",
				actor: input.actor,
				payload: { revisionId, parentTaskId: input.parentTaskId ?? null },
			});
		});
		return id;
	}

	acceptInitialTaskGraph(input: {
		proposalId?: string;
		runId: string;
		sourceAttemptId: string;
		tasks: TaskGraphTaskInput[];
		dependencies: TaskGraphDependencyInput[];
		actor: { kind: "SYSTEM" | "USER"; id: string };
	}): Map<string, string> {
		if (input.tasks.length === 0) throw new DomainInvariantError("EMPTY_TASK_GRAPH", "Task graph cannot be empty");
		if (input.tasks.length > 32) {
			throw new DomainInvariantError("TASK_GRAPH_TOO_LARGE", "Initial task graph cannot exceed 32 tasks");
		}
		const byKey = new Map<string, TaskGraphTaskInput>();
		for (const task of input.tasks) {
			if (!task.key.trim() || !/^[A-Za-z0-9._-]+$/.test(task.key) || byKey.has(task.key)) {
				throw new DomainInvariantError("INVALID_TASK_KEY", "Task graph keys must be non-empty and unique");
			}
			validateTaskSpec(task, `task[${task.key}]`);
			if (task.coordination) validateTaskCoordination(task.coordination);
			byKey.set(task.key, task);
		}
		const edges = new Map<string, string[]>();
		for (const key of byKey.keys()) edges.set(key, []);
		for (const dependency of input.dependencies) {
			if (!byKey.has(dependency.task) || !byKey.has(dependency.dependsOn)) {
				throw new DomainInvariantError("UNKNOWN_TASK_DEPENDENCY", "Task dependency references an unknown key");
			}
			if (dependency.task === dependency.dependsOn) {
				throw new DomainInvariantError("DEPENDENCY_CYCLE", "Task cannot depend on itself");
			}
			edges.get(dependency.task)?.push(dependency.dependsOn);
		}
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (key: string): void => {
			if (visiting.has(key)) throw new DomainInvariantError("DEPENDENCY_CYCLE", "Task graph contains a cycle");
			if (visited.has(key)) return;
			visiting.add(key);
			for (const upstream of edges.get(key) ?? []) visit(upstream);
			visiting.delete(key);
			visited.add(key);
		};
		for (const key of byKey.keys()) visit(key);

		const proposalId = input.proposalId ?? randomUUID();
		const timestamp = now();
		return this.atomic(() => {
			this.assertRunOpen(this.requireRun(input.runId));
			const source = this.requireAttempt(input.sourceAttemptId);
			if (source.run_id !== input.runId || source.workflow_function !== "PLAN" || source.state !== "SUBMITTED") {
				throw new DomainInvariantError(
					"INVALID_PLAN_PROVENANCE",
					"Accepted task graph must come from a finished planner attempt",
				);
			}
			const existing =
				this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get<{ count: number }>(input.runId)
					?.count ?? 0;
			if (existing > 0) {
				throw new DomainInvariantError("INITIAL_GRAPH_EXISTS", "Initial task graph has already been accepted");
			}
			this.db
				.prepare(
					"INSERT INTO task_graph_proposals (id, run_id, source_attempt_id, state, proposal_json, validation_json, created_at, decided_at) VALUES (?, ?, ?, 'ACCEPTED', ?, ?, ?, ?)",
				)
				.run(
					proposalId,
					input.runId,
					input.sourceAttemptId,
					JSON.stringify({ tasks: input.tasks, dependencies: input.dependencies }),
					JSON.stringify({ schema: "task-graph/v1", acyclic: true, taskCount: input.tasks.length }),
					timestamp,
					timestamp,
				);
			const ids = new Map<string, string>();
			for (const task of input.tasks) {
				const taskId = randomUUID();
				const revisionId = randomUUID();
				ids.set(task.key, taskId);
				this.db
					.prepare(
						"INSERT INTO tasks (id, run_id, state, priority, risk_class, required_capabilities_json, created_at, updated_at) VALUES (?, ?, 'PROPOSED', ?, ?, ?, ?, ?)",
					)
					.run(
						taskId,
						input.runId,
						task.priority,
						task.riskClass,
						JSON.stringify(task.requiredCapabilities ?? []),
						timestamp,
						timestamp,
					);
				this.db
					.prepare(
						"INSERT INTO task_revisions (id, task_id, revision, title, objective, scope_json, constraints_json, acceptance_contract_json, provenance_json, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						revisionId,
						taskId,
						task.title,
						task.objective,
						JSON.stringify(task.scope),
						JSON.stringify(task.constraints),
						JSON.stringify(task.acceptanceContract),
						JSON.stringify({ proposalId, sourceAttemptId: input.sourceAttemptId }),
						timestamp,
					);
				this.db.prepare("UPDATE tasks SET current_revision_id = ? WHERE id = ?").run(revisionId, taskId);
				if (task.coordination) {
					const assessmentId = randomUUID();
					const contractId = randomUUID();
					this.db
						.prepare(
							`INSERT INTO coordination_assessments (
id, run_id, task_id, task_revision_id, decomposability, sequentiality, semantic_coupling,
integration_cost, uncertainty, rationale, evidence_refs_json, exploration_questions_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						)
						.run(
							assessmentId,
							input.runId,
							taskId,
							revisionId,
							task.coordination.assessment.decomposability,
							task.coordination.assessment.sequentiality,
							task.coordination.assessment.semanticCoupling,
							task.coordination.assessment.integrationCost,
							task.coordination.assessment.uncertainty,
							task.coordination.assessment.rationale,
							JSON.stringify(task.coordination.assessment.evidenceRefs),
							JSON.stringify(task.coordination.assessment.explorationQuestions),
							timestamp,
						);
					this.db
						.prepare(
							`INSERT INTO coordination_contracts (
id, run_id, task_id, task_revision_id, version, state, provides_json, requires_json,
assumptions_json, owned_scope_json, interfaces_json, evidence_refs_json, created_at, updated_at
) VALUES (?, ?, ?, ?, 1, 'BOUND', ?, ?, ?, ?, ?, ?, ?, ?)`,
						)
						.run(
							contractId,
							input.runId,
							taskId,
							revisionId,
							JSON.stringify(task.coordination.contract.provides),
							JSON.stringify(task.coordination.contract.requires),
							JSON.stringify(task.coordination.contract.assumptions),
							JSON.stringify(task.coordination.contract.ownedScope),
							JSON.stringify(task.coordination.contract.interfaces),
							JSON.stringify(task.coordination.contract.evidenceRefs),
							timestamp,
							timestamp,
						);
					this.db
						.prepare("UPDATE coordination_contracts SET obligations_json=? WHERE id=?")
						.run(JSON.stringify(task.coordination.contract.obligations ?? []), contractId);
					this.event({
						runId: input.runId,
						aggregateType: "COORDINATION_CONTRACT",
						aggregateId: contractId,
						aggregateVersion: 1,
						eventType: "CoordinationContractBound",
						actor: input.actor,
						payload: { taskId, revisionId, assessmentId },
					});
				}
				this.event({
					runId: input.runId,
					aggregateType: "TASK",
					aggregateId: taskId,
					aggregateVersion: 1,
					eventType: "TaskProposed",
					actor: input.actor,
					payload: { revisionId, proposalId, planKey: task.key },
				});
			}
			for (const dependency of input.dependencies) {
				this.db
					.prepare("INSERT INTO dependencies (task_id, depends_on_task_id, kind, created_at) VALUES (?, ?, ?, ?)")
					.run(ids.get(dependency.task), ids.get(dependency.dependsOn), dependency.kind, timestamp);
			}
			this.bindCoordinationDependencies(input.runId, input.actor);
			this.event({
				runId: input.runId,
				aggregateType: "TASK_GRAPH_PROPOSAL",
				aggregateId: proposalId,
				aggregateVersion: 1,
				eventType: "TaskGraphAccepted",
				actor: input.actor,
				payload: { sourceAttemptId: input.sourceAttemptId, taskCount: input.tasks.length },
			});
			return ids;
		});
	}

	proposeTaskChanges(input: { id?: string; runId: string; changes: TaskChangeSet; actor: Actor }): string {
		const id = input.id ?? randomUUID();
		const validation = validateTaskChangeSet(input.changes);
		this.atomic(() => {
			const run = this.requireRun(input.runId);
			if (input.actor.kind === "USER") this.assertHumanInputAllowed(run.id);
			if (run.state === "COMPLETED" || run.state === "CANCELLED") {
				throw new DomainInvariantError("RUN_TERMINAL", "Cannot propose task changes for a terminal run");
			}
			let sourceAttemptId: string | null = null;
			if (input.actor.kind === "ATTEMPT") {
				const attempt = this.requireAttempt(input.actor.id);
				if (attempt.run_id !== input.runId)
					throw new DomainInvariantError("CROSS_RUN_PROPOSAL", "Proposal source belongs to another run");
				if (attempt.state !== "RUNNING" && attempt.state !== "SUBMITTED") {
					throw new DomainInvariantError(
						"INACTIVE_PROPOSAL_SOURCE",
						"Proposal source attempt is not active or finished",
					);
				}
				sourceAttemptId = attempt.id;
			}
			for (const change of [...input.changes.revisions, ...input.changes.cancellations]) {
				const target = this.requireTask(change.taskId);
				if (target.run_id !== run.id || target.version !== change.expectedVersion)
					throw new DomainInvariantError("STALE_TASK_PROPOSAL", "Task version was already stale when proposed");
			}
			const timestamp = now();
			this.db
				.prepare(
					"INSERT INTO task_change_proposals (id, run_id, source_actor_kind, source_actor_id, source_attempt_id, expected_run_version, state, proposal_json, validation_json, created_at) VALUES (?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?, ?)",
				)
				.run(
					id,
					input.runId,
					input.actor.kind,
					input.actor.id,
					sourceAttemptId,
					run.version,
					JSON.stringify(input.changes),
					JSON.stringify(validation),
					timestamp,
				);
			this.db
				.prepare("UPDATE task_change_proposals SET expected_graph_hash = ? WHERE id = ?")
				.run(this.graphHash(input.runId), id);
			this.event({
				runId: input.runId,
				aggregateType: "TASK_CHANGE_PROPOSAL",
				aggregateId: id,
				aggregateVersion: 1,
				eventType: "TaskChangesProposed",
				actor: input.actor,
				payload: validation,
			});
		});
		return id;
	}

	acceptTaskChanges(proposalId: string, actor: { kind: "USER" | "SYSTEM"; id: string }): Map<string, string> {
		return this.atomic(() => {
			const proposal = this.requireTaskChangeProposal(proposalId);
			if (proposal.state !== "PROPOSED")
				throw new DomainInvariantError("PROPOSAL_ALREADY_DECIDED", "Task change proposal is already decided");
			const run = this.requireRun(proposal.run_id);
			if (run.state === "COMPLETED" || run.state === "CANCELLED")
				throw new DomainInvariantError("RUN_TERMINAL", "Cannot change the task graph of a terminal run");
			if (!this.taskProposalIsCurrent(proposalId)) {
				throw new DomainInvariantError("STALE_TASK_PROPOSAL", "Run changed after this task proposal was created");
			}
			if (actor.kind === "USER") this.assertHumanInputAllowed(run.id);
			const changes = JSON.parse(proposal.proposal_json) as TaskChangeSet;
			validateTaskChangeSet(changes);
			const timestamp = now();
			const addedIds = new Map<string, string>();
			for (const addition of changes.additions) addedIds.set(addition.key, randomUUID());
			const resolveReference = (reference: TaskChangeReference): string => {
				if ("taskId" in reference) return reference.taskId;
				const id = addedIds.get(reference.newTaskKey);
				if (!id) throw new DomainInvariantError("UNKNOWN_TASK_DEPENDENCY", "Added task reference is unknown");
				return id;
			};

			const existingTasks = this.db
				.prepare("SELECT id, run_id, state, version, attempt_epoch, active_attempt_id FROM tasks WHERE run_id = ?")
				.all<TaskRow>(run.id);
			const existingById = new Map(existingTasks.map((task) => [task.id, task]));
			for (const revision of changes.revisions) {
				const task = existingById.get(revision.taskId);
				if (!task) throw new DomainInvariantError("TASK_NOT_FOUND", "Revised task does not belong to this run");
				if (task.state === "ACTIVE" || task.state === "ACCEPTED" || task.state === "CANCELLED") {
					throw new DomainInvariantError("TASK_SPEC_FROZEN", "Cannot revise an active or terminal task");
				}
			}
			const cancelledIds = new Set(changes.cancellations.map((change) => change.taskId));
			for (const cancellation of changes.cancellations) {
				const task = existingById.get(cancellation.taskId);
				if (!task) throw new DomainInvariantError("TASK_NOT_FOUND", "Cancelled task does not belong to this run");
				if (task.state === "ACTIVE" || task.state === "ACCEPTED" || task.state === "CANCELLED") {
					throw new DomainInvariantError("TASK_NOT_CANCELLABLE", "Cannot cancel an active or terminal task");
				}
			}

			const allTaskIds = new Set([...existingById.keys(), ...addedIds.values()]);
			const edges = new Map<string, string[]>();
			for (const id of allTaskIds) edges.set(id, []);
			const existingDependencies = this.db
				.prepare(
					"SELECT d.task_id, d.depends_on_task_id, d.kind FROM dependencies d JOIN tasks t ON t.id = d.task_id WHERE t.run_id = ?",
				)
				.all<{ task_id: string; depends_on_task_id: string; kind: "REQUIRES" | "CONSUMES" }>(run.id);
			const edgeKeys = new Set<string>();
			for (const dependency of existingDependencies) {
				edges.get(dependency.task_id)?.push(dependency.depends_on_task_id);
				edgeKeys.add(`${dependency.task_id}\0${dependency.depends_on_task_id}\0${dependency.kind}`);
			}
			const resolvedDependencies = changes.dependencies.map((dependency) => ({
				taskId: resolveReference(dependency.task),
				dependsOnTaskId: resolveReference(dependency.dependsOn),
				kind: dependency.kind,
			}));
			for (const dependency of resolvedDependencies) {
				if (!allTaskIds.has(dependency.taskId) || !allTaskIds.has(dependency.dependsOnTaskId)) {
					throw new DomainInvariantError("CROSS_RUN_DEPENDENCY", "Dependency references a task outside this run");
				}
				if (cancelledIds.has(dependency.taskId) || cancelledIds.has(dependency.dependsOnTaskId)) {
					throw new DomainInvariantError("CONFLICTING_TASK_CHANGE", "Cancelled tasks cannot receive new dependencies");
				}
				const downstream = existingById.get(dependency.taskId);
				const upstream = existingById.get(dependency.dependsOnTaskId);
				if (
					downstream &&
					(downstream.state === "ACTIVE" || downstream.state === "ACCEPTED" || downstream.state === "CANCELLED")
				) {
					throw new DomainInvariantError("TASK_GRAPH_FROZEN", "Cannot add a dependency to an active or terminal task");
				}
				if (upstream?.state === "CANCELLED") {
					throw new DomainInvariantError("CANCELLED_DEPENDENCY", "Cannot depend on a cancelled task");
				}
				const edgeKey = `${dependency.taskId}\0${dependency.dependsOnTaskId}\0${dependency.kind}`;
				if (edgeKeys.has(edgeKey)) throw new DomainInvariantError("DUPLICATE_DEPENDENCY", "Dependency already exists");
				edgeKeys.add(edgeKey);
				edges.get(dependency.taskId)?.push(dependency.dependsOnTaskId);
			}
			const visiting = new Set<string>();
			const visited = new Set<string>();
			const visit = (id: string): void => {
				if (visiting.has(id)) throw new DomainInvariantError("DEPENDENCY_CYCLE", "Task changes create a cycle");
				if (visited.has(id)) return;
				visiting.add(id);
				for (const upstream of edges.get(id) ?? []) visit(upstream);
				visiting.delete(id);
				visited.add(id);
			};
			for (const id of allTaskIds) visit(id);

			for (const addition of changes.additions) {
				const taskId = addedIds.get(addition.key);
				if (!taskId) throw new DomainInvariantError("INVALID_TASK_KEY", "Added task identity was not allocated");
				const revisionId = randomUUID();
				this.db
					.prepare(
						"INSERT INTO tasks (id, run_id, state, priority, risk_class, required_capabilities_json, created_at, updated_at) VALUES (?, ?, 'PROPOSED', ?, ?, ?, ?, ?)",
					)
					.run(
						taskId,
						run.id,
						addition.priority,
						addition.riskClass,
						JSON.stringify(addition.requiredCapabilities ?? []),
						timestamp,
						timestamp,
					);
				this.db
					.prepare(
						"INSERT INTO task_revisions (id, task_id, revision, title, objective, scope_json, constraints_json, acceptance_contract_json, provenance_json, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						revisionId,
						taskId,
						addition.title,
						addition.objective,
						JSON.stringify(addition.scope),
						JSON.stringify(addition.constraints),
						JSON.stringify(addition.acceptanceContract),
						JSON.stringify({
							proposalId,
							sourceActor: { kind: proposal.source_actor_kind, id: proposal.source_actor_id },
						}),
						timestamp,
					);
				this.db.prepare("UPDATE tasks SET current_revision_id = ? WHERE id = ?").run(revisionId, taskId);
				this.event({
					runId: run.id,
					aggregateType: "TASK",
					aggregateId: taskId,
					aggregateVersion: 1,
					eventType: "TaskProposed",
					actor,
					payload: { revisionId, proposalId, planKey: addition.key },
				});
			}
			for (const revision of changes.revisions) {
				const task = this.requireTask(revision.taskId);
				const currentRevision = this.db
					.prepare(
						"SELECT revision FROM task_revisions WHERE id = (SELECT current_revision_id FROM tasks WHERE id = ?)",
					)
					.get<{ revision: number }>(task.id);
				if (!currentRevision)
					throw new DomainInvariantError("TASK_REVISION_NOT_FOUND", "Current task revision is missing");
				const revisionId = randomUUID();
				this.db
					.prepare(
						"INSERT INTO task_revisions (id, task_id, revision, title, objective, scope_json, constraints_json, acceptance_contract_json, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						revisionId,
						task.id,
						currentRevision.revision + 1,
						revision.title,
						revision.objective,
						JSON.stringify(revision.scope),
						JSON.stringify(revision.constraints),
						JSON.stringify(revision.acceptanceContract),
						JSON.stringify({
							proposalId,
							sourceActor: { kind: proposal.source_actor_kind, id: proposal.source_actor_id },
						}),
						timestamp,
					);
				const version = task.version + 1;
				const update = this.db
					.prepare(
						"UPDATE tasks SET current_revision_id = ?, priority = ?, risk_class = ?, required_capabilities_json = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?",
					)
					.run(
						revisionId,
						revision.priority,
						revision.riskClass,
						JSON.stringify(revision.requiredCapabilities ?? []),
						version,
						timestamp,
						task.id,
						task.version,
					);
				if (update.changes !== 1) {
					throw new DomainInvariantError("CONCURRENT_TASK_UPDATE", "Task changed while applying its revision");
				}
				this.db
					.prepare(
						"UPDATE coordination_contracts SET state = 'INVALIDATED', version = version + 1, updated_at = ? WHERE task_id = ? AND task_revision_id <> ? AND state <> 'INVALIDATED'",
					)
					.run(timestamp, task.id, revisionId);
				this.event({
					runId: run.id,
					aggregateType: "TASK",
					aggregateId: task.id,
					aggregateVersion: version,
					eventType: "TaskRevised",
					actor,
					payload: { revisionId, proposalId },
				});
			}
			for (const cancellation of changes.cancellations) {
				const task = this.requireTask(cancellation.taskId);
				const version = task.version + 1;
				this.updateTaskState(task, "CANCELLED", version, null);
				this.event({
					runId: run.id,
					aggregateType: "TASK",
					aggregateId: task.id,
					aggregateVersion: version,
					eventType: "TaskCancelled",
					actor,
					payload: { proposalId, reason: cancellation.reason },
				});
			}
			for (const addition of changes.additions)
				if (addition.coordination)
					this.recordTaskCoordination({
						taskId: resolveReference({ newTaskKey: addition.key }),
						...addition.coordination,
						actor,
					});
			for (const revision of changes.revisions)
				if (revision.coordination)
					this.recordTaskCoordination({ taskId: revision.taskId, ...revision.coordination, actor });
			for (const dependency of resolvedDependencies) {
				this.db
					.prepare("INSERT INTO dependencies (task_id, depends_on_task_id, kind, created_at) VALUES (?, ?, ?, ?)")
					.run(dependency.taskId, dependency.dependsOnTaskId, dependency.kind, timestamp);
				const task = this.requireTask(dependency.taskId);
				const version = this.bumpTaskVersion(task);
				this.event({
					runId: run.id,
					aggregateType: "TASK",
					aggregateId: task.id,
					aggregateVersion: version,
					eventType: "TaskDependencyAdded",
					actor,
					payload: { proposalId, dependsOnTaskId: dependency.dependsOnTaskId, kind: dependency.kind },
				});
			}
			this.bindCoordinationDependencies(run.id, actor);
			const runUpdate = this.db
				.prepare("UPDATE runs SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
				.run(timestamp, run.id, run.version);
			if (runUpdate.changes !== 1)
				throw new DomainInvariantError("CONCURRENT_RUN_UPDATE", "Run changed while applying task proposal");
			const proposalUpdate = this.db
				.prepare(
					"UPDATE task_change_proposals SET state = 'ACCEPTED', decided_by_kind = ?, decided_by_id = ?, decided_at = ? WHERE id = ? AND state = 'PROPOSED'",
				)
				.run(actor.kind, actor.id, timestamp, proposal.id);
			if (proposalUpdate.changes !== 1) {
				throw new DomainInvariantError("CONCURRENT_PROPOSAL_UPDATE", "Task proposal changed while being accepted");
			}
			this.event({
				runId: run.id,
				aggregateType: "TASK_CHANGE_PROPOSAL",
				aggregateId: proposal.id,
				aggregateVersion: 2,
				eventType: "TaskChangesAccepted",
				actor,
				payload: { runVersion: run.version + 1, addedTaskIds: Object.fromEntries(addedIds) },
			});
			return addedIds;
		});
	}

	rejectTaskChanges(proposalId: string, reason: string, actor: { kind: "USER" | "SYSTEM"; id: string }): void {
		if (!reason.trim())
			throw new DomainInvariantError("MISSING_DECISION_REASON", "Proposal rejection requires a reason");
		this.atomic(() => {
			const proposal = this.requireTaskChangeProposal(proposalId);
			if (actor.kind === "USER") this.assertHumanInputAllowed(proposal.run_id);
			if (proposal.state !== "PROPOSED")
				throw new DomainInvariantError("PROPOSAL_ALREADY_DECIDED", "Task change proposal is already decided");
			const timestamp = now();
			this.db
				.prepare(
					"UPDATE task_change_proposals SET state = 'REJECTED', decision_reason = ?, decided_by_kind = ?, decided_by_id = ?, decided_at = ? WHERE id = ? AND state = 'PROPOSED'",
				)
				.run(reason.trim(), actor.kind, actor.id, timestamp, proposal.id);
			this.event({
				runId: proposal.run_id,
				aggregateType: "TASK_CHANGE_PROPOSAL",
				aggregateId: proposal.id,
				aggregateVersion: 2,
				eventType: "TaskChangesRejected",
				actor,
				payload: { reason: reason.trim() },
			});
		});
	}

	addDependency(input: { taskId: string; dependsOnTaskId: string; kind: "REQUIRES" | "CONSUMES"; actor: Actor }): void {
		this.atomic(() => {
			const task = this.requireTask(input.taskId);
			const upstream = this.requireTask(input.dependsOnTaskId);
			if (task.run_id !== upstream.run_id) {
				throw new DomainInvariantError("CROSS_RUN_DEPENDENCY", "Task dependencies must stay within one run");
			}
			if (task.state === "ACTIVE" || task.state === "ACCEPTED" || task.state === "CANCELLED") {
				throw new DomainInvariantError("TASK_GRAPH_FROZEN", "Cannot add a dependency to an active or terminal task");
			}
			const cycle = this.db
				.prepare(
					"WITH RECURSIVE reachable(id) AS (SELECT depends_on_task_id FROM dependencies WHERE task_id = ? UNION SELECT d.depends_on_task_id FROM dependencies d JOIN reachable r ON d.task_id = r.id) SELECT 1 AS found FROM reachable WHERE id = ? LIMIT 1",
				)
				.get<{ found: number }>(input.dependsOnTaskId, input.taskId);
			if (input.taskId === input.dependsOnTaskId || cycle) {
				throw new DomainInvariantError("DEPENDENCY_CYCLE", "Dependency would create a cycle");
			}
			this.db
				.prepare("INSERT INTO dependencies (task_id, depends_on_task_id, kind, created_at) VALUES (?, ?, ?, ?)")
				.run(input.taskId, input.dependsOnTaskId, input.kind, now());
			const version = this.bumpTaskVersion(task);
			this.event({
				runId: task.run_id,
				aggregateType: "TASK",
				aggregateId: task.id,
				aggregateVersion: version,
				eventType: "TaskDependencyAdded",
				actor: input.actor,
				payload: { dependsOnTaskId: input.dependsOnTaskId, kind: input.kind },
			});
		});
	}

	markTaskReady(taskId: string, actor: Actor): void {
		this.atomic(() => {
			const task = this.requireTask(taskId);
			assertTaskTransition(task.state, "READY");
			const unresolved = this.db
				.prepare(
					"SELECT COUNT(*) AS count FROM dependencies d JOIN tasks upstream ON upstream.id = d.depends_on_task_id WHERE d.task_id = ? AND upstream.state <> 'ACCEPTED'",
				)
				.get<{ count: number }>(taskId);
			if ((unresolved?.count ?? 0) > 0) {
				throw new DomainInvariantError("UNRESOLVED_DEPENDENCIES", "Task dependencies are not accepted");
			}
			const version = task.version + 1;
			this.updateTaskState(task, "READY", version, null);
			this.event({
				runId: task.run_id,
				aggregateType: "TASK",
				aggregateId: task.id,
				aggregateVersion: version,
				eventType: "TaskReady",
				actor,
				payload: {},
			});
		});
	}

	startAttempt(input: {
		id?: string;
		taskId: string;
		baseCommit: string;
		profileName: string;
		profileVersion: string;
		actor: Actor;
	}): { attemptId: string; epoch: number } {
		const attemptId = input.id ?? randomUUID();
		return this.atomic(() => {
			const task = this.requireTask(input.taskId);
			this.assertRunOpen(this.requireRun(task.run_id));
			assertTaskTransition(task.state, "ACTIVE");
			const unresolved = this.db
				.prepare(
					"SELECT COUNT(*) AS count FROM dependencies d JOIN tasks upstream ON upstream.id = d.depends_on_task_id WHERE d.task_id = ? AND upstream.state <> 'ACCEPTED'",
				)
				.get<{ count: number }>(task.id);
			if ((unresolved?.count ?? 0) > 0) {
				throw new DomainInvariantError("UNRESOLVED_DEPENDENCIES", "Task dependencies changed before dispatch");
			}
			const epoch = task.attempt_epoch + 1;
			const timestamp = now();
			const predecessor = this.db
				.prepare(
					"SELECT id FROM attempts WHERE task_id = ? AND workflow_function = 'IMPLEMENT' ORDER BY epoch DESC LIMIT 1",
				)
				.get<{ id: string }>(task.id);
			this.db
				.prepare(
					"INSERT INTO attempts (id, run_id, task_id, workflow_function, epoch, state, base_commit, profile_name, profile_version, last_heartbeat, predecessor_attempt_id, created_at, updated_at) VALUES (?, ?, ?, 'IMPLEMENT', ?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					attemptId,
					task.run_id,
					task.id,
					epoch,
					input.baseCommit,
					input.profileName,
					input.profileVersion,
					timestamp,
					predecessor?.id ?? null,
					timestamp,
					timestamp,
				);
			const result = this.db
				.prepare(
					"UPDATE tasks SET state = 'ACTIVE', active_attempt_id = ?, attempt_epoch = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND state = 'READY'",
				)
				.run(attemptId, epoch, timestamp, task.id, task.version);
			if (result.changes !== 1)
				throw new DomainInvariantError("CONCURRENT_TASK_UPDATE", "Task changed during dispatch");
			this.event({
				runId: task.run_id,
				aggregateType: "TASK",
				aggregateId: task.id,
				aggregateVersion: task.version + 1,
				eventType: "AttemptStarted",
				actor: input.actor,
				payload: { attemptId, epoch, baseCommit: input.baseCommit },
			});
			return { attemptId, epoch };
		});
	}

	submitCandidate(input: {
		id?: string;
		taskId: string;
		attemptId: string;
		attemptEpoch: number;
		baseCommit: string;
		commitHash: string;
		treeHash: string;
		changedPaths: string[];
		note?: string;
		actor: Actor;
	}): string {
		const candidateId = input.id ?? randomUUID();
		this.atomic(() => {
			const task = this.requireTask(input.taskId);
			const attempt = this.requireAttempt(input.attemptId);
			assertActiveAttempt(taskSnapshot(task), attemptSnapshot(attempt), input.attemptEpoch);
			if (attempt.base_commit !== input.baseCommit) {
				throw new DomainInvariantError("BASE_COMMIT_MISMATCH", "Candidate base differs from the attempt snapshot");
			}
			const identity: CandidateIdentity = {
				id: candidateId,
				taskId: input.taskId,
				attemptId: input.attemptId,
				attemptEpoch: input.attemptEpoch,
				baseCommit: input.baseCommit,
				commitHash: input.commitHash,
				treeHash: input.treeHash,
			};
			assertCandidateIdentity(identity);
			const timestamp = now();
			this.db
				.prepare(
					"INSERT INTO candidates (id, task_id, attempt_id, attempt_epoch, base_commit, commit_hash, tree_hash, changed_paths_json, state, submission_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', ?, ?, ?)",
				)
				.run(
					candidateId,
					input.taskId,
					input.attemptId,
					input.attemptEpoch,
					input.baseCommit,
					input.commitHash,
					input.treeHash,
					JSON.stringify(input.changedPaths),
					input.note ?? "",
					timestamp,
					timestamp,
				);
			this.db
				.prepare("UPDATE attempts SET state = 'SUBMITTED', updated_at = ? WHERE id = ? AND state = 'RUNNING'")
				.run(timestamp, input.attemptId);
			const version = this.bumpTaskVersion(task);
			this.event({
				runId: task.run_id,
				aggregateType: "CANDIDATE",
				aggregateId: candidateId,
				aggregateVersion: 1,
				eventType: "CandidateSubmitted",
				actor: input.actor,
				payload: identity,
			});
			this.event({
				runId: task.run_id,
				aggregateType: "TASK",
				aggregateId: task.id,
				aggregateVersion: version,
				eventType: "AttemptSubmitted",
				actor: input.actor,
				payload: { attemptId: attempt.id, candidateId },
			});
		});
		return candidateId;
	}

	recordCheckResult(input: {
		id?: string;
		runId: string;
		taskId?: string;
		subjectKind: "CANDIDATE" | "INTEGRATION" | "RUN";
		subjectId: string;
		treeHash: string;
		checkKind: string;
		checkVersion: string;
		evidenceClass?: EvidenceClass;
		command: unknown;
		environmentHash: string;
		state: "PASSED" | "FAILED" | "ERROR";
		exitCode?: number;
		stdoutPath?: string;
		stderrPath?: string;
		result?: unknown;
		artifacts?: RecordedArtifactInput[];
		actor: Actor;
	}): string {
		const id = input.id ?? randomUUID();
		const timestamp = now();
		this.atomic(() => {
			this.requireRun(input.runId);
			const artifactIds: string[] = [];
			for (const artifact of input.artifacts ?? []) {
				if (
					!artifact.kind.trim() ||
					!/^[a-f0-9]{64}$/.test(artifact.contentHash) ||
					!Number.isSafeInteger(artifact.sizeBytes) ||
					artifact.sizeBytes < 0 ||
					!artifact.mediaType.trim() ||
					!artifact.storageLocator.trim()
				) {
					throw new DomainInvariantError("INVALID_ARTIFACT", "Check artifact metadata is invalid");
				}
				const artifactId = randomUUID();
				this.db
					.prepare(
						"INSERT INTO artifacts (id, run_id, kind, content_hash, size_bytes, media_type, storage_kind, storage_locator, producer_kind, producer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CHECK_RUN', ?, ?)",
					)
					.run(
						artifactId,
						input.runId,
						artifact.kind,
						artifact.contentHash,
						artifact.sizeBytes,
						artifact.mediaType,
						artifact.storageKind,
						artifact.storageLocator,
						id,
						timestamp,
					);
				artifactIds.push(artifactId);
			}
			this.db
				.prepare(
					"INSERT INTO check_runs (id, run_id, task_id, subject_kind, subject_id, tree_hash, check_kind, check_version, command_json, environment_hash, state, exit_code, stdout_path, stderr_path, result_json, started_at, finished_at, created_at, evidence_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					input.runId,
					input.taskId ?? null,
					input.subjectKind,
					input.subjectId,
					input.treeHash,
					input.checkKind,
					input.checkVersion,
					JSON.stringify(input.command),
					input.environmentHash,
					input.state,
					input.exitCode ?? null,
					input.stdoutPath ?? null,
					input.stderrPath ?? null,
					JSON.stringify(input.result ?? {}),
					timestamp,
					timestamp,
					timestamp,
					input.evidenceClass ?? "STRUCTURAL",
				);
			this.event({
				runId: input.runId,
				aggregateType: "CHECK_RUN",
				aggregateId: id,
				aggregateVersion: 1,
				eventType: "Check" + input.state,
				actor: input.actor,
				payload: {
					subjectKind: input.subjectKind,
					subjectId: input.subjectId,
					treeHash: input.treeHash,
					artifactIds,
				},
			});
		});
		return id;
	}

	markCandidateEligible(candidateId: string, actor: Actor): void {
		this.atomic(() => {
			const candidate = this.requireCandidate(candidateId);
			if (candidate.state !== "SUBMITTED") {
				throw new DomainInvariantError("CANDIDATE_NOT_SUBMITTED", "Only a submitted candidate can become eligible");
			}
			const task = this.requireTask(candidate.task_id);
			this.assertRunOpen(this.requireRun(task.run_id));
			if (task.state !== "ACTIVE") {
				throw new DomainInvariantError("TASK_NOT_ACTIVE", "Candidate authority ended before eligibility");
			}
			const contract = this.requireAcceptanceContract(task.id);
			const requiredCheckIds = this.requireContractChecks(
				contract.candidateChecks,
				"CANDIDATE",
				candidate.id,
				candidate.tree_hash,
			);
			this.db
				.prepare("UPDATE candidates SET state = 'ELIGIBLE', updated_at = ? WHERE id = ? AND state = 'SUBMITTED'")
				.run(now(), candidate.id);
			this.event({
				runId: task.run_id,
				aggregateType: "CANDIDATE",
				aggregateId: candidate.id,
				aggregateVersion: 2,
				eventType: "CandidateEligible",
				actor,
				payload: { checkIds: requiredCheckIds },
			});
		});
	}

	recordReview(input: {
		id?: string;
		candidateId: string;
		reviewerAttemptId: string;
		state: "APPROVED" | "CHANGES_REQUESTED" | "ABSTAINED";
		summary: string;
		findings?: Array<{
			id?: string;
			severity: "INFO" | "WARNING" | "BLOCKING";
			title: string;
			detail: string;
			references?: unknown[];
		}>;
		actor: Actor;
	}): string {
		const id = input.id ?? randomUUID();
		const timestamp = now();
		this.atomic(() => {
			const candidate = this.requireCandidate(input.candidateId);
			const task = this.requireTask(candidate.task_id);
			this.assertRunOpen(this.requireRun(task.run_id));
			if (task.state !== "ACTIVE") {
				throw new DomainInvariantError("TASK_NOT_ACTIVE", "Candidate authority ended before review completion");
			}
			const attempt = this.requireAttempt(input.reviewerAttemptId);
			if (attempt.workflow_function !== "REVIEW" || attempt.task_id !== candidate.task_id) {
				throw new DomainInvariantError("INVALID_REVIEWER_ATTEMPT", "Review provenance is not a reviewer for this task");
			}
			if (attempt.state !== "SUBMITTED") {
				throw new DomainInvariantError(
					"REVIEWER_NOT_FINISHED",
					"Reviewer attempt must finish before its result is recorded",
				);
			}
			this.db
				.prepare(
					"INSERT INTO reviews (id, task_id, candidate_id, tree_hash, reviewer_attempt_id, state, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					candidate.task_id,
					candidate.id,
					candidate.tree_hash,
					attempt.id,
					input.state,
					input.summary,
					timestamp,
					timestamp,
				);
			for (const finding of input.findings ?? []) {
				this.db
					.prepare(
						"INSERT INTO findings (id, review_id, severity, state, title, detail, references_json, created_at, updated_at) VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)",
					)
					.run(
						finding.id ?? randomUUID(),
						id,
						finding.severity,
						finding.title,
						finding.detail,
						JSON.stringify(finding.references ?? []),
						timestamp,
						timestamp,
					);
			}
			this.event({
				runId: task.run_id,
				aggregateType: "REVIEW",
				aggregateId: id,
				aggregateVersion: 1,
				eventType: "Review" + input.state,
				actor: input.actor,
				payload: { candidateId: candidate.id, reviewerAttemptId: attempt.id },
			});
		});
		return id;
	}

	rejectCandidate(input: { candidateId: string; reason: string; retryTask: boolean; actor: Actor }): void {
		this.atomic(() => {
			const candidate = this.requireCandidate(input.candidateId);
			if (candidate.state !== "SUBMITTED" && candidate.state !== "ELIGIBLE") {
				throw new DomainInvariantError("CANDIDATE_NOT_REJECTABLE", "Candidate is not awaiting a decision");
			}
			const task = this.requireTask(candidate.task_id);
			const target = input.retryTask ? "READY" : "BLOCKED";
			assertTaskTransition(task.state, target);
			const timestamp = now();
			this.db
				.prepare("UPDATE candidates SET state = 'REJECTED', updated_at = ? WHERE id = ?")
				.run(timestamp, candidate.id);
			this.updateTaskState(task, target, task.version + 1, null);
			this.event({
				runId: task.run_id,
				aggregateType: "CANDIDATE",
				aggregateId: candidate.id,
				aggregateVersion: 3,
				eventType: "CandidateRejected",
				actor: input.actor,
				payload: { reason: input.reason, retryTask: input.retryTask },
			});
		});
	}

	queueIntegration(input: { id?: string; candidateId: string; expectedHead: string; actor: Actor }): string {
		const id = input.id ?? randomUUID();
		this.atomic(() => {
			const candidate = this.requireCandidate(input.candidateId);
			if (candidate.state !== "ELIGIBLE") {
				throw new DomainInvariantError("CANDIDATE_NOT_ELIGIBLE", "Candidate must pass its gates before integration");
			}
			const task = this.requireTask(candidate.task_id);
			const run = this.requireRun(task.run_id);
			this.assertRunOpen(run);
			if (task.state !== "ACTIVE") {
				throw new DomainInvariantError("TASK_NOT_ACTIVE", "Candidate authority ended before integration");
			}
			if (run.integration_head !== input.expectedHead) {
				throw new DomainInvariantError("STALE_INTEGRATION_HEAD", "Integration head changed before queueing");
			}
			const timestamp = now();
			this.db
				.prepare(
					"INSERT INTO integrations (id, run_id, task_id, candidate_id, expected_head, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?)",
				)
				.run(id, run.id, task.id, candidate.id, input.expectedHead, timestamp, timestamp);
			this.event({
				runId: run.id,
				aggregateType: "INTEGRATION",
				aggregateId: id,
				aggregateVersion: 1,
				eventType: "IntegrationQueued",
				actor: input.actor,
				payload: { candidateId: candidate.id, expectedHead: input.expectedHead },
			});
		});
		return id;
	}

	markIntegrationApplying(integrationId: string, actor: Actor): void {
		this.atomic(() => {
			const integration = this.requireIntegration(integrationId);
			if (integration.state !== "QUEUED") {
				throw new DomainInvariantError("INTEGRATION_NOT_QUEUED", "Integration is not queued");
			}
			const task = this.requireTask(integration.task_id);
			this.assertRunOpen(this.requireRun(integration.run_id));
			if (task.state !== "ACTIVE") {
				throw new DomainInvariantError("TASK_NOT_ACTIVE", "Task authority ended before integration apply");
			}
			this.db
				.prepare("UPDATE integrations SET state = 'APPLYING', updated_at = ? WHERE id = ?")
				.run(now(), integration.id);
			this.event({
				runId: integration.run_id,
				aggregateType: "INTEGRATION",
				aggregateId: integration.id,
				aggregateVersion: 2,
				eventType: "IntegrationApplying",
				actor,
				payload: {},
			});
		});
	}

	assertIntegrationPublishable(integrationId: string): void {
		this.atomic(() => {
			const integration = this.requireIntegration(integrationId);
			if (integration.state !== "APPLYING") {
				throw new DomainInvariantError("INTEGRATION_NOT_APPLYING", "Integration is not ready for publication");
			}
			const run = this.requireRun(integration.run_id);
			const task = this.requireTask(integration.task_id);
			this.assertRunOpen(run);
			if (task.state !== "ACTIVE") {
				throw new DomainInvariantError("TASK_NOT_ACTIVE", "Task authority ended before integration publication");
			}
			if (run.integration_head !== integration.expected_head) {
				throw new DomainInvariantError("STALE_INTEGRATION_HEAD", "Integration head changed before publication");
			}
		});
	}

	failIntegration(input: {
		integrationId: string;
		conflicted: boolean;
		reason: string;
		retryTask: boolean;
		actor: Actor;
	}): void {
		this.atomic(() => {
			const integration = this.requireIntegration(input.integrationId);
			if (integration.state !== "QUEUED" && integration.state !== "APPLYING") {
				throw new DomainInvariantError("INTEGRATION_NOT_PENDING", "Integration is not pending");
			}
			const task = this.requireTask(integration.task_id);
			const target = input.retryTask ? "READY" : "BLOCKED";
			assertTaskTransition(task.state, target);
			const timestamp = now();
			this.db
				.prepare("UPDATE integrations SET state = ?, failure_reason = ?, updated_at = ? WHERE id = ?")
				.run(input.conflicted ? "CONFLICTED" : "FAILED", input.reason, timestamp, integration.id);
			this.db
				.prepare("UPDATE candidates SET state = 'REJECTED', updated_at = ? WHERE id = ?")
				.run(timestamp, integration.candidate_id);
			this.updateTaskState(task, target, task.version + 1, null);
			this.event({
				runId: integration.run_id,
				aggregateType: "INTEGRATION",
				aggregateId: integration.id,
				aggregateVersion: 3,
				eventType: input.conflicted ? "IntegrationConflicted" : "IntegrationFailed",
				actor: input.actor,
				payload: { reason: input.reason, retryTask: input.retryTask },
			});
		});
	}

	commitIntegration(input: {
		integrationId: string;
		resultCommit: string;
		resultTreeHash: string;
		actor: Actor;
	}): void {
		this.atomic(() => {
			const integration = this.requireIntegration(input.integrationId);
			const run = this.requireRun(integration.run_id);
			const task = this.requireTask(integration.task_id);
			this.assertRunOpen(run);
			if (task.state !== "ACTIVE") {
				throw new DomainInvariantError("TASK_NOT_ACTIVE", "Task authority ended before integration commit");
			}
			if (integration.state !== "QUEUED" && integration.state !== "APPLYING") {
				throw new DomainInvariantError("INTEGRATION_NOT_PENDING", "Integration is not pending");
			}
			if (run.integration_head !== integration.expected_head) {
				throw new DomainInvariantError("STALE_INTEGRATION_HEAD", "Integration head changed before commit");
			}
			this.requireCoordinationEvidence(
				task.id,
				this.requireCandidate(integration.candidate_id).attempt_id,
				input.resultTreeHash,
			);
			const timestamp = now();
			const runUpdate = this.db
				.prepare(
					"UPDATE runs SET integration_head = ?, integration_tree_hash = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND integration_head = ?",
				)
				.run(input.resultCommit, input.resultTreeHash, timestamp, run.id, run.version, integration.expected_head);
			if (runUpdate.changes !== 1) {
				throw new DomainInvariantError("CONCURRENT_INTEGRATION_UPDATE", "Integration head CAS failed");
			}
			this.db
				.prepare(
					"UPDATE integrations SET state = 'COMMITTED', result_commit = ?, result_tree_hash = ?, updated_at = ? WHERE id = ?",
				)
				.run(input.resultCommit, input.resultTreeHash, timestamp, integration.id);
			this.db
				.prepare("UPDATE candidates SET state = 'INTEGRATED', updated_at = ? WHERE id = ?")
				.run(timestamp, integration.candidate_id);
			this.event({
				runId: run.id,
				aggregateType: "INTEGRATION",
				aggregateId: integration.id,
				aggregateVersion: 2,
				eventType: "IntegrationCommitted",
				actor: input.actor,
				payload: { resultCommit: input.resultCommit, resultTreeHash: input.resultTreeHash },
			});
		});
	}

	acceptTask(input: {
		id?: string;
		taskId: string;
		integrationId: string;
		actor: { kind: "USER" | "SYSTEM"; id: string };
	}): string {
		const decisionId = input.id ?? randomUUID();
		this.atomic(() => {
			const task = this.requireTask(input.taskId);
			const integration = this.requireIntegration(input.integrationId);
			if (integration.task_id !== task.id || integration.state !== "COMMITTED" || !integration.result_tree_hash) {
				throw new DomainInvariantError("NOT_INTEGRATED", "Task candidate is not committed");
			}
			const candidate = this.requireCandidate(integration.candidate_id);
			this.requireCoordinationEvidence(task.id, candidate.attempt_id, integration.result_tree_hash);
			const contract = this.requireAcceptanceContract(task.id);
			const checkIds = this.requireContractChecks(
				contract.integrationChecks,
				"INTEGRATION",
				integration.id,
				integration.result_tree_hash,
			);
			const reviewRows = this.db
				.prepare("SELECT id, state, tree_hash FROM reviews WHERE candidate_id = ? ORDER BY created_at DESC")
				.all<{ id: string; state: string; tree_hash: string }>(candidate.id);
			const reviewIds = reviewRows
				.filter((review) => review.state === "APPROVED" && review.tree_hash === candidate.tree_hash)
				.map((review) => review.id);
			if (contract.requireReview && reviewIds.length === 0) {
				throw new DomainInvariantError("REVIEW_REQUIRED", "Acceptance contract requires an approved review");
			}
			let blockingFindings = 0;
			for (const reviewId of reviewIds) {
				const review = this.db
					.prepare("SELECT state, tree_hash FROM reviews WHERE id = ? AND candidate_id = ?")
					.get<{ state: string; tree_hash: string }>(reviewId, candidate.id);
				if (!review || review.state !== "APPROVED" || review.tree_hash !== candidate.tree_hash) {
					throw new DomainInvariantError("REVIEW_NOT_APPROVED", "Review is missing, stale, or not approved");
				}
				const count = this.db
					.prepare(
						"SELECT COUNT(*) AS count FROM findings WHERE review_id = ? AND severity = 'BLOCKING' AND state = 'OPEN'",
					)
					.get<{ count: number }>(reviewId);
				blockingFindings += count?.count ?? 0;
			}
			assertAcceptancePreconditions({
				task: taskSnapshot(task),
				integrationCommitted: true,
				integrationTreeHash: integration.result_tree_hash,
				evidenceTreeHash: integration.result_tree_hash,
				requiredChecksPassed: true,
				blockingFindings,
			});
			const timestamp = now();
			this.db
				.prepare(
					"INSERT INTO acceptance_decisions (id, task_id, candidate_id, integration_id, result, evidence_json, override_reason, actor_kind, created_at) VALUES (?, ?, ?, ?, 'ACCEPTED', ?, ?, ?, ?)",
				)
				.run(
					decisionId,
					task.id,
					candidate.id,
					integration.id,
					JSON.stringify({ checkIds, reviewIds, contractSource: "frozen-task-revision" }),
					null,
					input.actor.kind,
					timestamp,
				);
			const version = task.version + 1;
			this.updateTaskState(task, "ACCEPTED", version, null);

			this.event({
				runId: task.run_id,
				aggregateType: "TASK",
				aggregateId: task.id,
				aggregateVersion: version,
				eventType: "TaskAccepted",
				actor: input.actor,
				payload: { decisionId, integrationId: integration.id, checkIds, reviewIds },
			});
		});
		return decisionId;
	}

	completeRun(input: { runId: string; treeHash: string }, actor: { kind: "USER" | "SYSTEM"; id: string }): void {
		this.atomic(() => {
			const run = this.requireRun(input.runId);
			const binding = this.db
				.prepare("SELECT integration_tree_hash FROM runs WHERE id = ?")
				.get<{ integration_tree_hash: string | null }>(run.id);
			if (!binding?.integration_tree_hash || binding.integration_tree_hash !== input.treeHash)
				throw new DomainInvariantError(
					"FINAL_TREE_MISMATCH",
					"Final evidence must match the authoritative integration tree",
				);
			if (this.db.prepare("SELECT id FROM decision_requests WHERE run_id = ? AND state = 'OPEN' LIMIT 1").get(run.id))
				throw new DomainInvariantError("UNRESOLVED_DECISION", "Cannot accept with unanswered decisions");
			const total =
				this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get<{ count: number }>(input.runId)
					?.count ?? 0;
			const unfinished =
				this.db
					.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND state NOT IN ('ACCEPTED', 'CANCELLED')")
					.get<{ count: number }>(input.runId)?.count ?? 0;
			if (total === 0 || unfinished > 0) {
				throw new DomainInvariantError("RUN_NOT_COMPLETE", "Run still has unfinished tasks");
			}
			const liveAttempts =
				this.db
					.prepare("SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND state = 'RUNNING'")
					.get<{ count: number }>(input.runId)?.count ?? 0;
			const liveExecutions =
				this.db
					.prepare(
						"SELECT COUNT(*) AS count FROM executions e JOIN attempts a ON a.id = e.attempt_id WHERE a.run_id = ? AND e.state IN ('REQUESTED', 'STARTING', 'LIVE')",
					)
					.get<{ count: number }>(input.runId)?.count ?? 0;
			if (liveAttempts > 0 || liveExecutions > 0) {
				throw new DomainInvariantError(
					"RUN_HAS_LIVE_WORK",
					"Run cannot complete while attempts or executions are live",
				);
			}
			const goal = this.db
				.prepare("SELECT goal_contract_json FROM runs WHERE id = ?")
				.get<{ goal_contract_json: string }>(run.id);
			const parsedGoal = goal ? (JSON.parse(goal.goal_contract_json) as unknown) : {};
			const runChecks =
				isRecord(parsedGoal) && Array.isArray(parsedGoal.runChecks) ? (parsedGoal.runChecks as CheckCommand[]) : [];
			const checkIds =
				runChecks.length > 0
					? this.requireContractChecks(runChecks, "RUN", run.id, input.treeHash)
					: this.requireAnyPassedChecks("RUN", run.id, input.treeHash);
			const timestamp = now();
			const update = this.db
				.prepare(
					"UPDATE runs SET state = 'COMPLETED', terminal_reason = NULL, version = version + 1, updated_at = ? WHERE id = ? AND state = 'OPEN' AND version = ?",
				)
				.run(timestamp, run.id, run.version);
			if (update.changes !== 1)
				throw new DomainInvariantError("CONCURRENT_RUN_UPDATE", "Run changed during completion");
			this.event({
				runId: input.runId,
				aggregateType: "RUN",
				aggregateId: input.runId,
				aggregateVersion: run.version + 1,
				eventType: "RunCompleted",
				actor,
				payload: { integrationHead: run.integration_head, treeHash: input.treeHash, checkIds },
			});
		});
	}

	blockRun(runId: string, reason: string, actor: Actor): void {
		this.atomic(() => {
			const run = this.requireRun(runId);
			if (run.state !== "OPEN") throw new DomainInvariantError("RUN_NOT_OPEN", "Only an open run can be blocked");
			const active =
				this.db
					.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND state IN ('READY', 'ACTIVE')")
					.get<{ count: number }>(runId)?.count ?? 0;
			if (active > 0) throw new DomainInvariantError("RUN_HAS_RUNNABLE_TASKS", "Run still has runnable tasks");
			const update = this.db
				.prepare(
					"UPDATE runs SET state = 'BLOCKED', terminal_reason = ?, version = version + 1, updated_at = ? WHERE id = ? AND state = 'OPEN' AND version = ?",
				)
				.run(reason, now(), run.id, run.version);
			if (update.changes !== 1) throw new DomainInvariantError("CONCURRENT_RUN_UPDATE", "Run changed during blocking");
			this.event({
				runId,
				aggregateType: "RUN",
				aggregateId: runId,
				aggregateVersion: run.version + 1,
				eventType: "RunBlocked",
				actor,
				payload: { reason },
			});
		});
	}

	resumeRun(runId: string, actor: Actor): void {
		this.atomic(() => {
			const run = this.requireRun(runId);
			if (run.state !== "BLOCKED") throw new DomainInvariantError("RUN_NOT_BLOCKED", "Only a blocked run can resume");
			const update = this.db
				.prepare(
					"UPDATE runs SET state = 'OPEN', terminal_reason = NULL, version = version + 1, updated_at = ? WHERE id = ? AND state = 'BLOCKED' AND version = ?",
				)
				.run(now(), run.id, run.version);
			if (update.changes !== 1) throw new DomainInvariantError("CONCURRENT_RUN_UPDATE", "Run changed during resume");
			this.event({
				runId,
				aggregateType: "RUN",
				aggregateId: runId,
				aggregateVersion: run.version + 1,
				eventType: "RunResumed",
				actor,
				payload: {},
			});
		});
	}

	cancelRun(runId: string, reason: string, actor: { kind: "USER" | "SYSTEM"; id: string }): string[] {
		if (!reason.trim()) throw new DomainInvariantError("MISSING_CANCEL_REASON", "Run cancellation requires a reason");
		return this.atomic(() => {
			const run = this.requireRun(runId);
			if (run.state === "COMPLETED" || run.state === "CANCELLED") {
				throw new DomainInvariantError("RUN_TERMINAL", "Completed or cancelled runs cannot be cancelled again");
			}
			const uncertainIntegration = this.db
				.prepare(
					`SELECT i.id
FROM integrations i
JOIN operations o ON o.aggregate_type = 'INTEGRATION' AND o.aggregate_id = i.id AND o.kind = 'UPDATE_INTEGRATION_REF'
WHERE i.run_id = ? AND i.state IN ('QUEUED', 'APPLYING')
  AND (o.phase IN ('RUNNING', 'COMPLETED') OR (o.phase = 'FAILED' AND o.attempts > 0))
LIMIT 1`,
				)
				.get<{ id: string }>(run.id);
			if (uncertainIntegration) {
				throw new DomainInvariantError(
					"INTEGRATION_RECONCILIATION_REQUIRED",
					`Integration ${uncertainIntegration.id} crossed the Git publish boundary; reconcile it before cancellation`,
				);
			}
			const timestamp = now();
			const activeAttempts = this.db
				.prepare("SELECT id FROM attempts WHERE run_id = ? AND state = 'RUNNING'")
				.all<{ id: string }>(run.id)
				.map((row) => row.id);
			this.db
				.prepare(
					"UPDATE executions SET state = 'KILLED', exit_signal = 'USER_CANCEL', updated_at = ? WHERE attempt_id IN (SELECT id FROM attempts WHERE run_id = ?) AND state IN ('REQUESTED', 'STARTING', 'LIVE')",
				)
				.run(timestamp, run.id);
			this.db
				.prepare(
					"UPDATE attempts SET state = 'ABORTED', terminal_reason = ?, updated_at = ? WHERE run_id = ? AND state = 'RUNNING'",
				)
				.run(reason.trim(), timestamp, run.id);
			this.db
				.prepare(
					"UPDATE tasks SET state = 'CANCELLED', active_attempt_id = NULL, version = version + 1, updated_at = ? WHERE run_id = ? AND state NOT IN ('ACCEPTED', 'CANCELLED')",
				)
				.run(timestamp, run.id);
			this.db
				.prepare(
					"UPDATE candidates SET state = 'REJECTED', updated_at = ? WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?) AND state IN ('SUBMITTED', 'ELIGIBLE')",
				)
				.run(timestamp, run.id);
			this.db
				.prepare(
					"UPDATE integrations SET state = 'FAILED', failure_reason = ?, updated_at = ? WHERE run_id = ? AND state IN ('QUEUED', 'APPLYING')",
				)
				.run("Run cancelled before Git publication", timestamp, run.id);
			this.db
				.prepare(
					`UPDATE operations
SET phase = 'FAILED', last_error = ?, updated_at = ?
WHERE aggregate_type = 'INTEGRATION'
  AND aggregate_id IN (SELECT id FROM integrations WHERE run_id = ?)
  AND phase = 'PENDING'`,
				)
				.run("Run cancelled before Git publication", timestamp, run.id);
			const update = this.db
				.prepare(
					"UPDATE runs SET state = 'CANCELLED', terminal_reason = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND state IN ('OPEN', 'BLOCKED')",
				)
				.run(reason.trim(), timestamp, run.id, run.version);
			if (update.changes !== 1) {
				throw new DomainInvariantError("CONCURRENT_RUN_UPDATE", "Run changed during cancellation");
			}
			this.event({
				runId: run.id,
				aggregateType: "RUN",
				aggregateId: run.id,
				aggregateVersion: run.version + 1,
				eventType: "RunCancelled",
				actor,
				payload: { reason: reason.trim(), fencedAttemptIds: activeAttempts },
			});
			return activeAttempts;
		});
	}

	recordRunReport(input: {
		id?: string;
		runId: string;
		runVersion: number;
		result: "VERIFIED_DELIVERY" | "STRUCTURAL_HANDOFF" | "BLOCKED" | "CANCELLED";
		finalCommit: string;
		finalTreeHash: string;
		deliveryRef?: string;
		manifestPath: string;
		summary: unknown;
		actor: { kind: "USER" | "SYSTEM"; id: string };
	}): string {
		const id = input.id ?? randomUUID();
		this.atomic(() => {
			const run = this.requireRun(input.runId);
			if (run.version !== input.runVersion) {
				throw new DomainInvariantError("STALE_RUN_REPORT", "Run changed before its terminal report was recorded");
			}
			const completedResult = input.result === "VERIFIED_DELIVERY" || input.result === "STRUCTURAL_HANDOFF";
			const hasBehavioralEvidence = Boolean(
				this.db
					.prepare(
						"SELECT 1 AS present FROM check_runs WHERE run_id = ? AND subject_kind = 'RUN' AND subject_id = ? AND tree_hash = ? AND state = 'PASSED' AND evidence_class IN ('BEHAVIORAL', 'EXTERNAL') LIMIT 1",
					)
					.get<{ present: number }>(run.id, run.id, input.finalTreeHash),
			);
			if (
				run.state === "OPEN" ||
				(run.state === "COMPLETED" ? !completedResult : input.result !== run.state) ||
				(run.state === "COMPLETED" &&
					input.result !== (hasBehavioralEvidence ? "VERIFIED_DELIVERY" : "STRUCTURAL_HANDOFF"))
			) {
				throw new DomainInvariantError("INVALID_RUN_REPORT", "Report result does not match terminal run state");
			}
			if (input.finalCommit !== run.integration_head) {
				throw new DomainInvariantError(
					"REPORT_HEAD_MISMATCH",
					"Report commit is not the authoritative integration head",
				);
			}
			const existing = this.db
				.prepare(
					"SELECT id, result, final_commit, final_tree_hash, delivery_ref, manifest_path, summary_json FROM run_reports WHERE run_id = ? AND run_version = ?",
				)
				.get<{
					id: string;
					result: string;
					final_commit: string;
					final_tree_hash: string;
					delivery_ref: string | null;
					manifest_path: string;
					summary_json: string;
				}>(run.id, run.version);
			const summary = JSON.stringify(input.summary);
			if (existing) {
				if (
					existing.result !== input.result ||
					existing.final_commit !== input.finalCommit ||
					existing.final_tree_hash !== input.finalTreeHash ||
					existing.delivery_ref !== (input.deliveryRef ?? null) ||
					existing.manifest_path !== input.manifestPath ||
					existing.summary_json !== summary
				) {
					throw new DomainInvariantError("RUN_REPORT_MISMATCH", "Existing report differs from this projection");
				}
				return;
			}
			this.db
				.prepare(
					"INSERT INTO run_reports (id, run_id, run_version, result, final_commit, final_tree_hash, delivery_ref, manifest_path, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					run.id,
					run.version,
					input.result,
					input.finalCommit,
					input.finalTreeHash,
					input.deliveryRef ?? null,
					input.manifestPath,
					summary,
					now(),
				);
			this.event({
				runId: run.id,
				aggregateType: "RUN_REPORT",
				aggregateId: id,
				aggregateVersion: 1,
				eventType: "RunReportRecorded",
				actor: input.actor,
				payload: { result: input.result, manifestPath: input.manifestPath, deliveryRef: input.deliveryRef ?? null },
			});
		});
		return id;
	}

	retryBlockedTask(taskId: string, actor: { kind: "USER" | "SYSTEM"; id: string }): void {
		this.atomic(() => {
			const task = this.requireTask(taskId);
			if (actor.kind === "USER") this.assertHumanInputAllowed(task.run_id);
			if (task.state !== "BLOCKED")
				throw new DomainInvariantError("TASK_NOT_BLOCKED", "Only a blocked task can be retried");
			const unresolved = this.db
				.prepare(
					"SELECT COUNT(*) AS count FROM dependencies d JOIN tasks upstream ON upstream.id = d.depends_on_task_id WHERE d.task_id = ? AND upstream.state <> 'ACCEPTED'",
				)
				.get<{ count: number }>(taskId)?.count;
			if ((unresolved ?? 0) > 0) {
				throw new DomainInvariantError("UNRESOLVED_DEPENDENCIES", "Blocked task still has unresolved dependencies");
			}
			assertTaskTransition(task.state, "READY");
			this.updateTaskState(task, "READY", task.version + 1, null);
			this.event({
				runId: task.run_id,
				aggregateType: "TASK",
				aggregateId: task.id,
				aggregateVersion: task.version + 1,
				eventType: "TaskRetryRequested",
				actor,
				payload: {},
			});
		});
	}

	blockReadyTask(taskId: string, reason: string, actor: { kind: "USER" | "SYSTEM"; id: string }): void {
		if (!reason.trim()) throw new DomainInvariantError("MISSING_BLOCK_REASON", "Task blocking requires a reason");
		this.atomic(() => {
			const task = this.requireTask(taskId);
			if (task.state !== "READY") {
				throw new DomainInvariantError("TASK_NOT_READY", "Only a ready task can be blocked by coordination policy");
			}
			assertTaskTransition(task.state, "BLOCKED");
			const version = task.version + 1;
			this.updateTaskState(task, "BLOCKED", version, null);
			this.event({
				runId: task.run_id,
				aggregateType: "TASK",
				aggregateId: task.id,
				aggregateVersion: version,
				eventType: "TaskBlocked",
				actor,
				payload: { reason: reason.trim() },
			});
		});
	}

	releaseBlockedTask(taskId: string, reason: string, actor: { kind: "USER" | "SYSTEM"; id: string }): void {
		if (!reason.trim()) throw new DomainInvariantError("MISSING_RELEASE_REASON", "Task release requires a reason");
		this.atomic(() => {
			const task = this.requireTask(taskId);
			if (actor.kind === "USER") this.assertHumanInputAllowed(task.run_id);
			if (task.state !== "BLOCKED") return;
			assertTaskTransition(task.state, "READY");
			const version = task.version + 1;
			this.updateTaskState(task, "READY", version, null);
			this.event({
				runId: task.run_id,
				aggregateType: "TASK",
				aggregateId: task.id,
				aggregateVersion: version,
				eventType: "TaskCoordinationReleased",
				actor,
				payload: { reason: reason.trim() },
			});
		});
	}

	getTask(taskId: string): TaskSnapshot {
		return taskSnapshot(this.requireTask(taskId));
	}

	private requireAcceptanceContract(taskId: string): {
		candidateChecks: CheckCommand[];
		integrationChecks: CheckCommand[];
		requireReview: boolean;
	} {
		const row = this.db
			.prepare(
				"SELECT r.acceptance_contract_json FROM tasks t JOIN task_revisions r ON r.id = t.current_revision_id WHERE t.id = ?",
			)
			.get<{ acceptance_contract_json: string }>(taskId);
		if (!row) throw new DomainInvariantError("TASK_REVISION_NOT_FOUND", "Task acceptance contract was not found");
		const contract = JSON.parse(row.acceptance_contract_json) as unknown;
		validateAcceptanceContract(contract);
		return contract as { candidateChecks: CheckCommand[]; integrationChecks: CheckCommand[]; requireReview: boolean };
	}

	private requireContractChecks(
		specifications: CheckCommand[],
		subjectKind: string,
		subjectId: string,
		treeHash: string,
	): string[] {
		if (specifications.length === 0) {
			throw new DomainInvariantError("MISSING_CHECKS", "Frozen contract requires at least one check");
		}
		return specifications.map((specification) => {
			const row = this.db
				.prepare(
					`SELECT id FROM check_runs
WHERE subject_kind = ? AND subject_id = ? AND tree_hash = ? AND state = 'PASSED'
  AND check_kind = ? AND check_version = ? AND evidence_class = ?
ORDER BY created_at DESC LIMIT 1`,
				)
				.get<{ id: string }>(
					subjectKind,
					subjectId,
					treeHash,
					specification.name,
					checkCommandVersion(specification),
					evidenceClassForCheck(specification),
				);
			if (!row) {
				throw new DomainInvariantError(
					"INVALID_CHECK_EVIDENCE",
					`Required ${subjectKind.toLowerCase()} check is missing, failed, stale, or has the wrong version: ${specification.name}`,
				);
			}
			return row.id;
		});
	}

	private requireAnyPassedChecks(subjectKind: string, subjectId: string, treeHash: string): string[] {
		const rows = this.db
			.prepare(
				"SELECT id FROM check_runs WHERE subject_kind = ? AND subject_id = ? AND tree_hash = ? AND state = 'PASSED' ORDER BY created_at",
			)
			.all<{ id: string }>(subjectKind, subjectId, treeHash);
		if (rows.length === 0)
			throw new DomainInvariantError("MISSING_CHECKS", "At least one exact-tree check is required");
		return rows.map((row) => row.id);
	}

	private requireRun(runId: string): RunRow {
		const row = this.db
			.prepare("SELECT id, integration_head, state, version FROM runs WHERE id = ?")
			.get<RunRow>(runId);
		if (!row) throw new DomainInvariantError("RUN_NOT_FOUND", "Run not found: " + runId);
		return row;
	}

	private assertRunOpen(run: RunRow): void {
		if (run.state !== "OPEN") {
			throw new DomainInvariantError("RUN_NOT_OPEN", "Authoritative work requires an open run");
		}
	}

	private requireTask(taskId: string): TaskRow {
		const row = this.db
			.prepare("SELECT id, run_id, state, version, attempt_epoch, active_attempt_id FROM tasks WHERE id = ?")
			.get<TaskRow>(taskId);
		if (!row) throw new DomainInvariantError("TASK_NOT_FOUND", "Task not found: " + taskId);
		return row;
	}

	private requireAttempt(attemptId: string): AttemptRow {
		const row = this.db
			.prepare("SELECT id, run_id, task_id, workflow_function, epoch, state, base_commit FROM attempts WHERE id = ?")
			.get<AttemptRow>(attemptId);
		if (!row) throw new DomainInvariantError("ATTEMPT_NOT_FOUND", "Attempt not found: " + attemptId);
		return row;
	}

	private requireExecution(executionId: string): ExecutionRow {
		const row = this.db
			.prepare("SELECT e.id, e.state, a.run_id FROM executions e JOIN attempts a ON a.id = e.attempt_id WHERE e.id = ?")
			.get<ExecutionRow>(executionId);
		if (!row) throw new DomainInvariantError("EXECUTION_NOT_FOUND", "Execution not found: " + executionId);
		return row;
	}

	private requireCandidate(candidateId: string): CandidateRow {
		const row = this.db
			.prepare(
				"SELECT id, task_id, attempt_id, attempt_epoch, base_commit, commit_hash, tree_hash, state FROM candidates WHERE id = ?",
			)
			.get<CandidateRow>(candidateId);
		if (!row) throw new DomainInvariantError("CANDIDATE_NOT_FOUND", "Candidate not found: " + candidateId);
		return row;
	}

	private requireIntegration(integrationId: string): IntegrationRow {
		const row = this.db
			.prepare(
				"SELECT id, run_id, task_id, candidate_id, expected_head, result_commit, result_tree_hash, state FROM integrations WHERE id = ?",
			)
			.get<IntegrationRow>(integrationId);
		if (!row) throw new DomainInvariantError("INTEGRATION_NOT_FOUND", "Integration not found: " + integrationId);
		return row;
	}

	private requireMessage(messageId: string): MessageRow {
		const row = this.db
			.prepare("SELECT id, run_id, task_id, recipient_kind, recipient_id, read_at FROM messages WHERE id = ?")
			.get<MessageRow>(messageId);
		if (!row) throw new DomainInvariantError("MESSAGE_NOT_FOUND", "Message not found: " + messageId);
		return row;
	}

	private requireTaskChangeProposal(proposalId: string): TaskChangeProposalRow {
		const row = this.db
			.prepare(
				"SELECT id, run_id, source_actor_kind, source_actor_id, expected_run_version, state, proposal_json FROM task_change_proposals WHERE id = ?",
			)
			.get<TaskChangeProposalRow>(proposalId);
		if (!row) throw new DomainInvariantError("PROPOSAL_NOT_FOUND", "Task change proposal not found: " + proposalId);
		return row;
	}

	private updateTaskState(
		task: TaskRow,
		state: TaskSnapshot["state"],
		version: number,
		activeAttemptId: string | null,
	): void {
		const result = this.db
			.prepare(
				"UPDATE tasks SET state = ?, active_attempt_id = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?",
			)
			.run(state, activeAttemptId, version, now(), task.id, task.version);
		if (result.changes !== 1) throw new DomainInvariantError("CONCURRENT_TASK_UPDATE", "Task version changed");
	}

	private bumpTaskVersion(task: TaskRow): number {
		const version = task.version + 1;
		const result = this.db
			.prepare("UPDATE tasks SET version = ?, updated_at = ? WHERE id = ? AND version = ?")
			.run(version, now(), task.id, task.version);
		if (result.changes !== 1) throw new DomainInvariantError("CONCURRENT_TASK_UPDATE", "Task version changed");
		return version;
	}

	private event(input: {
		runId: string;
		aggregateType: string;
		aggregateId: string;
		aggregateVersion: number;
		eventType: string;
		actor: Actor;
		payload: unknown;
	}): void {
		this.db
			.prepare(
				"INSERT INTO domain_events (id, run_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_kind, actor_id, correlation_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				randomUUID(),
				input.runId,
				input.aggregateType,
				input.aggregateId,
				input.aggregateVersion,
				input.eventType,
				input.actor.kind,
				input.actor.id,
				randomUUID(),
				JSON.stringify(input.payload),
				now(),
			);
	}
}
