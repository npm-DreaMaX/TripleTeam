export const TASK_STATES = ["PROPOSED", "READY", "ACTIVE", "BLOCKED", "ACCEPTED", "CANCELLED"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const ATTEMPT_STATES = ["CREATED", "RUNNING", "SUBMITTED", "FAILED", "ABORTED"] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

export const CANDIDATE_STATES = ["SUBMITTED", "REJECTED", "ELIGIBLE", "INTEGRATED", "STALE"] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];

export const CHECK_STATES = ["QUEUED", "RUNNING", "PASSED", "FAILED", "ERROR"] as const;
export type CheckState = (typeof CHECK_STATES)[number];

export const REVIEW_STATES = ["PENDING", "APPROVED", "CHANGES_REQUESTED", "ABSTAINED"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const INTEGRATION_STATES = ["QUEUED", "APPLYING", "COMMITTED", "CONFLICTED", "FAILED"] as const;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];

export const RUN_STATES = ["OPEN", "COMPLETED", "BLOCKED", "CANCELLED"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const EXECUTION_MODES = ["SINGLE", "PARALLEL_TASKS", "SERIALIZE", "DIVERSE_EXPLORATION"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const COORDINATION_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type CoordinationLevel = (typeof COORDINATION_LEVELS)[number];

export const FAILURE_DISPOSITIONS = [
	"RETRY",
	"REPLAN",
	"DELEGATE",
	"DIVERSE_EXPLORE",
	"REBASE_REVERIFY",
	"INFRA_RETRY",
	"ESCALATE",
	"BLOCK",
] as const;
export type FailureDisposition = (typeof FAILURE_DISPOSITIONS)[number];

export const EVIDENCE_CLASSES = ["STRUCTURAL", "BUILD", "BEHAVIORAL", "EXTERNAL"] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export const DELIVERY_RESULTS = ["VERIFIED_DELIVERY", "STRUCTURAL_HANDOFF", "BLOCKED", "CANCELLED"] as const;
export type DeliveryResult = (typeof DELIVERY_RESULTS)[number];

export interface TaskSnapshot {
	id: string;
	runId: string;
	state: TaskState;
	version: number;
	attemptEpoch: number;
	activeAttemptId: string | null;
}

export interface AttemptSnapshot {
	id: string;
	taskId: string;
	epoch: number;
	state: AttemptState;
	baseCommit: string;
}

export interface CandidateIdentity {
	id: string;
	taskId: string;
	attemptId: string;
	attemptEpoch: number;
	baseCommit: string;
	commitHash: string;
	treeHash: string;
}

export class DomainInvariantError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "DomainInvariantError";
		this.code = code;
	}
}
