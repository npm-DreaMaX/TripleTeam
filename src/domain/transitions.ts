import {
	type AttemptSnapshot,
	type AttemptState,
	type CandidateIdentity,
	DomainInvariantError,
	type TaskSnapshot,
	type TaskState,
} from "./model.ts";

const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
	PROPOSED: ["READY", "CANCELLED"],
	READY: ["ACTIVE", "BLOCKED", "CANCELLED"],
	ACTIVE: ["READY", "BLOCKED", "ACCEPTED", "CANCELLED"],
	BLOCKED: ["READY", "CANCELLED"],
	ACCEPTED: [],
	CANCELLED: [],
};

const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptState, readonly AttemptState[]>> = {
	CREATED: ["RUNNING", "ABORTED"],
	RUNNING: ["SUBMITTED", "FAILED", "ABORTED"],
	SUBMITTED: [],
	FAILED: [],
	ABORTED: [],
};

export function assertTaskTransition(from: TaskState, to: TaskState): void {
	if (!TASK_TRANSITIONS[from].includes(to)) {
		throw new DomainInvariantError("INVALID_TASK_TRANSITION", "Cannot transition task from " + from + " to " + to);
	}
}

export function assertAttemptTransition(from: AttemptState, to: AttemptState): void {
	if (!ATTEMPT_TRANSITIONS[from].includes(to)) {
		throw new DomainInvariantError(
			"INVALID_ATTEMPT_TRANSITION",
			"Cannot transition attempt from " + from + " to " + to,
		);
	}
}

export function assertActiveAttempt(task: TaskSnapshot, attempt: AttemptSnapshot, suppliedEpoch: number): void {
	if (task.activeAttemptId !== attempt.id || task.id !== attempt.taskId) {
		throw new DomainInvariantError("NOT_ACTIVE_ATTEMPT", "Attempt is not the active writer for this task");
	}
	if (task.attemptEpoch !== attempt.epoch || attempt.epoch !== suppliedEpoch) {
		throw new DomainInvariantError("STALE_ATTEMPT_EPOCH", "Attempt epoch is stale");
	}
	if (task.state !== "ACTIVE" || attempt.state !== "RUNNING") {
		throw new DomainInvariantError("ATTEMPT_NOT_RUNNING", "Only the active running attempt may submit");
	}
}

export function assertCandidateIdentity(candidate: CandidateIdentity): void {
	if (!candidate.commitHash.trim() || !candidate.treeHash.trim() || !candidate.baseCommit.trim()) {
		throw new DomainInvariantError("INVALID_CANDIDATE_IDENTITY", "Candidate Git identity must be complete");
	}
}

export function assertAcceptancePreconditions(input: {
	task: TaskSnapshot;
	integrationCommitted: boolean;
	integrationTreeHash: string;
	evidenceTreeHash: string;
	requiredChecksPassed: boolean;
	blockingFindings: number;
}): void {
	if (input.task.state !== "ACTIVE") {
		throw new DomainInvariantError("TASK_NOT_ACTIVE", "Only an active task can be accepted");
	}
	if (!input.integrationCommitted) {
		throw new DomainInvariantError("NOT_INTEGRATED", "Candidate must be committed to the integration ref");
	}
	if (input.evidenceTreeHash !== input.integrationTreeHash) {
		throw new DomainInvariantError(
			"EVIDENCE_TREE_MISMATCH",
			"Acceptance evidence does not identify the integrated tree",
		);
	}
	if (!input.requiredChecksPassed) {
		throw new DomainInvariantError("CHECKS_NOT_PASSED", "Required checks have not passed");
	}
	if (input.blockingFindings > 0) {
		throw new DomainInvariantError("BLOCKING_FINDINGS", "Blocking review findings remain open");
	}
}
