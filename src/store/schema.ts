export interface Migration {
	version: number;
	name: string;
	sql: string;
	foreignKeysOff?: boolean;
	alreadyAppliedSql?: string;
}

export const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: "authoritative-control-plane",
		sql: String.raw`
CREATE TABLE runs (
	id TEXT PRIMARY KEY,
	repository_root TEXT NOT NULL,
	input_commit TEXT NOT NULL,
	integration_ref TEXT NOT NULL,
	integration_head TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('OPEN', 'COMPLETED', 'BLOCKED', 'CANCELLED')),
	version INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE tasks (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	parent_task_id TEXT REFERENCES tasks(id),
	current_revision_id TEXT,
	state TEXT NOT NULL CHECK (state IN ('PROPOSED', 'READY', 'ACTIVE', 'BLOCKED', 'ACCEPTED', 'CANCELLED')),
	priority INTEGER NOT NULL DEFAULT 0,
	risk_class TEXT NOT NULL,
	required_capabilities_json TEXT NOT NULL DEFAULT '[]',
	active_attempt_id TEXT,
	attempt_epoch INTEGER NOT NULL DEFAULT 0,
	version INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE task_revisions (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	revision INTEGER NOT NULL,
	title TEXT NOT NULL,
	objective TEXT NOT NULL,
	scope_json TEXT NOT NULL,
	constraints_json TEXT NOT NULL,
	acceptance_contract_json TEXT NOT NULL,
	provenance_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	UNIQUE(task_id, revision)
) STRICT;

CREATE TABLE dependencies (
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('REQUIRES', 'CONSUMES')),
	created_at TEXT NOT NULL,
	PRIMARY KEY(task_id, depends_on_task_id, kind),
	CHECK(task_id <> depends_on_task_id)
) STRICT;

CREATE TABLE attempts (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	epoch INTEGER NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('CREATED', 'RUNNING', 'SUBMITTED', 'FAILED', 'ABORTED')),
	base_commit TEXT NOT NULL,
	profile_name TEXT NOT NULL,
	profile_version TEXT NOT NULL,
	last_heartbeat TEXT,
	terminal_reason TEXT,
	predecessor_attempt_id TEXT REFERENCES attempts(id),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE(task_id, epoch)
) STRICT;

CREATE TABLE executions (
	id TEXT PRIMARY KEY,
	attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
	state TEXT NOT NULL CHECK (state IN ('REQUESTED', 'STARTING', 'LIVE', 'EXITED', 'LOST', 'KILLED')),
	pid INTEGER,
	process_started_at TEXT,
	exit_code INTEGER,
	exit_signal TEXT,
	last_heartbeat TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE session_bindings (
	id TEXT PRIMARY KEY,
	attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
	execution_id TEXT REFERENCES executions(id) ON DELETE SET NULL,
	pi_session_id TEXT NOT NULL,
	session_file TEXT,
	context_manifest_hash TEXT NOT NULL,
	created_at TEXT NOT NULL,
	UNIQUE(attempt_id, pi_session_id)
) STRICT;

CREATE TABLE messages (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
	sender_kind TEXT NOT NULL CHECK (sender_kind IN ('USER', 'SYSTEM', 'ATTEMPT')),
	sender_id TEXT NOT NULL,
	recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('TASK', 'ATTEMPT', 'USER', 'SYSTEM')),
	recipient_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('QUESTION', 'ANSWER', 'OBSERVATION', 'HELP_REQUEST', 'PROPOSAL', 'HANDOFF')),
	body TEXT NOT NULL,
	references_json TEXT NOT NULL DEFAULT '[]',
	reply_to_id TEXT REFERENCES messages(id),
	created_at TEXT NOT NULL,
	read_at TEXT
) STRICT;

CREATE TABLE candidates (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
	attempt_epoch INTEGER NOT NULL,
	base_commit TEXT NOT NULL,
	commit_hash TEXT NOT NULL,
	tree_hash TEXT NOT NULL,
	changed_paths_json TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('SUBMITTED', 'REJECTED', 'ELIGIBLE', 'INTEGRATED', 'STALE')),
	submission_note TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE(attempt_id, commit_hash)
) STRICT;

CREATE TABLE check_runs (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
	subject_kind TEXT NOT NULL CHECK (subject_kind IN ('CANDIDATE', 'INTEGRATION', 'RUN')),
	subject_id TEXT NOT NULL,
	tree_hash TEXT NOT NULL,
	check_kind TEXT NOT NULL,
	check_version TEXT NOT NULL,
	command_json TEXT NOT NULL,
	environment_hash TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ERROR')),
	exit_code INTEGER,
	stdout_path TEXT,
	stderr_path TEXT,
	result_json TEXT NOT NULL DEFAULT '{}',
	started_at TEXT,
	finished_at TEXT,
	created_at TEXT NOT NULL
) STRICT;

CREATE TABLE reviews (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
	tree_hash TEXT NOT NULL,
	reviewer_attempt_id TEXT REFERENCES attempts(id),
	state TEXT NOT NULL CHECK (state IN ('PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'ABSTAINED')),
	summary TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE findings (
	id TEXT PRIMARY KEY,
	review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
	severity TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'BLOCKING')),
	state TEXT NOT NULL CHECK (state IN ('OPEN', 'RESOLVED', 'WAIVED', 'INVALIDATED', 'SUPERSEDED')),
	title TEXT NOT NULL,
	detail TEXT NOT NULL,
	references_json TEXT NOT NULL DEFAULT '[]',
	disposition_reason TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE integrations (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
	expected_head TEXT NOT NULL,
	result_commit TEXT,
	result_tree_hash TEXT,
	state TEXT NOT NULL CHECK (state IN ('QUEUED', 'APPLYING', 'COMMITTED', 'CONFLICTED', 'FAILED')),
	failure_reason TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE acceptance_decisions (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	candidate_id TEXT NOT NULL REFERENCES candidates(id),
	integration_id TEXT NOT NULL REFERENCES integrations(id),
	result TEXT NOT NULL CHECK (result IN ('ACCEPTED', 'REJECTED')),
	evidence_json TEXT NOT NULL,
	override_reason TEXT,
	actor_kind TEXT NOT NULL CHECK (actor_kind IN ('SYSTEM', 'USER')),
	created_at TEXT NOT NULL
) STRICT;

CREATE TABLE operations (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('CREATE_WORKTREE', 'START_WORKER', 'SEAL_CANDIDATE', 'UPDATE_INTEGRATION_REF', 'REMOVE_WORKTREE')),
	aggregate_type TEXT NOT NULL,
	aggregate_id TEXT NOT NULL,
	desired_state_json TEXT NOT NULL,
	phase TEXT NOT NULL CHECK (phase IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
	idempotency_key TEXT NOT NULL UNIQUE,
	attempts INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE domain_events (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	aggregate_type TEXT NOT NULL,
	aggregate_id TEXT NOT NULL,
	aggregate_version INTEGER NOT NULL,
	event_type TEXT NOT NULL,
	actor_kind TEXT NOT NULL CHECK (actor_kind IN ('USER', 'SYSTEM', 'ATTEMPT')),
	actor_id TEXT NOT NULL,
	causation_id TEXT,
	correlation_id TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	created_at TEXT NOT NULL
) STRICT;

CREATE INDEX tasks_run_state_idx ON tasks(run_id, state, priority DESC);
CREATE INDEX dependencies_upstream_idx ON dependencies(depends_on_task_id);
CREATE INDEX attempts_task_epoch_idx ON attempts(task_id, epoch DESC);
CREATE INDEX executions_attempt_idx ON executions(attempt_id, created_at DESC);
CREATE INDEX messages_recipient_idx ON messages(recipient_kind, recipient_id, read_at, created_at);
CREATE INDEX candidates_task_idx ON candidates(task_id, created_at DESC);
CREATE INDEX checks_subject_idx ON check_runs(subject_kind, subject_id, state);
CREATE INDEX findings_review_state_idx ON findings(review_id, state, severity);
CREATE INDEX integrations_run_state_idx ON integrations(run_id, state, created_at);
CREATE INDEX operations_phase_idx ON operations(phase, created_at);
CREATE INDEX events_aggregate_idx ON domain_events(aggregate_type, aggregate_id, aggregate_version);
CREATE INDEX events_run_idx ON domain_events(run_id, created_at);
		`,
	},
	{
		version: 2,
		name: "run-scoped-agent-roles-and-recoverable-operations",
		foreignKeysOff: true,
		alreadyAppliedSql: String.raw`
SELECT CASE WHEN
	EXISTS (SELECT 1 FROM pragma_table_info('runs') WHERE name = 'objective')
	AND EXISTS (SELECT 1 FROM pragma_table_info('attempts') WHERE name = 'run_id')
	AND EXISTS (SELECT 1 FROM pragma_table_info('attempts') WHERE name = 'purpose')
	AND EXISTS (SELECT 1 FROM pragma_table_info('operations') WHERE name = 'observed_state_json')
	AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_graph_proposals')
THEN 1 ELSE 0 END AS applied`,
		sql: String.raw`
ALTER TABLE runs ADD COLUMN objective TEXT NOT NULL DEFAULT '';

CREATE TABLE attempts_v2 (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
	purpose TEXT NOT NULL CHECK (purpose IN ('PLANNER', 'IMPLEMENTER', 'REVIEWER')),
	epoch INTEGER,
	state TEXT NOT NULL CHECK (state IN ('CREATED', 'RUNNING', 'SUBMITTED', 'FAILED', 'ABORTED')),
	base_commit TEXT NOT NULL,
	profile_name TEXT NOT NULL,
	profile_version TEXT NOT NULL,
	last_heartbeat TEXT,
	terminal_reason TEXT,
	predecessor_attempt_id TEXT REFERENCES attempts_v2(id),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE(task_id, epoch),
	CHECK(
		(purpose = 'IMPLEMENTER' AND task_id IS NOT NULL AND epoch IS NOT NULL)
		OR (purpose = 'PLANNER' AND task_id IS NULL AND epoch IS NULL)
		OR (purpose = 'REVIEWER' AND task_id IS NOT NULL AND epoch IS NULL)
	)
) STRICT;

INSERT INTO attempts_v2 (
	id, run_id, task_id, purpose, epoch, state, base_commit, profile_name, profile_version,
	last_heartbeat, terminal_reason, predecessor_attempt_id, created_at, updated_at
)
SELECT
	a.id, t.run_id, a.task_id, 'IMPLEMENTER', a.epoch, a.state, a.base_commit, a.profile_name,
	a.profile_version, a.last_heartbeat, a.terminal_reason, a.predecessor_attempt_id, a.created_at, a.updated_at
FROM attempts a
JOIN tasks t ON t.id = a.task_id;

DROP TABLE attempts;
ALTER TABLE attempts_v2 RENAME TO attempts;

CREATE TABLE task_graph_proposals (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	source_attempt_id TEXT NOT NULL REFERENCES attempts(id),
	state TEXT NOT NULL CHECK (state IN ('PROPOSED', 'ACCEPTED', 'REJECTED')),
	proposal_json TEXT NOT NULL,
	validation_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	decided_at TEXT
) STRICT;

CREATE TABLE operations_v2 (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('CREATE_WORKTREE', 'START_WORKER', 'SEAL_CANDIDATE', 'RUN_CHECK', 'RUN_REVIEW', 'UPDATE_INTEGRATION_REF', 'REMOVE_WORKTREE')),
	aggregate_type TEXT NOT NULL,
	aggregate_id TEXT NOT NULL,
	desired_state_json TEXT NOT NULL,
	observed_state_json TEXT,
	phase TEXT NOT NULL CHECK (phase IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
	idempotency_key TEXT NOT NULL UNIQUE,
	attempts INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;

INSERT INTO operations_v2 (
	id, kind, aggregate_type, aggregate_id, desired_state_json, observed_state_json,
	phase, idempotency_key, attempts, last_error, created_at, updated_at
)
SELECT
	id, kind, aggregate_type, aggregate_id, desired_state_json, NULL,
	phase, idempotency_key, attempts, last_error, created_at, updated_at
FROM operations;

DROP TABLE operations;
ALTER TABLE operations_v2 RENAME TO operations;

CREATE INDEX task_graph_proposals_run_idx ON task_graph_proposals(run_id, created_at);
CREATE INDEX attempts_task_epoch_idx ON attempts(task_id, epoch DESC);
CREATE INDEX attempts_run_purpose_idx ON attempts(run_id, purpose, state, created_at);
CREATE INDEX operations_phase_idx ON operations(phase, created_at);
		`,
	},
	{
		version: 3,
		name: "separate-workflow-function-from-agent-profile",
		foreignKeysOff: true,
		sql: String.raw`
CREATE TABLE attempts_v3 (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
	workflow_function TEXT NOT NULL CHECK (workflow_function IN ('PLAN', 'EXPLORE', 'IMPLEMENT', 'REVIEW')),
	epoch INTEGER,
	state TEXT NOT NULL CHECK (state IN ('CREATED', 'RUNNING', 'SUBMITTED', 'FAILED', 'ABORTED')),
	base_commit TEXT NOT NULL,
	profile_name TEXT NOT NULL,
	profile_version TEXT NOT NULL,
	last_heartbeat TEXT,
	terminal_reason TEXT,
	predecessor_attempt_id TEXT REFERENCES attempts_v3(id),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE(task_id, epoch),
	CHECK(
		(workflow_function = 'IMPLEMENT' AND task_id IS NOT NULL AND epoch IS NOT NULL)
		OR (workflow_function = 'PLAN' AND task_id IS NULL AND epoch IS NULL)
		OR (workflow_function = 'EXPLORE' AND epoch IS NULL)
		OR (workflow_function = 'REVIEW' AND task_id IS NOT NULL AND epoch IS NULL)
	)
) STRICT;

INSERT INTO attempts_v3 (
	id, run_id, task_id, workflow_function, epoch, state, base_commit, profile_name, profile_version,
	last_heartbeat, terminal_reason, predecessor_attempt_id, created_at, updated_at
)
SELECT
	id, run_id, task_id,
	CASE purpose WHEN 'PLANNER' THEN 'PLAN' WHEN 'IMPLEMENTER' THEN 'IMPLEMENT' ELSE 'REVIEW' END,
	epoch, state, base_commit, profile_name, profile_version, last_heartbeat, terminal_reason,
	predecessor_attempt_id, created_at, updated_at
FROM attempts;

DROP TABLE attempts;
ALTER TABLE attempts_v3 RENAME TO attempts;

CREATE INDEX attempts_task_epoch_idx ON attempts(task_id, epoch DESC);
CREATE INDEX attempts_run_function_idx ON attempts(run_id, workflow_function, state, created_at);
		`,
	},
	{
		version: 4,
		name: "authoritative-task-change-proposals",
		sql: String.raw`
CREATE TABLE task_change_proposals (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	source_actor_kind TEXT NOT NULL CHECK (source_actor_kind IN ('USER', 'SYSTEM', 'ATTEMPT')),
	source_actor_id TEXT NOT NULL,
	source_attempt_id TEXT REFERENCES attempts(id),
	expected_run_version INTEGER NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('PROPOSED', 'ACCEPTED', 'REJECTED')),
	proposal_json TEXT NOT NULL,
	validation_json TEXT NOT NULL,
	decision_reason TEXT,
	decided_by_kind TEXT CHECK (decided_by_kind IN ('USER', 'SYSTEM')),
	decided_by_id TEXT,
	created_at TEXT NOT NULL,
	decided_at TEXT,
	CHECK(
		(source_actor_kind = 'ATTEMPT' AND source_attempt_id = source_actor_id)
		OR (source_actor_kind <> 'ATTEMPT' AND source_attempt_id IS NULL)
	),
	CHECK(
		(state = 'PROPOSED' AND decided_at IS NULL AND decided_by_kind IS NULL AND decided_by_id IS NULL)
		OR (state <> 'PROPOSED' AND decided_at IS NOT NULL AND decided_by_kind IS NOT NULL AND decided_by_id IS NOT NULL)
	)
) STRICT;

CREATE INDEX task_change_proposals_run_state_idx ON task_change_proposals(run_id, state, created_at);
		`,
	},
	{
		version: 5,
		name: "content-addressed-artifacts",
		sql: String.raw`
CREATE TABLE artifacts (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
	media_type TEXT NOT NULL,
	storage_kind TEXT NOT NULL CHECK (storage_kind IN ('LOCAL_FILE', 'GIT_OBJECT')),
	storage_locator TEXT NOT NULL,
	producer_kind TEXT NOT NULL,
	producer_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	UNIQUE(kind, content_hash, producer_kind, producer_id)
) STRICT;

CREATE INDEX artifacts_run_kind_idx ON artifacts(run_id, kind, created_at);
CREATE INDEX artifacts_producer_idx ON artifacts(producer_kind, producer_id);
		`,
	},
	{
		version: 6,
		name: "pinned-goal-contract-and-terminal-reports",
		sql: String.raw`
ALTER TABLE runs ADD COLUMN goal_contract_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE runs ADD COLUMN terminal_reason TEXT;

CREATE TABLE run_reports (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	run_version INTEGER NOT NULL,
	result TEXT NOT NULL CHECK (result IN ('DELIVERABLE', 'BLOCKED', 'CANCELLED')),
	final_commit TEXT NOT NULL,
	final_tree_hash TEXT NOT NULL,
	delivery_ref TEXT,
	manifest_path TEXT NOT NULL,
	summary_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	UNIQUE(run_id, run_version),
	CHECK((result = 'DELIVERABLE' AND delivery_ref IS NOT NULL) OR result <> 'DELIVERABLE')
) STRICT;

CREATE INDEX run_reports_run_idx ON run_reports(run_id, run_version DESC);
		`,
	},
	{
		version: 7,
		name: "adaptive-coordination-and-verified-autonomy",
		foreignKeysOff: true,
		alreadyAppliedSql: String.raw`
SELECT CASE WHEN
	EXISTS (SELECT 1 FROM pragma_table_info('check_runs') WHERE name = 'evidence_class')
	AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coordination_assessments')
	AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'failure_diagnoses')
	AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'decision_requests')
	AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_records')
THEN 1 ELSE 0 END AS applied`,
		sql: String.raw`
ALTER TABLE check_runs ADD COLUMN evidence_class TEXT NOT NULL DEFAULT 'STRUCTURAL'
	CHECK (evidence_class IN ('STRUCTURAL', 'BUILD', 'BEHAVIORAL', 'EXTERNAL'));

CREATE TABLE coordination_assessments (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	task_revision_id TEXT NOT NULL REFERENCES task_revisions(id) ON DELETE CASCADE,
	decomposability TEXT NOT NULL CHECK (decomposability IN ('LOW', 'MEDIUM', 'HIGH')),
	sequentiality TEXT NOT NULL CHECK (sequentiality IN ('LOW', 'MEDIUM', 'HIGH')),
	semantic_coupling TEXT NOT NULL CHECK (semantic_coupling IN ('LOW', 'MEDIUM', 'HIGH')),
	integration_cost TEXT NOT NULL CHECK (integration_cost IN ('LOW', 'MEDIUM', 'HIGH')),
	uncertainty TEXT NOT NULL CHECK (uncertainty IN ('LOW', 'MEDIUM', 'HIGH')),
	rationale TEXT NOT NULL,
	evidence_refs_json TEXT NOT NULL DEFAULT '[]',
	exploration_questions_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL,
	UNIQUE(task_id, task_revision_id)
) STRICT;

CREATE TABLE coordination_contracts (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	task_revision_id TEXT NOT NULL REFERENCES task_revisions(id) ON DELETE CASCADE,
	version INTEGER NOT NULL DEFAULT 1,
	state TEXT NOT NULL CHECK (state IN ('BOUND', 'SATISFIED', 'INVALIDATED')),
	provides_json TEXT NOT NULL DEFAULT '[]',
	requires_json TEXT NOT NULL DEFAULT '[]',
	assumptions_json TEXT NOT NULL DEFAULT '[]',
	owned_scope_json TEXT NOT NULL DEFAULT '[]',
	interfaces_json TEXT NOT NULL DEFAULT '[]',
	evidence_refs_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE(task_id, task_revision_id)
) STRICT;

CREATE TABLE coordination_decisions (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	expected_run_version INTEGER NOT NULL,
	integration_head TEXT NOT NULL,
	mode TEXT NOT NULL CHECK (mode IN ('SINGLE', 'PARALLEL_TASKS', 'SERIALIZE', 'DIVERSE_EXPLORATION')),
	task_ids_json TEXT NOT NULL,
	policy_inputs_json TEXT NOT NULL,
	rationale TEXT NOT NULL,
	created_at TEXT NOT NULL
) STRICT;

CREATE TABLE failure_diagnoses (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
	attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
	phase TEXT NOT NULL,
	classification TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	occurrence INTEGER NOT NULL CHECK (occurrence > 0),
	disposition TEXT NOT NULL CHECK (disposition IN ('RETRY', 'REPLAN', 'DELEGATE', 'DIVERSE_EXPLORE', 'REBASE_REVERIFY', 'INFRA_RETRY', 'ESCALATE', 'BLOCK')),
	detail TEXT NOT NULL,
	evidence_refs_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL
) STRICT;

CREATE TABLE decision_requests (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
	expected_run_version INTEGER NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('REQUIREMENT_CHOICE', 'AUTHORITY_EXPANSION', 'ACCEPTANCE_CHANGE', 'IRREVERSIBLE_ACTION', 'BUDGET_EXTENSION', 'SEMANTIC_CONTRACT')),
	question TEXT NOT NULL,
	options_json TEXT NOT NULL,
	recommended_option TEXT,
	evidence_refs_json TEXT NOT NULL DEFAULT '[]',
	source_kind TEXT,
	source_id TEXT,
	state TEXT NOT NULL CHECK (state IN ('OPEN', 'DECIDED', 'CANCELLED', 'STALE')),
	created_at TEXT NOT NULL,
	decided_at TEXT,
	UNIQUE(run_id, source_kind, source_id)
) STRICT;

CREATE TABLE decisions (
	id TEXT PRIMARY KEY,
	request_id TEXT NOT NULL UNIQUE REFERENCES decision_requests(id) ON DELETE CASCADE,
	selected_option TEXT NOT NULL,
	rationale TEXT NOT NULL,
	actor_kind TEXT NOT NULL CHECK (actor_kind IN ('USER', 'SYSTEM')),
	actor_id TEXT NOT NULL,
	created_at TEXT NOT NULL
) STRICT;

CREATE TABLE exploration_records (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	task_revision_id TEXT NOT NULL REFERENCES task_revisions(id) ON DELETE CASCADE,
	baseline_commit TEXT NOT NULL,
	investigation_key TEXT NOT NULL,
	hypothesis TEXT NOT NULL,
	question TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('RUNNING', 'COMPLETED', 'FAILED')),
	attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
	report TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE(task_revision_id, baseline_commit, investigation_key, hypothesis)
) STRICT;

CREATE TABLE usage_records (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
	attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
	kind TEXT NOT NULL CHECK (kind IN ('AGENT', 'CHECK', 'REVIEW', 'INTEGRATION', 'COORDINATION', 'HUMAN_WAIT')),
	phase TEXT NOT NULL,
	started_at TEXT NOT NULL,
	finished_at TEXT NOT NULL,
	duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
	input_tokens INTEGER,
	output_tokens INTEGER,
	cache_read_tokens INTEGER,
	cache_write_tokens INTEGER,
	cost_usd REAL,
	tool_calls INTEGER,
	details_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE run_reports_v7 (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	run_version INTEGER NOT NULL,
	result TEXT NOT NULL CHECK (result IN ('VERIFIED_DELIVERY', 'STRUCTURAL_HANDOFF', 'BLOCKED', 'CANCELLED')),
	final_commit TEXT NOT NULL,
	final_tree_hash TEXT NOT NULL,
	delivery_ref TEXT,
	manifest_path TEXT NOT NULL,
	summary_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	UNIQUE(run_id, run_version),
	CHECK((result IN ('VERIFIED_DELIVERY', 'STRUCTURAL_HANDOFF') AND delivery_ref IS NOT NULL) OR result IN ('BLOCKED', 'CANCELLED'))
) STRICT;

INSERT INTO run_reports_v7 (
	id, run_id, run_version, result, final_commit, final_tree_hash, delivery_ref, manifest_path, summary_json, created_at
)
SELECT id, run_id, run_version,
	CASE result WHEN 'DELIVERABLE' THEN 'STRUCTURAL_HANDOFF' ELSE result END,
	final_commit, final_tree_hash, delivery_ref, manifest_path, summary_json, created_at
FROM run_reports;

DROP TABLE run_reports;
ALTER TABLE run_reports_v7 RENAME TO run_reports;

CREATE INDEX run_reports_run_idx ON run_reports(run_id, run_version DESC);
CREATE INDEX coordination_assessments_run_idx ON coordination_assessments(run_id, task_id);
CREATE INDEX coordination_contracts_run_state_idx ON coordination_contracts(run_id, state, task_id);
CREATE INDEX coordination_decisions_run_idx ON coordination_decisions(run_id, created_at);
CREATE INDEX failure_diagnoses_task_idx ON failure_diagnoses(task_id, fingerprint, created_at);
CREATE INDEX decision_requests_run_state_idx ON decision_requests(run_id, state, created_at);
CREATE INDEX exploration_records_task_idx ON exploration_records(task_id, state, created_at);
CREATE INDEX usage_records_run_kind_idx ON usage_records(run_id, kind, started_at);
		`,
	},
	{
		version: 8,
		name: "evidence-bindings-and-bounded-execution",
		sql: String.raw`
ALTER TABLE runs ADD COLUMN integration_tree_hash TEXT;
ALTER TABLE task_change_proposals ADD COLUMN expected_graph_hash TEXT;
ALTER TABLE coordination_contracts ADD COLUMN obligations_json TEXT NOT NULL DEFAULT '[]';
CREATE TABLE exploration_executions AS SELECT * FROM exploration_records;
DROP TABLE exploration_records;
CREATE TABLE exploration_records (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 task_revision_id TEXT NOT NULL REFERENCES task_revisions(id), baseline_commit TEXT NOT NULL,
 investigation_key TEXT NOT NULL, hypothesis TEXT NOT NULL, question TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('RUNNING','COMPLETED','FAILED')),
 attempt_id TEXT REFERENCES attempts(id), report TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
INSERT INTO exploration_records SELECT * FROM exploration_executions;
DROP TABLE exploration_executions;
CREATE UNIQUE INDEX exploration_active_identity ON exploration_records(task_revision_id, baseline_commit, investigation_key, hypothesis) WHERE state IN ('RUNNING','COMPLETED');
CREATE TABLE compute_reservations (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), execution_id TEXT NOT NULL REFERENCES executions(id),
 cost_usd REAL NOT NULL, tokens INTEGER NOT NULL, used_cost REAL NOT NULL DEFAULT 0, used_tokens INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK(state IN ('HELD','RELEASED','INTERRUPTED')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE contract_evidence (
 id TEXT PRIMARY KEY, contract_id TEXT NOT NULL REFERENCES coordination_contracts(id),
 version INTEGER NOT NULL, obligation TEXT NOT NULL, tree_hash TEXT NOT NULL, commit_hash TEXT NOT NULL,
 artifacts_json TEXT NOT NULL, check_ids_json TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(contract_id, version, obligation, tree_hash)
) STRICT;
CREATE TABLE contract_consumptions (
 attempt_id TEXT NOT NULL REFERENCES attempts(id), contract_id TEXT NOT NULL REFERENCES coordination_contracts(id),
 version INTEGER NOT NULL, baseline_commit TEXT NOT NULL, evidence_ids_json TEXT NOT NULL,
 PRIMARY KEY(attempt_id, contract_id)
) STRICT;
CREATE TABLE control_actions (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), task_id TEXT REFERENCES tasks(id),
 kind TEXT NOT NULL, state TEXT NOT NULL, detail_json TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX reservations_run_idx ON compute_reservations(run_id,state);
CREATE INDEX contract_evidence_tree_idx ON contract_evidence(contract_id,tree_hash);
CREATE INDEX control_actions_run_idx ON control_actions(run_id,kind);
`,
	},
	{
		version: 9,
		name: "independent-specification-assurance",
		sql: String.raw`
CREATE TABLE assurance_plans (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
 task_id TEXT NOT NULL REFERENCES tasks(id), task_revision_id TEXT NOT NULL UNIQUE REFERENCES task_revisions(id),
 baseline_commit TEXT NOT NULL, plan_json TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE INDEX assurance_plans_run_idx ON assurance_plans(run_id,task_id);
CREATE TABLE assurance_evaluations (
 id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES assurance_plans(id),
 tree_hash TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('STARTED','PASSED','FAILED','ERROR')), created_at TEXT NOT NULL
) STRICT;
CREATE INDEX assurance_evaluation_subject_idx ON assurance_evaluations(plan_id,tree_hash,subject_kind,subject_id);
CREATE INDEX check_runs_assurance_idx ON check_runs(task_id,subject_kind,subject_id,tree_hash,check_kind);
`,
	},
];
