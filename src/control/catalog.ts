import type { SqliteDatabase } from "@earendil-works/pi-session-backend-sqlite-node";
import type {
	CoordinationLevel,
	EvidenceClass,
	ExecutionMode,
	FailureDisposition,
	TaskState,
} from "../domain/model.ts";
import type { ControlDatabase } from "../store/database.ts";
import { type ContractObligation, parseObligations } from "./contract-types.ts";

export interface RunRecord {
	id: string;
	repositoryRoot: string;
	objective: string;
	inputCommit: string;
	integrationRef: string;
	integrationHead: string;
	state: "OPEN" | "COMPLETED" | "BLOCKED" | "CANCELLED";
	version: number;
	goalContract: unknown;
	terminalReason: string | null;
}

export interface TaskPerformance {
	taskId: string;
	durationMs: number;
	costUsd: number;
	writerSamples: number;
	checksMs: number;
	auxiliaryMs: number;
	auxiliaryCostUsd: number;
	explorationMs: number;
	explorationCostUsd: number;
	explorationSamples: number;
	successes: number;
	failures: number;
}

export interface TaskDefinition {
	id: string;
	runId: string;
	state: TaskState;
	priority: number;
	riskClass: string;
	requiredCapabilities: string[];
	attemptEpoch: number;
	activeAttemptId: string | null;
	revisionId: string;
	revision: number;
	title: string;
	objective: string;
	scope: unknown;
	constraints: unknown;
	acceptanceContract: unknown;
}

export interface CoordinationAssessment {
	id: string;
	runId: string;
	taskId: string;
	taskRevisionId: string;
	decomposability: CoordinationLevel;
	sequentiality: CoordinationLevel;
	semanticCoupling: CoordinationLevel;
	integrationCost: CoordinationLevel;
	uncertainty: CoordinationLevel;
	rationale: string;
	evidenceRefs: string[];
	explorationQuestions: Array<{ key: string; hypothesis: string; question: string }>;
}

export interface CoordinationContract {
	obligations: ContractObligation[];
	id: string;
	runId: string;
	taskId: string;
	taskRevisionId: string;
	version: number;
	state: "BOUND" | "SATISFIED" | "INVALIDATED";
	provides: string[];
	requires: string[];
	assumptions: string[];
	ownedScope: string[];
	interfaces: string[];
	evidenceRefs: string[];
}

export interface CoordinationDecisionRecord {
	id: string;
	runId: string;
	expectedRunVersion: number;
	integrationHead: string;
	mode: ExecutionMode;
	taskIds: string[];
	policyInputs: unknown;
	rationale: string;
	createdAt: string;
}

export interface FailureDiagnosisRecord {
	id: string;
	runId: string;
	taskId: string | null;
	attemptId: string | null;
	phase: string;
	classification: string;
	fingerprint: string;
	occurrence: number;
	disposition: FailureDisposition;
	detail: string;
	evidenceRefs: string[];
	createdAt: string;
}

export interface DecisionRequestRecord {
	id: string;
	runId: string;
	taskId: string | null;
	expectedRunVersion: number;
	kind:
		| "REQUIREMENT_CHOICE"
		| "AUTHORITY_EXPANSION"
		| "ACCEPTANCE_CHANGE"
		| "IRREVERSIBLE_ACTION"
		| "BUDGET_EXTENSION"
		| "SEMANTIC_CONTRACT";
	question: string;
	options: string[];
	recommendedOption: string | null;
	evidenceRefs: string[];
	sourceKind: string | null;
	sourceId: string | null;
	state: "OPEN" | "DECIDED" | "CANCELLED" | "STALE";
	createdAt: string;
	decidedAt: string | null;
}

export interface ExplorationRecord {
	id: string;
	runId: string;
	taskId: string;
	taskRevisionId: string;
	baselineCommit: string;
	investigationKey: string;
	hypothesis: string;
	question: string;
	state: "RUNNING" | "COMPLETED" | "FAILED";
	attemptId: string | null;
	report: string | null;
}

export interface MessageRecord {
	id: string;
	runId: string;
	taskId: string | null;
	senderKind: "USER" | "SYSTEM" | "ATTEMPT";
	senderId: string;
	recipientKind: "TASK" | "ATTEMPT" | "USER" | "SYSTEM";
	recipientId: string;
	kind: "QUESTION" | "ANSWER" | "OBSERVATION" | "HELP_REQUEST" | "PROPOSAL" | "HANDOFF";
	body: string;
	references: unknown[];
	replyToId: string | null;
	createdAt: string;
	readAt: string | null;
}

export interface AttemptDefinition {
	id: string;
	runId: string;
	taskId: string | null;
	workflowFunction: "PLAN" | "EXPLORE" | "IMPLEMENT" | "REVIEW";
	epoch: number | null;
	state: "CREATED" | "RUNNING" | "SUBMITTED" | "FAILED" | "ABORTED";
	baseCommit: string;
	profileName: string;
	profileVersion: string;
	piSessionId: string | null;
	contextManifestHash: string | null;
	terminalReason: string | null;
	predecessorAttemptId: string | null;
	createdAt: string;
}

interface AttemptDefinitionRow {
	id: string;
	run_id: string;
	task_id: string | null;
	workflow_function: AttemptDefinition["workflowFunction"];
	epoch: number | null;
	state: AttemptDefinition["state"];
	base_commit: string;
	profile_name: string;
	profile_version: string;
	pi_session_id: string | null;
	context_manifest_hash: string | null;
	terminal_reason: string | null;
	predecessor_attempt_id: string | null;
	created_at: string;
}

interface MessageRecordRow {
	id: string;
	run_id: string;
	task_id: string | null;
	sender_kind: MessageRecord["senderKind"];
	sender_id: string;
	recipient_kind: MessageRecord["recipientKind"];
	recipient_id: string;
	kind: MessageRecord["kind"];
	body: string;
	references_json: string;
	reply_to_id: string | null;
	created_at: string;
	read_at: string | null;
}

interface RunRow {
	id: string;
	repository_root: string;
	objective: string;
	input_commit: string;
	integration_ref: string;
	integration_head: string;
	state: RunRecord["state"];
	version: number;
	goal_contract_json: string;
	terminal_reason: string | null;
}

export interface TaskFeedbackPacket {
	taskId: string;
	attempts: Array<{
		id: string;
		epoch: number;
		state: AttemptDefinition["state"];
		baseCommit: string;
		terminalReason: string | null;
		createdAt: string;
	}>;
	checks: Array<{
		id: string;
		subjectKind: "CANDIDATE" | "INTEGRATION";
		subjectId: string;
		checkKind: string;
		state: "PASSED" | "FAILED" | "ERROR";
		exitCode: number | null;
		stdoutPath: string | null;
		stderrPath: string | null;
		result: unknown;
		createdAt: string;
	}>;
	reviews: Array<{
		id: string;
		candidateId: string;
		state: string;
		summary: string;
		findings: Array<{ severity: string; title: string; detail: string; state: string }>;
		createdAt: string;
	}>;
	integrations: Array<{
		id: string;
		candidateId: string;
		expectedHead: string;
		state: string;
		failureReason: string | null;
		createdAt: string;
	}>;
	messages: MessageRecord[];
}

interface TaskDefinitionRow {
	id: string;
	run_id: string;
	state: TaskState;
	priority: number;
	risk_class: string;
	required_capabilities_json: string;
	attempt_epoch: number;
	active_attempt_id: string | null;
	revision_id: string;
	revision: number;
	title: string;
	objective: string;
	scope_json: string;
	constraints_json: string;
	acceptance_contract_json: string;
}

export interface TaskChangeProposalRecord {
	id: string;
	runId: string;
	sourceActorKind: "USER" | "SYSTEM" | "ATTEMPT";
	sourceActorId: string;
	expectedRunVersion: number;
	state: "PROPOSED" | "ACCEPTED" | "REJECTED";
	proposal: unknown;
	validation: unknown;
	decisionReason: string | null;
	decidedByKind: "USER" | "SYSTEM" | null;
	decidedById: string | null;
	createdAt: string;
	decidedAt: string | null;
}

interface TaskChangeProposalRow {
	id: string;
	run_id: string;
	source_actor_kind: TaskChangeProposalRecord["sourceActorKind"];
	source_actor_id: string;
	expected_run_version: number;
	state: TaskChangeProposalRecord["state"];
	proposal_json: string;
	validation_json: string;
	decision_reason: string | null;
	decided_by_kind: TaskChangeProposalRecord["decidedByKind"];
	decided_by_id: string | null;
	created_at: string;
	decided_at: string | null;
}

export interface DomainEventRecord {
	id: string;
	runId: string;
	aggregateType: string;
	aggregateId: string;
	aggregateVersion: number;
	eventType: string;
	actorKind: "USER" | "SYSTEM" | "ATTEMPT";
	actorId: string;
	causationId: string | null;
	correlationId: string;
	payload: unknown;
	createdAt: string;
}

export interface ArtifactRecord {
	id: string;
	runId: string;
	kind: string;
	contentHash: string;
	sizeBytes: number;
	mediaType: string;
	storageKind: "LOCAL_FILE" | "GIT_OBJECT";
	storageLocator: string;
	producerKind: string;
	producerId: string;
	createdAt: string;
}

interface ArtifactRow {
	id: string;
	run_id: string;
	kind: string;
	content_hash: string;
	size_bytes: number;
	media_type: string;
	storage_kind: ArtifactRecord["storageKind"];
	storage_locator: string;
	producer_kind: string;
	producer_id: string;
	created_at: string;
}

interface DomainEventRow {
	id: string;
	run_id: string;
	aggregate_type: string;
	aggregate_id: string;
	aggregate_version: number;
	event_type: string;
	actor_kind: DomainEventRecord["actorKind"];
	actor_id: string;
	causation_id: string | null;
	correlation_id: string;
	payload_json: string;
	created_at: string;
}

function parseJson(value: string, label: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch (error) {
		throw new Error("Stored " + label + " is invalid JSON", { cause: error });
	}
}

function parseStringArray(value: string, label: string): string[] {
	const parsed = parseJson(value, label);
	if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
		throw new Error(`Stored ${label} must be a string array`);
	}
	return parsed;
}

function parseExplorationQuestions(value: string): Array<{ key: string; hypothesis: string; question: string }> {
	const parsed = parseJson(value, "exploration questions");
	if (
		!Array.isArray(parsed) ||
		!parsed.every(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				typeof (entry as Record<string, unknown>).key === "string" &&
				typeof (entry as Record<string, unknown>).hypothesis === "string" &&
				typeof (entry as Record<string, unknown>).question === "string",
		)
	) {
		throw new Error("Stored exploration questions are invalid");
	}
	return parsed as Array<{ key: string; hypothesis: string; question: string }>;
}

function runRecord(row: RunRow): RunRecord {
	return {
		id: row.id,
		repositoryRoot: row.repository_root,
		objective: row.objective,
		inputCommit: row.input_commit,
		integrationRef: row.integration_ref,
		integrationHead: row.integration_head,
		state: row.state,
		version: row.version,
		goalContract: parseJson(row.goal_contract_json, "goal contract"),
		terminalReason: row.terminal_reason,
	};
}

function taskDefinition(row: TaskDefinitionRow): TaskDefinition {
	return {
		id: row.id,
		runId: row.run_id,
		state: row.state,
		priority: row.priority,
		riskClass: row.risk_class,
		requiredCapabilities: (() => {
			const capabilities = parseJson(row.required_capabilities_json, "required capabilities");
			if (!Array.isArray(capabilities) || !capabilities.every((value) => typeof value === "string")) {
				throw new Error("Stored task capabilities must be a string array");
			}
			return capabilities;
		})(),
		attemptEpoch: row.attempt_epoch,
		activeAttemptId: row.active_attempt_id,
		revisionId: row.revision_id,
		revision: row.revision,
		title: row.title,
		objective: row.objective,
		scope: parseJson(row.scope_json, "task scope"),
		constraints: parseJson(row.constraints_json, "task constraints"),
		acceptanceContract: parseJson(row.acceptance_contract_json, "acceptance contract"),
	};
}

function messageRecord(row: MessageRecordRow): MessageRecord {
	const references = parseJson(row.references_json, "message references");
	if (!Array.isArray(references)) throw new Error("Stored message references must be an array");
	return {
		id: row.id,
		runId: row.run_id,
		taskId: row.task_id,
		senderKind: row.sender_kind,
		senderId: row.sender_id,
		recipientKind: row.recipient_kind,
		recipientId: row.recipient_id,
		kind: row.kind,
		body: row.body,
		references,
		replyToId: row.reply_to_id,
		createdAt: row.created_at,
		readAt: row.read_at,
	};
}

function attemptDefinition(row: AttemptDefinitionRow): AttemptDefinition {
	return {
		id: row.id,
		runId: row.run_id,
		taskId: row.task_id,
		workflowFunction: row.workflow_function,
		epoch: row.epoch,
		state: row.state,
		baseCommit: row.base_commit,
		profileName: row.profile_name,
		profileVersion: row.profile_version,
		piSessionId: row.pi_session_id,
		contextManifestHash: row.context_manifest_hash,
		terminalReason: row.terminal_reason,
		predecessorAttemptId: row.predecessor_attempt_id,
		createdAt: row.created_at,
	};
}

const TASK_DEFINITION_SELECT = `
SELECT t.id, t.run_id, t.state, t.priority, t.risk_class, t.required_capabilities_json, t.attempt_epoch,
       t.active_attempt_id, r.id AS revision_id, r.revision, r.title, r.objective,
       r.scope_json, r.constraints_json, r.acceptance_contract_json
FROM tasks t
JOIN task_revisions r ON r.id = t.current_revision_id`;

export class ControlCatalog {
	private readonly db: SqliteDatabase;

	constructor(database: ControlDatabase) {
		this.db = database.sql;
	}

	getRun(runId: string): RunRecord {
		const row = this.db
			.prepare(
				"SELECT id, repository_root, objective, input_commit, integration_ref, integration_head, state, version, goal_contract_json, terminal_reason FROM runs WHERE id = ?",
			)
			.get<RunRow>(runId);
		if (!row) throw new Error("Run not found: " + runId);
		return runRecord(row);
	}

	latestRun(): RunRecord | null {
		const row = this.db
			.prepare(
				"SELECT id, repository_root, objective, input_commit, integration_ref, integration_head, state, version, goal_contract_json, terminal_reason FROM runs ORDER BY created_at DESC LIMIT 1",
			)
			.get<RunRow>();
		return row ? runRecord(row) : null;
	}

	getTask(taskId: string): TaskDefinition {
		const row = this.db.prepare(TASK_DEFINITION_SELECT + " WHERE t.id = ?").get<TaskDefinitionRow>(taskId);
		if (!row) throw new Error("Task not found: " + taskId);
		return taskDefinition(row);
	}

	getCoordinationAssessment(taskId: string): CoordinationAssessment | null {
		const task = this.getTask(taskId);
		const row = this.db
			.prepare(
				`SELECT id, run_id, task_id, task_revision_id, decomposability, sequentiality,
semantic_coupling, integration_cost, uncertainty, rationale, evidence_refs_json, exploration_questions_json
FROM coordination_assessments WHERE task_id = ? AND task_revision_id = ?`,
			)
			.get<{
				id: string;
				run_id: string;
				task_id: string;
				task_revision_id: string;
				decomposability: CoordinationLevel;
				sequentiality: CoordinationLevel;
				semantic_coupling: CoordinationLevel;
				integration_cost: CoordinationLevel;
				uncertainty: CoordinationLevel;
				rationale: string;
				evidence_refs_json: string;
				exploration_questions_json: string;
			}>(taskId, task.revisionId);
		if (!row) return null;
		return {
			id: row.id,
			runId: row.run_id,
			taskId: row.task_id,
			taskRevisionId: row.task_revision_id,
			decomposability: row.decomposability,
			sequentiality: row.sequentiality,
			semanticCoupling: row.semantic_coupling,
			integrationCost: row.integration_cost,
			uncertainty: row.uncertainty,
			rationale: row.rationale,
			evidenceRefs: parseStringArray(row.evidence_refs_json, "coordination evidence refs"),
			explorationQuestions: parseExplorationQuestions(row.exploration_questions_json),
		};
	}

	getCoordinationContract(taskId: string): CoordinationContract | null {
		const task = this.getTask(taskId);
		const row = this.db
			.prepare(
				`SELECT id, run_id, task_id, task_revision_id, version, state, provides_json, requires_json,
assumptions_json, owned_scope_json, interfaces_json, evidence_refs_json, obligations_json
FROM coordination_contracts WHERE task_id = ? AND task_revision_id = ?`,
			)
			.get<{
				id: string;
				run_id: string;
				task_id: string;
				task_revision_id: string;
				version: number;
				state: CoordinationContract["state"];
				obligations_json: string;
				provides_json: string;
				requires_json: string;
				assumptions_json: string;
				owned_scope_json: string;
				interfaces_json: string;
				evidence_refs_json: string;
			}>(taskId, task.revisionId);
		if (!row) return null;
		return {
			id: row.id,
			runId: row.run_id,
			taskId: row.task_id,
			taskRevisionId: row.task_revision_id,
			version: row.version,
			state: row.state,
			obligations: parseObligations(JSON.parse(row.obligations_json)),
			provides: parseStringArray(row.provides_json, "coordination provides"),
			requires: parseStringArray(row.requires_json, "coordination requires"),
			assumptions: parseStringArray(row.assumptions_json, "coordination assumptions"),
			ownedScope: parseStringArray(row.owned_scope_json, "coordination owned scope"),
			interfaces: parseStringArray(row.interfaces_json, "coordination interfaces"),
			evidenceRefs: parseStringArray(row.evidence_refs_json, "coordination evidence refs"),
		};
	}

	listOpenDecisionRequests(runId: string): DecisionRequestRecord[] {
		return this.db
			.prepare(
				`SELECT id, run_id, task_id, expected_run_version, kind, question, options_json, recommended_option,
evidence_refs_json, source_kind, source_id, state, created_at, decided_at
FROM decision_requests WHERE run_id = ? AND state = 'OPEN' ORDER BY created_at`,
			)
			.all<{
				id: string;
				run_id: string;
				task_id: string | null;
				expected_run_version: number;
				kind: DecisionRequestRecord["kind"];
				question: string;
				options_json: string;
				recommended_option: string | null;
				evidence_refs_json: string;
				source_kind: string | null;
				source_id: string | null;
				state: DecisionRequestRecord["state"];
				created_at: string;
				decided_at: string | null;
			}>(runId)
			.map((row) => ({
				id: row.id,
				runId: row.run_id,
				taskId: row.task_id,
				expectedRunVersion: row.expected_run_version,
				kind: row.kind,
				question: row.question,
				options: parseStringArray(row.options_json, "decision options"),
				recommendedOption: row.recommended_option,
				evidenceRefs: parseStringArray(row.evidence_refs_json, "decision evidence refs"),
				sourceKind: row.source_kind,
				sourceId: row.source_id,
				state: row.state,
				createdAt: row.created_at,
				decidedAt: row.decided_at,
			}));
	}

	getDecisionRequest(requestId: string): DecisionRequestRecord {
		const row = this.db
			.prepare(
				`SELECT id, run_id, task_id, expected_run_version, kind, question, options_json, recommended_option,
evidence_refs_json, source_kind, source_id, state, created_at, decided_at
FROM decision_requests WHERE id = ?`,
			)
			.get<{
				id: string;
				run_id: string;
				task_id: string | null;
				expected_run_version: number;
				kind: DecisionRequestRecord["kind"];
				question: string;
				options_json: string;
				recommended_option: string | null;
				evidence_refs_json: string;
				source_kind: string | null;
				source_id: string | null;
				state: DecisionRequestRecord["state"];
				created_at: string;
				decided_at: string | null;
			}>(requestId);
		if (!row) throw new Error("Decision request not found: " + requestId);
		return {
			id: row.id,
			runId: row.run_id,
			taskId: row.task_id,
			expectedRunVersion: row.expected_run_version,
			kind: row.kind,
			question: row.question,
			options: parseStringArray(row.options_json, "decision options"),
			recommendedOption: row.recommended_option,
			evidenceRefs: parseStringArray(row.evidence_refs_json, "decision evidence refs"),
			sourceKind: row.source_kind,
			sourceId: row.source_id,
			state: row.state,
			createdAt: row.created_at,
			decidedAt: row.decided_at,
		};
	}

	latestFailureDiagnosis(taskId: string): FailureDiagnosisRecord | null {
		const row = this.db
			.prepare(
				`SELECT id, run_id, task_id, attempt_id, phase, classification, fingerprint, occurrence,
disposition, detail, evidence_refs_json, created_at
FROM failure_diagnoses WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
			)
			.get<{
				id: string;
				run_id: string;
				task_id: string | null;
				attempt_id: string | null;
				phase: string;
				classification: string;
				fingerprint: string;
				occurrence: number;
				disposition: FailureDisposition;
				detail: string;
				evidence_refs_json: string;
				created_at: string;
			}>(taskId);
		return row
			? {
					id: row.id,
					runId: row.run_id,
					taskId: row.task_id,
					attemptId: row.attempt_id,
					phase: row.phase,
					classification: row.classification,
					fingerprint: row.fingerprint,
					occurrence: row.occurrence,
					disposition: row.disposition,
					detail: row.detail,
					evidenceRefs: parseStringArray(row.evidence_refs_json, "failure evidence refs"),
					createdAt: row.created_at,
				}
			: null;
	}

	countFailureFingerprint(runId: string, fingerprint: string, taskId?: string): number {
		return (
			this.db
				.prepare(
					"SELECT COUNT(*) AS count FROM failure_diagnoses WHERE run_id = ? AND fingerprint = ? AND task_id IS ?",
				)
				.get<{ count: number }>(runId, fingerprint, taskId ?? null)?.count ?? 0
		);
	}

	listExplorations(taskId: string, baselineCommit?: string): ExplorationRecord[] {
		const filter = baselineCommit ? " AND baseline_commit = ?" : "";
		return this.db
			.prepare(
				`SELECT id, run_id, task_id, task_revision_id, baseline_commit, investigation_key,
hypothesis, question, state, attempt_id, report
FROM exploration_records WHERE task_id = ?${filter} ORDER BY created_at`,
			)
			.all<{
				id: string;
				run_id: string;
				task_id: string;
				task_revision_id: string;
				baseline_commit: string;
				investigation_key: string;
				hypothesis: string;
				question: string;
				state: ExplorationRecord["state"];
				attempt_id: string | null;
				report: string | null;
			}>(taskId, ...(baselineCommit ? [baselineCommit] : []))
			.map((row) => ({
				id: row.id,
				runId: row.run_id,
				taskId: row.task_id,
				taskRevisionId: row.task_revision_id,
				baselineCommit: row.baseline_commit,
				investigationKey: row.investigation_key,
				hypothesis: row.hypothesis,
				question: row.question,
				state: row.state,
				attemptId: row.attempt_id,
				report: row.report,
			}));
	}

	listDependencies(runId: string): Array<{ taskId: string; dependsOnTaskId: string }> {
		return this.db
			.prepare(
				"SELECT d.task_id AS taskId,d.depends_on_task_id AS dependsOnTaskId FROM dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.run_id=?",
			)
			.all(runId);
	}

	planningUsage(runId: string): { tokens: number; toolCalls: number; durationMs: number } {
		return this.db
			.prepare(`SELECT
 COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)),0) AS tokens,
 COALESCE(SUM(tool_calls),0) AS toolCalls,COALESCE(SUM(duration_ms),0) AS durationMs
 FROM usage_records WHERE run_id=? AND kind='AGENT' AND phase LIKE 'PLAN%'`)
			.get<{ tokens: number; toolCalls: number; durationMs: number }>(runId) as {
			tokens: number;
			toolCalls: number;
			durationMs: number;
		};
	}

	performanceHistory(runId: string): TaskPerformance[] {
		return this.db
			.prepare(`WITH writers AS (
 SELECT u.task_id,u.attempt_id,SUM(u.duration_ms) AS duration_ms,SUM(u.cost_usd) AS cost_usd
 FROM usage_records u JOIN attempts a ON a.id=u.attempt_id
 WHERE u.run_id=? AND u.kind='AGENT' AND u.phase IN ('IMPLEMENT','IMPLEMENT_RESUME')
 AND a.workflow_function='IMPLEMENT' AND a.state IN ('SUBMITTED','FAILED')
 GROUP BY u.task_id,u.attempt_id
), samples AS (
 SELECT task_id,AVG(duration_ms) AS duration_ms,AVG(cost_usd) AS cost_usd,COUNT(*) AS count
 FROM writers GROUP BY task_id
)
SELECT t.id AS taskId,COALESCE(s.duration_ms,0) AS durationMs,COALESCE(s.cost_usd,0) AS costUsd,
 COALESCE(s.count,0) AS writerSamples,
 COALESCE((SELECT SUM(duration_ms) FROM usage_records u WHERE u.task_id=t.id AND u.kind='CHECK'),0)/MAX(1,COALESCE(s.count,0)) AS checksMs,
 COALESCE((SELECT SUM(duration_ms) FROM usage_records u WHERE u.task_id=t.id AND u.kind='AGENT' AND u.phase NOT IN ('IMPLEMENT','IMPLEMENT_RESUME')),0)/MAX(1,COALESCE(s.count,0)) AS auxiliaryMs,
 COALESCE((SELECT SUM(cost_usd) FROM usage_records u WHERE u.task_id=t.id AND u.kind='AGENT' AND u.phase NOT IN ('IMPLEMENT','IMPLEMENT_RESUME')),0)/MAX(1,COALESCE(s.count,0)) AS auxiliaryCostUsd,
 COALESCE((SELECT AVG(duration_ms) FROM usage_records u WHERE u.task_id=t.id AND u.kind='AGENT' AND u.phase IN ('DIVERSE_EXPLORATION','REPLAN')),0) AS explorationMs,
 COALESCE((SELECT AVG(cost_usd) FROM usage_records u WHERE u.task_id=t.id AND u.kind='AGENT' AND u.phase IN ('DIVERSE_EXPLORATION','REPLAN')),0) AS explorationCostUsd,
 (SELECT COUNT(*) FROM usage_records u WHERE u.task_id=t.id AND u.kind='AGENT' AND u.phase IN ('DIVERSE_EXPLORATION','REPLAN')) AS explorationSamples,
 (SELECT COUNT(*) FROM attempts a WHERE a.task_id=t.id AND a.workflow_function='IMPLEMENT' AND EXISTS (SELECT 1 FROM candidates c WHERE c.attempt_id=a.id AND c.state='INTEGRATED')) AS successes,
 (SELECT COUNT(*) FROM attempts a WHERE a.task_id=t.id AND a.workflow_function='IMPLEMENT' AND (a.state='FAILED' OR EXISTS (SELECT 1 FROM candidates c WHERE c.attempt_id=a.id AND c.state='REJECTED')) AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.attempt_id=a.id AND c.state='INTEGRATED')) AS failures
 FROM tasks t LEFT JOIN samples s ON s.task_id=t.id WHERE t.run_id=?`)
			.all<TaskPerformance>(runId, runId);
	}

	listContractEvidence(contractId: string): Array<{
		id: string;
		version: number;
		obligation: string;
		treeHash: string;
		commitHash: string;
		artifacts: Array<{ path: string; blobHash: string; mode?: string }>;
		checkIds: string[];
	}> {
		return this.db
			.prepare("SELECT * FROM contract_evidence WHERE contract_id=? ORDER BY created_at DESC")
			.all<{
				id: string;
				version: number;
				obligation: string;
				tree_hash: string;
				commit_hash: string;
				artifacts_json: string;
				check_ids_json: string;
			}>(contractId)
			.map((r) => ({
				id: r.id,
				version: r.version,
				obligation: r.obligation,
				treeHash: r.tree_hash,
				commitHash: r.commit_hash,
				artifacts: JSON.parse(r.artifacts_json),
				checkIds: JSON.parse(r.check_ids_json),
			}));
	}

	checkEvidence(checkIds: string[]): Array<{
		id: string;
		runId: string;
		subjectKind: string;
		subjectId: string;
		treeHash: string;
		checkKind: string;
		state: string;
		stdoutPath: string | null;
		stderrPath: string | null;
		result: unknown;
	}> {
		return checkIds.map((id) => {
			const row = this.db
				.prepare(
					"SELECT id,run_id AS runId,subject_kind AS subjectKind,subject_id AS subjectId,tree_hash AS treeHash,check_kind AS checkKind,state,stdout_path AS stdoutPath,stderr_path AS stderrPath,result_json FROM check_runs WHERE id=?",
				)
				.get<{
					id: string;
					runId: string;
					subjectKind: string;
					subjectId: string;
					treeHash: string;
					checkKind: string;
					state: string;
					stdoutPath: string | null;
					stderrPath: string | null;
					result_json: string;
				}>(id);
			if (!row) throw new Error(`Unknown check ${id}`);
			const { result_json, ...fields } = row;
			return { ...fields, result: parseJson(result_json, "check result") };
		});
	}

	usageSummary(runId: string): { costUsd: number; tokens: number; incomplete: number; durationMs: number } {
		return (
			this.db
				.prepare(
					`SELECT COALESCE(SUM(cost_usd),0) AS costUsd, COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)),0) AS tokens, COALESCE(SUM(CASE WHEN kind='AGENT' AND (cost_usd IS NULL OR COALESCE(json_extract(details_json,'$.complete'),0)=0) THEN 1 ELSE 0 END),0) AS incomplete,COALESCE(SUM(duration_ms),0) AS durationMs FROM usage_records WHERE run_id=?`,
				)
				.get<{ costUsd: number; tokens: number; incomplete: number; durationMs: number }>(runId) ?? {
				costUsd: 0,
				tokens: 0,
				incomplete: 0,
				durationMs: 0,
			}
		);
	}

	listControlActions(
		runId: string,
		kind?: string,
	): Array<{ id: string; task_id: string | null; kind: string; state: string; detail_json: string }> {
		return this.db
			.prepare(
				"SELECT id,task_id,kind,state,detail_json FROM control_actions WHERE run_id=?" +
					(kind ? " AND kind=?" : "") +
					" ORDER BY created_at",
			)
			.all(runId, ...(kind ? [kind] : []));
	}

	latestCandidate(taskId: string): {
		id: string;
		attemptId: string;
		baseCommit: string;
		commitHash: string;
		treeHash: string;
		changedPaths: string[];
		state: string;
	} | null {
		const row = this.db
			.prepare(
				`SELECT c.* FROM candidates c JOIN attempts a ON a.id=c.attempt_id JOIN tasks t ON t.id=c.task_id JOIN task_revisions r ON r.id=t.current_revision_id WHERE c.task_id=? AND a.created_at >= r.created_at ORDER BY a.epoch DESC LIMIT 1`,
			)
			.get<{
				id: string;
				attempt_id: string;
				base_commit: string;
				commit_hash: string;
				tree_hash: string;
				changed_paths_json: string;
				state: string;
			}>(taskId);
		return row
			? {
					id: row.id,
					attemptId: row.attempt_id,
					baseCommit: row.base_commit,
					commitHash: row.commit_hash,
					treeHash: row.tree_hash,
					changedPaths: JSON.parse(row.changed_paths_json),
					state: row.state,
				}
			: null;
	}

	listTasks(runId: string, states?: TaskState[]): TaskDefinition[] {
		const stateFilter = states && states.length > 0 ? ` AND t.state IN (${states.map(() => "?").join(",")})` : "";
		return this.db
			.prepare(TASK_DEFINITION_SELECT + " WHERE t.run_id = ?" + stateFilter + " ORDER BY t.priority DESC, t.created_at")
			.all<TaskDefinitionRow>(runId, ...(states ?? []))
			.map(taskDefinition);
	}

	listUnblockedProposed(runId: string): TaskDefinition[] {
		const sql = `${TASK_DEFINITION_SELECT}
WHERE t.run_id = ? AND t.state = 'PROPOSED'
  AND NOT EXISTS (
    SELECT 1 FROM dependencies d
    JOIN tasks upstream ON upstream.id = d.depends_on_task_id
    WHERE d.task_id = t.id AND upstream.state <> 'ACCEPTED'
  )
ORDER BY t.priority DESC, t.created_at`;
		return this.db.prepare(sql).all<TaskDefinitionRow>(runId).map(taskDefinition);
	}

	listRunnableReady(runId: string): TaskDefinition[] {
		const sql = `${TASK_DEFINITION_SELECT}
WHERE t.run_id = ? AND t.state = 'READY'
  AND NOT EXISTS (
    SELECT 1 FROM dependencies d
    JOIN tasks upstream ON upstream.id = d.depends_on_task_id
    WHERE d.task_id = t.id AND upstream.state <> 'ACCEPTED'
  )
ORDER BY t.priority DESC, t.created_at`;
		return this.db.prepare(sql).all<TaskDefinitionRow>(runId).map(taskDefinition);
	}

	countAttempts(taskId: string): number {
		return (
			this.db
				.prepare("SELECT COUNT(*) AS count FROM attempts WHERE task_id = ? AND workflow_function = 'IMPLEMENT'")
				.get<{ count: number }>(taskId)?.count ?? 0
		);
	}

	getAttempt(attemptId: string): AttemptDefinition {
		const row = this.db
			.prepare(
				`SELECT a.id, a.run_id, a.task_id, a.workflow_function, a.epoch, a.state, a.base_commit,
        a.profile_name, a.profile_version, s.pi_session_id, s.context_manifest_hash,
        a.terminal_reason, a.predecessor_attempt_id, a.created_at
FROM attempts a
LEFT JOIN session_bindings s ON s.attempt_id = a.id
WHERE a.id = ?
ORDER BY s.created_at DESC
LIMIT 1`,
			)
			.get<AttemptDefinitionRow>(attemptId);
		if (!row) throw new Error("Attempt not found: " + attemptId);
		return attemptDefinition(row);
	}

	listRunningAttempts(runId: string): AttemptDefinition[] {
		return this.db
			.prepare(
				`SELECT a.id, a.run_id, a.task_id, a.workflow_function, a.epoch, a.state, a.base_commit,
        a.profile_name, a.profile_version, s.pi_session_id, s.context_manifest_hash,
        a.terminal_reason, a.predecessor_attempt_id, a.created_at
FROM attempts a
LEFT JOIN session_bindings s ON s.id = (
  SELECT latest.id FROM session_bindings latest
  WHERE latest.attempt_id = a.id
  ORDER BY latest.created_at DESC LIMIT 1
)
WHERE a.run_id = ? AND a.state = 'RUNNING'
ORDER BY a.created_at`,
			)
			.all<AttemptDefinitionRow>(runId)
			.map(attemptDefinition);
	}

	listMessages(input: {
		runId: string;
		recipientKind?: MessageRecord["recipientKind"];
		recipientId?: string;
		unreadOnly?: boolean;
		limit?: number;
	}): MessageRecord[] {
		if ((input.recipientKind === undefined) !== (input.recipientId === undefined)) {
			throw new Error("recipientKind and recipientId must be supplied together");
		}
		const limit = input.limit ?? 200;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Message limit must be 1..1000");
		const where = ["run_id = ?"];
		const parameters: unknown[] = [input.runId];
		if (input.recipientKind && input.recipientId) {
			where.push("recipient_kind = ?", "recipient_id = ?");
			parameters.push(input.recipientKind, input.recipientId);
		}
		if (input.unreadOnly) where.push("read_at IS NULL");
		parameters.push(limit);
		return this.db
			.prepare(
				`SELECT id, run_id, task_id, sender_kind, sender_id, recipient_kind, recipient_id, kind, body, references_json, reply_to_id, created_at, read_at FROM messages WHERE ${where.join(" AND ")} ORDER BY created_at LIMIT ?`,
			)
			.all<MessageRecordRow>(...parameters)
			.map(messageRecord);
	}

	listTaskChangeProposals(runId: string, states?: TaskChangeProposalRecord["state"][]): TaskChangeProposalRecord[] {
		const filter = states?.length ? ` AND state IN (${states.map(() => "?").join(",")})` : "";
		return this.db
			.prepare(
				"SELECT id, run_id, source_actor_kind, source_actor_id, expected_run_version, state, proposal_json, validation_json, decision_reason, decided_by_kind, decided_by_id, created_at, decided_at FROM task_change_proposals WHERE run_id = ?" +
					filter +
					" ORDER BY created_at",
			)
			.all<TaskChangeProposalRow>(runId, ...(states ?? []))
			.map((row) => ({
				id: row.id,
				runId: row.run_id,
				sourceActorKind: row.source_actor_kind,
				sourceActorId: row.source_actor_id,
				expectedRunVersion: row.expected_run_version,
				state: row.state,
				proposal: parseJson(row.proposal_json, "task change proposal"),
				validation: parseJson(row.validation_json, "task change validation"),
				decisionReason: row.decision_reason,
				decidedByKind: row.decided_by_kind,
				decidedById: row.decided_by_id,
				createdAt: row.created_at,
				decidedAt: row.decided_at,
			}));
	}

	getTaskChangeProposal(proposalId: string): TaskChangeProposalRecord {
		const row = this.db
			.prepare(
				"SELECT id, run_id, source_actor_kind, source_actor_id, expected_run_version, state, proposal_json, validation_json, decision_reason, decided_by_kind, decided_by_id, created_at, decided_at FROM task_change_proposals WHERE id = ?",
			)
			.get<TaskChangeProposalRow>(proposalId);
		if (!row) throw new Error("Task change proposal not found: " + proposalId);
		return {
			id: row.id,
			runId: row.run_id,
			sourceActorKind: row.source_actor_kind,
			sourceActorId: row.source_actor_id,
			expectedRunVersion: row.expected_run_version,
			state: row.state,
			proposal: parseJson(row.proposal_json, "task change proposal"),
			validation: parseJson(row.validation_json, "task change validation"),
			decisionReason: row.decision_reason,
			decidedByKind: row.decided_by_kind,
			decidedById: row.decided_by_id,
			createdAt: row.created_at,
			decidedAt: row.decided_at,
		};
	}

	listEvents(runId: string, limit = 500): DomainEventRecord[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new Error("Event limit must be 1..5000");
		return this.db
			.prepare(
				"SELECT id, run_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_kind, actor_id, causation_id, correlation_id, payload_json, created_at FROM domain_events WHERE run_id = ? ORDER BY created_at, rowid LIMIT ?",
			)
			.all<DomainEventRow>(runId, limit)
			.map((row) => ({
				id: row.id,
				runId: row.run_id,
				aggregateType: row.aggregate_type,
				aggregateId: row.aggregate_id,
				aggregateVersion: row.aggregate_version,
				eventType: row.event_type,
				actorKind: row.actor_kind,
				actorId: row.actor_id,
				causationId: row.causation_id,
				correlationId: row.correlation_id,
				payload: parseJson(row.payload_json, "event payload"),
				createdAt: row.created_at,
			}));
	}

	listArtifacts(runId: string, limit = 500): ArtifactRecord[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new Error("Artifact limit must be 1..5000");
		return this.db
			.prepare(
				"SELECT id, run_id, kind, content_hash, size_bytes, media_type, storage_kind, storage_locator, producer_kind, producer_id, created_at FROM artifacts WHERE run_id = ? ORDER BY created_at LIMIT ?",
			)
			.all<ArtifactRow>(runId, limit)
			.map((row) => ({
				id: row.id,
				runId: row.run_id,
				kind: row.kind,
				contentHash: row.content_hash,
				sizeBytes: row.size_bytes,
				mediaType: row.media_type,
				storageKind: row.storage_kind,
				storageLocator: row.storage_locator,
				producerKind: row.producer_kind,
				producerId: row.producer_id,
				createdAt: row.created_at,
			}));
	}

	listPassedRunEvidence(
		runId: string,
		treeHash: string,
	): Array<{
		id: string;
		checkKind: string;
		evidenceClass: EvidenceClass;
	}> {
		return this.db
			.prepare(
				"SELECT id, check_kind, evidence_class FROM check_runs WHERE run_id = ? AND subject_kind = 'RUN' AND subject_id = ? AND tree_hash = ? AND state = 'PASSED' ORDER BY created_at",
			)
			.all<{ id: string; check_kind: string; evidence_class: EvidenceClass }>(runId, runId, treeHash)
			.map((row) => ({ id: row.id, checkKind: row.check_kind, evidenceClass: row.evidence_class }));
	}

	getTaskFeedback(taskId: string, limit = 3): TaskFeedbackPacket {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error("Feedback limit must be 1..10");
		const task = this.getTask(taskId);
		const attempts = this.db
			.prepare(
				`SELECT id, epoch, state, base_commit, terminal_reason, created_at
FROM attempts
WHERE task_id = ? AND workflow_function = 'IMPLEMENT'
ORDER BY epoch DESC LIMIT ?`,
			)
			.all<{
				id: string;
				epoch: number;
				state: AttemptDefinition["state"];
				base_commit: string;
				terminal_reason: string | null;
				created_at: string;
			}>(taskId, limit)
			.map((row) => ({
				id: row.id,
				epoch: row.epoch,
				state: row.state,
				baseCommit: row.base_commit,
				terminalReason: row.terminal_reason,
				createdAt: row.created_at,
			}));
		const checks = this.db
			.prepare(
				`SELECT id, subject_kind, subject_id, check_kind, state, exit_code, stdout_path, stderr_path, result_json, created_at
FROM check_runs
WHERE task_id = ? AND state IN ('PASSED', 'FAILED', 'ERROR')
ORDER BY created_at DESC LIMIT ?`,
			)
			.all<{
				id: string;
				subject_kind: "CANDIDATE" | "INTEGRATION";
				subject_id: string;
				check_kind: string;
				state: "PASSED" | "FAILED" | "ERROR";
				exit_code: number | null;
				stdout_path: string | null;
				stderr_path: string | null;
				result_json: string;
				created_at: string;
			}>(taskId, limit * 8)
			.map((row) => ({
				id: row.id,
				subjectKind: row.subject_kind,
				subjectId: row.subject_id,
				checkKind: row.check_kind,
				state: row.state,
				exitCode: row.exit_code,
				stdoutPath: row.stdout_path,
				stderrPath: row.stderr_path,
				result: parseJson(row.result_json, "check result"),
				createdAt: row.created_at,
			}));
		const reviewRows = this.db
			.prepare(
				`SELECT r.id, r.candidate_id, r.state, r.summary, r.created_at
FROM reviews r
WHERE r.task_id = ?
ORDER BY r.created_at DESC LIMIT ?`,
			)
			.all<{ id: string; candidate_id: string; state: string; summary: string; created_at: string }>(taskId, limit);
		const reviews = reviewRows.map((row) => ({
			id: row.id,
			candidateId: row.candidate_id,
			state: row.state,
			summary: row.summary,
			findings: this.db
				.prepare("SELECT severity, title, detail, state FROM findings WHERE review_id = ? ORDER BY created_at")
				.all<{ severity: string; title: string; detail: string; state: string }>(row.id)
				.map((finding) => ({ ...finding })),
			createdAt: row.created_at,
		}));
		const integrations = this.db
			.prepare(
				`SELECT id, candidate_id, expected_head, state, failure_reason, created_at
FROM integrations WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`,
			)
			.all<{
				id: string;
				candidate_id: string;
				expected_head: string;
				state: string;
				failure_reason: string | null;
				created_at: string;
			}>(taskId, limit)
			.map((row) => ({
				id: row.id,
				candidateId: row.candidate_id,
				expectedHead: row.expected_head,
				state: row.state,
				failureReason: row.failure_reason,
				createdAt: row.created_at,
			}));
		return {
			taskId,
			attempts,
			checks,
			reviews,
			integrations,
			messages: this.listMessages({ runId: task.runId, recipientKind: "TASK", recipientId: taskId, limit: 50 }),
		};
	}

	hasUnfinishedTasks(runId: string): boolean {
		const row = this.db
			.prepare("SELECT 1 AS found FROM tasks WHERE run_id = ? AND state NOT IN ('ACCEPTED', 'CANCELLED') LIMIT 1")
			.get<{ found: number }>(runId);
		return Boolean(row);
	}
}
