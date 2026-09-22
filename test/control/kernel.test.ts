import assert from "node:assert/strict";
import test from "node:test";
import { checkCommandVersion, evidenceClassForCheck } from "../../src/config/project.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { DomainInvariantError } from "../../src/domain/model.ts";
import { openControlDatabase } from "../../src/store/database.ts";

const user = { kind: "USER", id: "local-user" } as const;
const system = { kind: "SYSTEM", id: "control-plane" } as const;
const check = {
	name: "test",
	argv: ["npm", "test"],
	timeoutMs: 60_000,
	lane: "HEAVY_CHECK",
} as const;
const acceptanceContract = { candidateChecks: [check], integrationChecks: [check], requireReview: false };

async function fixture() {
	const database = await openControlDatabase(":memory:");
	const kernel = new ControlKernel(database);
	kernel.createRun({
		id: "run-1",
		repositoryRoot: "/repo",
		inputCommit: "base-commit",
		integrationRef: "refs/tripleteam/runs/run-1/integration",
		actor: user,
	});
	kernel.createTask({
		id: "task-1",
		revisionId: "revision-1",
		runId: "run-1",
		title: "Implement feature",
		objective: "Make the requested change",
		scope: ["src"],
		constraints: [],
		acceptanceContract,
		riskClass: "NORMAL",
		actor: user,
	});
	kernel.markTaskReady("task-1", system);
	return { database, kernel };
}

test("agent submission does not accept the task", async (context) => {
	const { database, kernel } = await fixture();
	context.after(() => database.close());

	const attempt = kernel.startAttempt({
		id: "attempt-1",
		taskId: "task-1",
		baseCommit: "base-commit",
		profileName: "implementer",
		profileVersion: "1",
		actor: system,
	});
	kernel.submitCandidate({
		id: "candidate-1",
		taskId: "task-1",
		attemptId: attempt.attemptId,
		attemptEpoch: attempt.epoch,
		baseCommit: "base-commit",
		commitHash: "candidate-commit",
		treeHash: "candidate-tree",
		changedPaths: ["src/feature.ts"],
		actor: { kind: "ATTEMPT", id: attempt.attemptId },
	});

	assert.equal(kernel.getTask("task-1").state, "ACTIVE");
});

test("stale attempt cannot submit after a newer epoch owns the task", async (context) => {
	const { database, kernel } = await fixture();
	context.after(() => database.close());

	const first = kernel.startAttempt({
		id: "attempt-1",
		taskId: "task-1",
		baseCommit: "base-commit",
		profileName: "implementer",
		profileVersion: "1",
		actor: system,
	});
	database.sql.prepare("UPDATE attempts SET state = 'FAILED' WHERE id = ?").run(first.attemptId);
	database.sql.prepare("UPDATE tasks SET state = 'READY', active_attempt_id = NULL WHERE id = ?").run("task-1");

	const second = kernel.startAttempt({
		id: "attempt-2",
		taskId: "task-1",
		baseCommit: "base-commit",
		profileName: "implementer",
		profileVersion: "1",
		actor: system,
	});
	assert.equal(second.epoch, first.epoch + 1);

	assert.throws(
		() =>
			kernel.submitCandidate({
				taskId: "task-1",
				attemptId: first.attemptId,
				attemptEpoch: first.epoch,
				baseCommit: "base-commit",
				commitHash: "stale-commit",
				treeHash: "stale-tree",
				changedPaths: [],
				actor: { kind: "ATTEMPT", id: first.attemptId },
			}),
		(error) => error instanceof DomainInvariantError && error.code === "NOT_ACTIVE_ATTEMPT",
	);
});

test("one attempt can resume its Pi session through multiple fenced executions", async (context) => {
	const { database, kernel } = await fixture();
	context.after(() => database.close());
	const attempt = kernel.startAttempt({
		id: "attempt-1",
		taskId: "task-1",
		baseCommit: "base-commit",
		profileName: "implementer",
		profileVersion: "profile-v1",
		actor: system,
	});
	const first = kernel.createExecution({
		id: "execution-1",
		attemptId: attempt.attemptId,
		piSessionId: "implement-attempt-1",
		contextManifestHash: "context-v1",
		actor: system,
	});
	kernel.markExecutionLive({ executionId: first, actor: system });
	kernel.finishExecution({ executionId: first, state: "LOST", actor: system });
	const second = kernel.createExecution({
		id: "execution-2",
		attemptId: attempt.attemptId,
		piSessionId: "implement-attempt-1",
		contextManifestHash: "context-v1",
		actor: system,
	});
	assert.equal(second, "execution-2");
	assert.equal(database.sql.prepare("SELECT COUNT(*) AS count FROM executions").get<{ count: number }>()?.count, 2);
	assert.equal(
		database.sql.prepare("SELECT COUNT(*) AS count FROM session_bindings").get<{ count: number }>()?.count,
		1,
	);
	assert.throws(
		() =>
			kernel.createExecution({
				attemptId: attempt.attemptId,
				piSessionId: "implement-attempt-1",
				contextManifestHash: "different-context",
				actor: system,
			}),
		(error) => error instanceof DomainInvariantError && error.code === "CONTEXT_MANIFEST_MISMATCH",
	);
	assert.equal(kernel.getTask("task-1").state, "ACTIVE");
});

test("task acceptance requires post-integration evidence", async (context) => {
	const { database, kernel } = await fixture();
	context.after(() => database.close());

	const attempt = kernel.startAttempt({
		id: "attempt-1",
		taskId: "task-1",
		baseCommit: "base-commit",
		profileName: "implementer",
		profileVersion: "1",
		actor: system,
	});
	const candidateId = kernel.submitCandidate({
		id: "candidate-1",
		taskId: "task-1",
		attemptId: attempt.attemptId,
		attemptEpoch: attempt.epoch,
		baseCommit: "base-commit",
		commitHash: "candidate-commit",
		treeHash: "candidate-tree",
		changedPaths: ["src/feature.ts"],
		actor: { kind: "ATTEMPT", id: attempt.attemptId },
	});
	kernel.recordCheckResult({
		id: "check-candidate",
		runId: "run-1",
		taskId: "task-1",
		subjectKind: "CANDIDATE",
		subjectId: candidateId,
		treeHash: "candidate-tree",
		checkKind: "test",
		checkVersion: checkCommandVersion(check),
		evidenceClass: evidenceClassForCheck(check),
		command: ["npm", "test"],
		environmentHash: "env",
		state: "PASSED",
		exitCode: 0,
		actor: system,
	});
	kernel.markCandidateEligible(candidateId, system);
	const integrationId = kernel.queueIntegration({
		id: "integration-1",
		candidateId,
		expectedHead: "base-commit",
		actor: system,
	});
	kernel.commitIntegration({
		integrationId,
		resultCommit: "integrated-commit",
		resultTreeHash: "integrated-tree",
		actor: system,
	});

	assert.throws(
		() =>
			kernel.acceptTask({
				taskId: "task-1",
				integrationId,
				actor: system,
			}),
		(error) => error instanceof DomainInvariantError && error.code === "INVALID_CHECK_EVIDENCE",
	);

	kernel.recordCheckResult({
		id: "check-integration",
		runId: "run-1",
		taskId: "task-1",
		subjectKind: "INTEGRATION",
		subjectId: integrationId,
		treeHash: "integrated-tree",
		checkKind: "test",
		checkVersion: checkCommandVersion(check),
		evidenceClass: evidenceClassForCheck(check),
		command: ["npm", "test"],
		environmentHash: "env",
		state: "PASSED",
		exitCode: 0,
		actor: system,
	});
	kernel.acceptTask({
		id: "decision-1",
		taskId: "task-1",
		integrationId,
		actor: system,
	});
	assert.equal(kernel.getTask("task-1").state, "ACCEPTED");
	assert.throws(
		() => kernel.completeRun({ runId: "run-1", treeHash: "integrated-tree" }, system),
		(error) => error instanceof DomainInvariantError && error.code === "MISSING_CHECKS",
	);
	kernel.recordCheckResult({
		id: "check-run",
		runId: "run-1",
		subjectKind: "RUN",
		subjectId: "run-1",
		treeHash: "integrated-tree",
		checkKind: "global-test",
		checkVersion: "1",
		command: ["npm", "test"],
		environmentHash: "env",
		state: "PASSED",
		exitCode: 0,
		actor: system,
	});
	kernel.completeRun({ runId: "run-1", treeHash: "integrated-tree" }, system);
	assert.equal(
		database.sql.prepare("SELECT state FROM runs WHERE id = 'run-1'").get<{ state: string }>()?.state,
		"COMPLETED",
	);
});

test("typed messages are durable but cannot mutate task truth", async (context) => {
	const { database, kernel } = await fixture();
	context.after(() => database.close());
	const attempt = kernel.startAttempt({
		id: "attempt-1",
		taskId: "task-1",
		baseCommit: "base-commit",
		profileName: "implementer",
		profileVersion: "1",
		actor: system,
	});
	const messageId = kernel.sendMessage({
		id: "message-1",
		runId: "run-1",
		taskId: "task-1",
		recipientKind: "TASK",
		recipientId: "task-1",
		kind: "OBSERVATION",
		body: "Implementation appears complete, but this is only an observation.",
		references: [{ kind: "ATTEMPT", id: attempt.attemptId }],
		actor: { kind: "ATTEMPT", id: attempt.attemptId },
	});
	assert.equal(messageId, "message-1");
	assert.equal(kernel.getTask("task-1").state, "ACTIVE");
	kernel.markMessageRead({
		messageId,
		recipientKind: "TASK",
		recipientId: "task-1",
		actor: { kind: "ATTEMPT", id: attempt.attemptId },
	});
	const row = database.sql
		.prepare("SELECT read_at FROM messages WHERE id = ?")
		.get<{ read_at: string | null }>(messageId);
	assert.ok(row?.read_at);
});

test("task graph changes remain proposals until an authorized decision", async (context) => {
	const { database, kernel } = await fixture();
	context.after(() => database.close());
	const proposalId = kernel.proposeTaskChanges({
		id: "proposal-1",
		runId: "run-1",
		changes: {
			additions: [],
			revisions: [],
			dependencies: [],
			cancellations: [{ taskId: "task-1", expectedVersion: 2, reason: "Requirement was withdrawn" }],
		},
		actor: user,
	});
	assert.equal(kernel.getTask("task-1").state, "READY");
	assert.equal(
		database.sql.prepare("SELECT state FROM task_change_proposals WHERE id = ?").get<{ state: string }>(proposalId)
			?.state,
		"PROPOSED",
	);
	kernel.acceptTaskChanges(proposalId, system);
	assert.equal(kernel.getTask("task-1").state, "CANCELLED");
	assert.equal(
		database.sql.prepare("SELECT state FROM task_change_proposals WHERE id = ?").get<{ state: string }>(proposalId)
			?.state,
		"ACCEPTED",
	);
});

test("task proposals reject unusable acceptance contracts before persistence", async (context) => {
	const { database, kernel } = await fixture();
	context.after(() => database.close());
	assert.throws(
		() =>
			kernel.proposeTaskChanges({
				runId: "run-1",
				changes: {
					additions: [
						{
							key: "unverifiable",
							title: "Unverifiable task",
							objective: "Must not enter the graph",
							scope: [],
							constraints: [],
							acceptanceContract: { candidateChecks: [], integrationChecks: [], requireReview: false },
							riskClass: "LOW",
							priority: 0,
						},
					],
					revisions: [],
					dependencies: [],
					cancellations: [],
				},
				actor: user,
			}),
		(error) => error instanceof DomainInvariantError && error.code === "INVALID_ACCEPTANCE_CONTRACT",
	);
	assert.equal(
		database.sql.prepare("SELECT COUNT(*) AS count FROM task_change_proposals").get<{ count: number }>()?.count,
		0,
	);
});

test("accepted task additions preserve scheduler capabilities", async (context) => {
	const { database, kernel } = await fixture();
	context.after(() => database.close());
	const proposalId = kernel.proposeTaskChanges({
		runId: "run-1",
		changes: {
			additions: [
				{
					key: "specialized",
					title: "Specialized task",
					objective: "Exercise capability-aware scheduling",
					scope: ["src"],
					constraints: [],
					acceptanceContract,
					riskClass: "NORMAL",
					priority: 1,
					requiredCapabilities: ["typescript"],
				},
			],
			revisions: [],
			dependencies: [],
			cancellations: [],
		},
		actor: user,
	});
	const added = kernel.acceptTaskChanges(proposalId, system);
	const row = database.sql
		.prepare("SELECT required_capabilities_json FROM tasks WHERE id = ?")
		.get<{ required_capabilities_json: string }>(added.get("specialized"));
	assert.deepEqual(JSON.parse(row?.required_capabilities_json ?? "[]"), ["typescript"]);
});

test("cyclic task changes fail atomically without mutating the graph", async (context) => {
	const { database, kernel } = await fixture();
	context.after(() => database.close());
	const addedTask = (key: string) => ({
		key,
		title: "Task " + key,
		objective: "Implement " + key,
		scope: ["src"],
		constraints: [],
		acceptanceContract,
		riskClass: "NORMAL",
		priority: 0,
	});
	const proposalId = kernel.proposeTaskChanges({
		id: "cyclic-proposal",
		runId: "run-1",
		changes: {
			additions: [addedTask("a"), addedTask("b")],
			revisions: [],
			dependencies: [
				{ task: { newTaskKey: "a" }, dependsOn: { newTaskKey: "b" }, kind: "REQUIRES" },
				{ task: { newTaskKey: "b" }, dependsOn: { newTaskKey: "a" }, kind: "REQUIRES" },
			],
			cancellations: [],
		},
		actor: user,
	});

	assert.throws(
		() => kernel.acceptTaskChanges(proposalId, system),
		(error) => error instanceof DomainInvariantError && error.code === "DEPENDENCY_CYCLE",
	);
	assert.equal(database.sql.prepare("SELECT COUNT(*) AS count FROM tasks").get<{ count: number }>()?.count, 1);
	assert.equal(
		database.sql.prepare("SELECT state FROM task_change_proposals WHERE id = ?").get<{ state: string }>(proposalId)
			?.state,
		"PROPOSED",
	);
});

test("run cancellation atomically fences live authority before process abort", async (context) => {
	const { database, kernel } = await fixture();
	context.after(() => database.close());
	const attempt = kernel.startAttempt({
		id: "attempt-cancel",
		taskId: "task-1",
		baseCommit: "base-commit",
		profileName: "implementer",
		profileVersion: "1",
		actor: system,
	});
	const executionId = kernel.createExecution({
		id: "execution-cancel",
		attemptId: attempt.attemptId,
		piSessionId: "session-cancel",
		contextManifestHash: "context",
		actor: system,
	});
	kernel.markExecutionLive({ executionId, actor: system });

	assert.deepEqual(kernel.cancelRun("run-1", "User cancelled delegated work", user), ["attempt-cancel"]);
	assert.equal(kernel.getTask("task-1").state, "CANCELLED");
	assert.equal(
		database.sql.prepare("SELECT state FROM attempts WHERE id = ?").get<{ state: string }>(attempt.attemptId)?.state,
		"ABORTED",
	);
	assert.equal(
		database.sql.prepare("SELECT state FROM executions WHERE id = ?").get<{ state: string }>(executionId)?.state,
		"KILLED",
	);
	assert.deepEqual(
		{
			...database.sql
				.prepare("SELECT state, terminal_reason FROM runs WHERE id = 'run-1'")
				.get<{ state: string; terminal_reason: string | null }>(),
		},
		{ state: "CANCELLED", terminal_reason: "User cancelled delegated work" },
	);
});

test("run cancellation fences a submitted candidate before Git publication", async (context) => {
	const { database, kernel } = await fixture();
	context.after(() => database.close());
	const attempt = kernel.startAttempt({
		id: "attempt-pipeline-cancel",
		taskId: "task-1",
		baseCommit: "base-commit",
		profileName: "implementer",
		profileVersion: "1",
		actor: system,
	});
	const candidateId = kernel.submitCandidate({
		id: "candidate-pipeline-cancel",
		taskId: "task-1",
		attemptId: attempt.attemptId,
		attemptEpoch: attempt.epoch,
		baseCommit: "base-commit",
		commitHash: "candidate-commit",
		treeHash: "candidate-tree",
		changedPaths: ["src/feature.ts"],
		actor: { kind: "ATTEMPT", id: attempt.attemptId },
	});
	kernel.recordCheckResult({
		id: "candidate-check-before-cancel",
		runId: "run-1",
		taskId: "task-1",
		subjectKind: "CANDIDATE",
		subjectId: candidateId,
		treeHash: "candidate-tree",
		checkKind: "test",
		checkVersion: checkCommandVersion(check),
		evidenceClass: evidenceClassForCheck(check),
		command: ["npm", "test"],
		environmentHash: "env",
		state: "PASSED",
		exitCode: 0,
		actor: system,
	});
	kernel.markCandidateEligible(candidateId, system);
	const integrationId = kernel.queueIntegration({
		id: "integration-pipeline-cancel",
		candidateId,
		expectedHead: "base-commit",
		actor: system,
	});
	kernel.markIntegrationApplying(integrationId, system);

	kernel.cancelRun("run-1", "Stop before publication", user);
	assert.equal(
		database.sql.prepare("SELECT state FROM candidates WHERE id = ?").get<{ state: string }>(candidateId)?.state,
		"REJECTED",
	);
	assert.deepEqual(
		{
			...database.sql
				.prepare("SELECT state, failure_reason FROM integrations WHERE id = ?")
				.get<{ state: string; failure_reason: string }>(integrationId),
		},
		{ state: "FAILED", failure_reason: "Run cancelled before Git publication" },
	);
	assert.throws(
		() => kernel.assertIntegrationPublishable(integrationId),
		(error) => error instanceof DomainInvariantError && error.code === "INTEGRATION_NOT_APPLYING",
	);
	assert.throws(
		() =>
			kernel.commitIntegration({
				integrationId,
				resultCommit: "must-not-publish",
				resultTreeHash: "must-not-publish-tree",
				actor: system,
			}),
		(error) => error instanceof DomainInvariantError && error.code === "RUN_NOT_OPEN",
	);
	assert.equal(
		database.sql.prepare("SELECT integration_head FROM runs WHERE id = 'run-1'").get<{ integration_head: string }>()
			?.integration_head,
		"base-commit",
	);
});
