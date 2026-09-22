import assert from "node:assert/strict";
import test from "node:test";
import { DomainInvariantError, type TaskSnapshot } from "../../src/domain/model.ts";
import {
	assertAcceptancePreconditions,
	assertActiveAttempt,
	assertAttemptTransition,
	assertTaskTransition,
} from "../../src/domain/transitions.ts";

const task: TaskSnapshot = {
	id: "task-1",
	runId: "run-1",
	state: "ACTIVE",
	version: 3,
	attemptEpoch: 2,
	activeAttemptId: "attempt-2",
};

test("task acceptance cannot be reached from ready", () => {
	assert.throws(() => assertTaskTransition("READY", "ACCEPTED"), DomainInvariantError);
});

test("submitted attempts are terminal", () => {
	assert.throws(() => assertAttemptTransition("SUBMITTED", "RUNNING"), DomainInvariantError);
});

test("stale attempt epoch cannot submit", () => {
	assert.throws(
		() =>
			assertActiveAttempt(
				task,
				{ id: "attempt-2", taskId: "task-1", epoch: 1, state: "RUNNING", baseCommit: "base" },
				1,
			),
		(error) => error instanceof DomainInvariantError && error.code === "STALE_ATTEMPT_EPOCH",
	);
});

test("acceptance is bound to the integrated tree", () => {
	assert.throws(
		() =>
			assertAcceptancePreconditions({
				task,
				integrationCommitted: true,
				integrationTreeHash: "integration-tree",
				evidenceTreeHash: "different-tree",
				requiredChecksPassed: true,
				blockingFindings: 0,
			}),
		(error) => error instanceof DomainInvariantError && error.code === "EVIDENCE_TREE_MISMATCH",
	);
});
