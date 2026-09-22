import assert from "node:assert/strict";
import test from "node:test";
import type { CheckCommand } from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { applyTaskPlan, type PlannedTask, parseExplorationRequests, parseTaskPlan } from "../../src/planning/plan.ts";
import { openControlDatabase } from "../../src/store/database.ts";

const check: CheckCommand = {
	name: "test",
	argv: ["npm", "test"],
	timeoutMs: 60_000,
	lane: "HEAVY_CHECK",
};
const coordination: PlannedTask["coordination"] = {
	decomposability: "HIGH",
	sequentiality: "LOW",
	semanticCoupling: "LOW",
	integrationCost: "LOW",
	uncertainty: "LOW",
	rationale: "Repository boundaries are explicit",
	evidenceRefs: ["src"],
	explorationQuestions: [],
};
const taskInterface = {
	provides: [],
	requires: [],
	assumptions: [],
	interfaces: [],
	evidenceRefs: [],
};

test("planner output is validated as an acyclic task graph", () => {
	const plan = parseTaskPlan(
		JSON.stringify({
			tasks: [
				{
					key: "core",
					title: "Build core",
					objective: "Implement the core",
					scope: ["src"],
					constraints: [],
					riskClass: "NORMAL",
					priority: 10,
					coordination,
					interface: taskInterface,
				},
				{
					key: "docs",
					title: "Document core",
					objective: "Document the public behavior",
					scope: ["README.md"],
					constraints: [],
					riskClass: "LOW",
					priority: 0,
					coordination,
					interface: taskInterface,
				},
			],
			dependencies: [{ task: "docs", dependsOn: "core", kind: "REQUIRES" }],
		}),
	);
	assert.equal(plan.tasks.length, 2);
	assert.equal(plan.dependencies[0]?.dependsOn, "core");

	assert.throws(() =>
		parseTaskPlan(
			JSON.stringify({
				tasks: plan.tasks,
				dependencies: [
					{ task: "core", dependsOn: "docs" },
					{ task: "docs", dependsOn: "core" },
				],
			}),
		),
	);
});

test("planner exploration is explicit, bounded, and structurally validated", () => {
	const requests = parseExplorationRequests(
		JSON.stringify({
			explorationRequests: [
				{ question: "Where is authorization enforced?" },
				{ question: "Which integration tests cover the write path?" },
			],
		}),
		3,
	);
	assert.equal(requests.length, 2);
	assert.throws(() =>
		parseExplorationRequests(JSON.stringify({ explorationRequests: [{ question: "same" }, { question: "same" }] }), 3),
	);
	assert.throws(() =>
		parseExplorationRequests(JSON.stringify({ explorationRequests: [{ question: "one" }, { question: "two" }] }), 1),
	);
});

test("validated planner proposal becomes one atomic authoritative graph", async (context) => {
	const database = await openControlDatabase(":memory:");
	context.after(() => database.close());
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	kernel.createRun({
		id: "run-1",
		repositoryRoot: "/repo",
		objective: "Implement and document",
		inputCommit: "base",
		integrationRef: "refs/tripleteam/runs/run-1/integration",
		actor: { kind: "USER", id: "user" },
	});
	const attemptId = kernel.startAuxiliaryAttempt({
		id: "planner-1",
		runId: "run-1",
		workflowFunction: "PLAN",
		baseCommit: "base",
		profileName: "planner",
		profileVersion: "1",
		actor: { kind: "SYSTEM", id: "planner" },
	});
	kernel.completeAuxiliaryAttempt(attemptId, { kind: "SYSTEM", id: "planner" });
	const ids = applyTaskPlan({
		runId: "run-1",
		sourceAttemptId: attemptId,
		plan: {
			tasks: [
				{
					key: "core",
					title: "Core",
					objective: "Build core",
					scope: [],
					constraints: [],
					riskClass: "NORMAL",
					priority: 10,
					coordination: { ...coordination },
					interface: taskInterface,
				},
				{
					key: "docs",
					title: "Docs",
					objective: "Document core",
					scope: [],
					constraints: [],
					riskClass: "LOW",
					priority: 0,
					coordination: { ...coordination },
					interface: taskInterface,
				},
			],
			dependencies: [{ task: "docs", dependsOn: "core", kind: "REQUIRES" }],
		},
		acceptancePolicy: {
			candidateChecks: [check],
			integrationChecks: [check],
			reviewRequiredFor: ["NORMAL"],
		},
		kernel,
		actor: { kind: "SYSTEM", id: "planner" },
	});
	assert.equal(catalog.listTasks("run-1").length, 2);
	assert.equal(catalog.listUnblockedProposed("run-1")[0]?.id, ids.get("core"));
	assert.deepEqual(catalog.getTask(ids.get("core") as string).acceptanceContract, {
		candidateChecks: [check],
		integrationChecks: [check],
		requireReview: true,
	});
	assert.deepEqual(catalog.getTask(ids.get("docs") as string).acceptanceContract, {
		candidateChecks: [check],
		integrationChecks: [check],
		requireReview: false,
	});
	assert.equal(
		database.sql.prepare("SELECT COUNT(*) AS count FROM task_graph_proposals").get<{ count: number }>()?.count,
		1,
	);
});
