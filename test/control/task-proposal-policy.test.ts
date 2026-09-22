import assert from "node:assert/strict";
import test from "node:test";
import type { CheckCommand, ProjectConfig } from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { BoundedTaskProposalPolicy } from "../../src/control/task-proposal-policy.ts";
import { openControlDatabase } from "../../src/store/database.ts";

const check: CheckCommand = { name: "test", argv: ["npm", "test"], timeoutMs: 60_000, lane: "HEAVY_CHECK" };
const contract = { candidateChecks: [check], integrationChecks: [check], requireReview: false };
const config = {
	maxAttemptsPerTask: 3,
	maxPlannerExplorations: 3,
	workerTimeoutMs: 60_000,
	candidateChecks: [check],
	integrationChecks: [check],
	runChecks: [check],
	reviewRequiredFor: ["HIGH"],
	profiles: { explorer: "explorer", planner: "planner", implementer: "implementer", reviewer: "reviewer" },
} satisfies ProjectConfig;
const system = { kind: "SYSTEM", id: "test" } as const;

async function activeTask(id: string) {
	const database = await openControlDatabase(":memory:");
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	kernel.createRun({
		id: "run-" + id,
		repositoryRoot: "/repo",
		inputCommit: "base",
		integrationRef: "refs/test/" + id,
		goalContract: {
			taskAcceptancePolicy: {
				candidateChecks: config.candidateChecks,
				integrationChecks: config.integrationChecks,
				reviewRequiredFor: config.reviewRequiredFor,
			},
		},
		actor: system,
	});
	const taskId = kernel.createTask({
		id: "task-" + id,
		runId: "run-" + id,
		title: "Implement",
		objective: "Implement the requested change",
		scope: ["src"],
		constraints: [],
		acceptanceContract: contract,
		riskClass: "LOW",
		actor: system,
	});
	kernel.markTaskReady(taskId, system);
	const attemptId = "attempt-" + id;
	kernel.startAttempt({
		id: attemptId,
		taskId,
		baseCommit: "base",
		profileName: "implementer",
		profileVersion: "1",
		actor: system,
	});
	return { database, kernel, catalog, runId: "run-" + id, taskId, attemptId };
}

test("bounded prerequisite proposals are accepted without giving the Agent acceptance authority", async (context) => {
	const state = await activeTask("safe");
	context.after(() => state.database.close());
	const proposalId = state.kernel.proposeTaskChanges({
		runId: state.runId,
		changes: {
			additions: [
				{
					key: "prerequisite",
					title: "Add prerequisite",
					objective: "Provide the missing prerequisite",
					scope: ["src/prerequisite.ts"],
					constraints: [],
					acceptanceContract: contract,
					riskClass: "LOW",
					priority: 10,
				},
			],
			revisions: [],
			dependencies: [{ task: { taskId: state.taskId }, dependsOn: { newTaskKey: "prerequisite" }, kind: "REQUIRES" }],
			cancellations: [],
		},
		actor: { kind: "ATTEMPT", id: state.attemptId },
	});
	state.kernel.failAttempt({
		attemptId: state.attemptId,
		reason: "Graph refinement requested",
		retryTask: true,
		actor: system,
	});

	const changedCheck = { ...check, name: "changed-after-run-start" };
	const changedConfig: ProjectConfig = {
		...config,
		candidateChecks: [changedCheck],
		integrationChecks: [changedCheck],
	};
	const result = new BoundedTaskProposalPolicy(state.kernel, state.catalog, changedConfig).process(state.runId);
	assert.deepEqual(result.accepted, [proposalId]);
	assert.equal(state.catalog.listTaskChangeProposals(state.runId)[0]?.state, "ACCEPTED");
	assert.equal(
		state.catalog.listRunnableReady(state.runId).some((task) => task.id === state.taskId),
		false,
	);
	const prerequisite = state.catalog.listTasks(state.runId).find((task) => task.id !== state.taskId);
	assert.ok(prerequisite);
	state.kernel.markTaskReady(prerequisite.id, system);
	assert.deepEqual(
		state.catalog.listRunnableReady(state.runId).map((task) => task.id),
		[prerequisite.id],
	);
});

test("goal-changing proposals remain pending and block their source task for a user decision", async (context) => {
	const state = await activeTask("material");
	context.after(() => state.database.close());
	const proposalId = state.kernel.proposeTaskChanges({
		runId: state.runId,
		changes: {
			additions: [
				{
					key: "unrelated",
					title: "Unrelated expansion",
					objective: "Expand the goal",
					scope: ["other"],
					constraints: [],
					acceptanceContract: contract,
					riskClass: "LOW",
					priority: 0,
				},
			],
			revisions: [],
			dependencies: [],
			cancellations: [],
		},
		actor: { kind: "ATTEMPT", id: state.attemptId },
	});
	state.kernel.failAttempt({
		attemptId: state.attemptId,
		reason: "Graph change requested",
		retryTask: true,
		actor: system,
	});

	const result = new BoundedTaskProposalPolicy(state.kernel, state.catalog, config).process(state.runId);
	assert.equal(result.requiresUser[0]?.proposalId, proposalId);
	assert.equal(state.catalog.listTaskChangeProposals(state.runId)[0]?.state, "PROPOSED");
	assert.equal(state.catalog.getTask(state.taskId).state, "BLOCKED");
});
