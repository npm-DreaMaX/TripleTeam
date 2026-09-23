import assert from "node:assert/strict";
import test from "node:test";
import {
	type CheckCommand,
	checkCommandVersion,
	parseCheckCommand,
	taskAcceptanceForScope,
} from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { compileIncrements } from "../../src/planning/increments.ts";
import type { PlannedTask, TaskPlan } from "../../src/planning/plan.ts";
import { openControlDatabase } from "../../src/store/database.ts";

const global: CheckCommand = { name: "regression", argv: ["true"], timeoutMs: 1000, lane: "LIGHT_CHECK" };
const scoped: CheckCommand = { ...global, name: "joint-api-sdk", scope: ["api", "sdk"], atomic: true };
const policy = { candidateChecks: [global], integrationChecks: [global, scoped], reviewRequiredFor: ["HIGH"] };
function task(key: string): PlannedTask {
	return {
		key,
		title: key,
		objective: "Implement " + key,
		scope: [key],
		constraints: ["Keep existing behavior"],
		riskClass: "NORMAL",
		priority: 0,
		coordination: {
			decomposability: "HIGH",
			sequentiality: "LOW",
			semanticCoupling: "LOW",
			integrationCost: "LOW",
			uncertainty: "LOW",
			rationale: "Independent",
			evidenceRefs: [],
			explorationQuestions: [],
		},
		interface: { provides: [], requires: [], assumptions: [], interfaces: [], evidenceRefs: [] },
	};
}

test("scope selection keeps every global gate and selects matching component obligations", () => {
	assert.deepEqual(
		taskAcceptanceForScope(policy, ["api/routes"], "HIGH").integrationChecks.map((c) => c.name),
		["regression", "joint-api-sdk"],
	);
	assert.deepEqual(
		taskAcceptanceForScope(policy, ["docs"], "LOW").integrationChecks.map((c) => c.name),
		["regression"],
	);
	assert.equal(taskAcceptanceForScope(policy, ["api"], "HIGH").requireReview, true);
	assert.equal(taskAcceptanceForScope(policy, ["."], "NORMAL").integrationChecks.length, 2);
	assert.notEqual(checkCommandVersion(global), checkCommandVersion({ ...global, scope: ["api"] }));
	assert.throws(() => parseCheckCommand({ ...global, scope: ["../api"] }, "check"));
	assert.throws(() => parseCheckCommand({ ...global, atomic: true }, "check"));
});

test("atomic check scopes coalesce connected increments and preserve objectives and external dependencies", () => {
	const plan: TaskPlan = {
		tasks: [task("contract"), task("api"), task("sdk"), task("docs")],
		dependencies: [
			{ task: "api", dependsOn: "contract", kind: "REQUIRES" },
			{ task: "sdk", dependsOn: "api", kind: "REQUIRES" },
			{ task: "docs", dependsOn: "sdk", kind: "REQUIRES" },
		],
	};
	const compiled = compileIncrements(plan, policy);
	assert.equal(plan.tasks.length, 4);
	assert.equal(compiled.plan.tasks.length, 3);
	assert.match(compiled.plan.tasks.find((t) => t.key === "api")?.objective ?? "", /Implement sdk/);
	assert.deepEqual(
		compiled.plan.dependencies.map((d) => [d.task, d.dependsOn]),
		[
			["api", "contract"],
			["docs", "api"],
		],
	);
});

test("non-adjacent atomic increments absorb intervening tasks instead of introducing a dependency cycle", () => {
	const plan: TaskPlan = {
		tasks: [task("api"), task("middle"), task("sdk"), task("unrelated")],
		dependencies: [
			{ task: "middle", dependsOn: "api", kind: "REQUIRES" },
			{ task: "sdk", dependsOn: "middle", kind: "REQUIRES" },
		],
	};
	const compiled = compileIncrements(plan, policy);
	assert.equal(compiled.plan.tasks.length, 2);
	assert.deepEqual(compiled.groups[0], ["api", "middle", "sdk"]);
	assert.deepEqual(compiled.plan.dependencies, []);
});

test("failed baseline global checks coarsen the goal without dropping any frozen check", () => {
	const plan: TaskPlan = { tasks: [task("api"), task("sdk")], dependencies: [] };
	const result = compileIncrements(plan, policy, {
		inputCommit: "base",
		treeHash: "tree",
		policyHash: "policy",
		checks: [{ name: "regression", version: checkCommandVersion(global), state: "FAILED", checkId: "baseline-check" }],
	});
	assert.equal(result.plan.tasks.length, 1);
	assert.equal(taskAcceptanceForScope(policy, result.plan.tasks[0]?.scope ?? [], "NORMAL").integrationChecks.length, 2);
});

test("kernel rejects omission or replacement of scoped/global frozen gates at task creation", async (context) => {
	const db = await openControlDatabase(":memory:");
	context.after(() => db.close());
	const kernel = new ControlKernel(db),
		catalog = new ControlCatalog(db);
	kernel.createRun({
		id: "run",
		repositoryRoot: "/repo",
		inputCommit: "base",
		integrationRef: "refs/test",
		goalContract: { verificationPolicyVersion: 1, taskAcceptancePolicy: policy },
		actor: { kind: "SYSTEM", id: "test" },
	});
	const input = {
		runId: "run",
		title: "API",
		objective: "Implement API",
		scope: ["api"],
		constraints: [],
		riskClass: "HIGH",
		acceptanceContract: taskAcceptanceForScope(policy, ["api"], "HIGH"),
		actor: { kind: "SYSTEM", id: "test" } as const,
	};
	assert.throws(
		() =>
			kernel.createTask({ ...input, acceptanceContract: { ...input.acceptanceContract, integrationChecks: [global] } }),
		/joint-api-sdk/,
	);
	assert.throws(
		() =>
			kernel.createTask({
				...input,
				acceptanceContract: {
					...input.acceptanceContract,
					integrationChecks: [global, { ...scoped, argv: ["false"] }],
				},
			}),
		/joint-api-sdk/,
	);
	assert.throws(
		() => kernel.createTask({ ...input, acceptanceContract: { ...input.acceptanceContract, requireReview: false } }),
		/review gate/,
	);
	assert.equal(catalog.listTasks("run").length, 0);
	kernel.createTask(input);
	assert.equal(catalog.listTasks("run").length, 1);
});
