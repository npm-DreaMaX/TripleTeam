import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { type CheckCommand, checkCommandVersion, type ProjectConfig } from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import type { ContractObligation } from "../../src/control/contract-types.ts";
import { AdaptiveCoordinationPolicy } from "../../src/control/coordination-policy.ts";
import { FailurePolicy } from "../../src/control/failure-policy.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { LocalResourceGovernor, type ResourcePolicy } from "../../src/control/resource-governor.ts";
import { DomainInvariantError } from "../../src/domain/model.ts";
import { openControlDatabase } from "../../src/store/database.ts";

const system = { kind: "SYSTEM", id: "test" } as const;
const check: CheckCommand = {
	name: "test",
	argv: ["npm", "test"],
	timeoutMs: 60_000,
	lane: "HEAVY_CHECK",
	evidenceClass: "BEHAVIORAL",
};
const config: ProjectConfig = {
	maxAttemptsPerTask: 4,
	maxPlannerExplorations: 3,
	maxDiverseExplorations: 2,
	maxRepeatedFailureFingerprints: 2,
	workerTimeoutMs: 60_000,
	candidateChecks: [check],
	integrationChecks: [check],
	runChecks: [check],
	reviewRequiredFor: [],
	profiles: { explorer: "explorer", planner: "planner", implementer: "implementer", reviewer: "reviewer" },
};
const resources = new LocalResourceGovernor({
	capacity: 4,
	lanes: {
		INTERACTIVE: { limit: 2, weight: 1, priority: 100 },
		CODING: { limit: 2, weight: 1, priority: 60 },
		LIGHT_CHECK: { limit: 2, weight: 1, priority: 50 },
		HEAVY_CHECK: { limit: 1, weight: 2, priority: 40 },
		INTEGRATION: { limit: 1, weight: 1, priority: 80 },
	},
} satisfies ResourcePolicy);

async function fixture(enableContracts = true) {
	const database = await openControlDatabase(":memory:");
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	kernel.createRun({
		id: "run",
		repositoryRoot: "/repo",
		inputCommit: "base",
		inputTreeHash: "tree",
		integrationRef: "refs/test/run",
		goalContract: { executionPolicy: { enableContracts } },
		actor: system,
	});
	return { database, kernel, catalog };
}

function addTask(
	kernel: ControlKernel,
	id: string,
	scope: string[],
	input: {
		interface?: string;
		uncertainty?: "LOW" | "HIGH";
		semanticCoupling?: "LOW" | "MEDIUM" | "HIGH";
		requires?: string[];
		provides?: string[];
		obligations?: ContractObligation[];
	} = {},
): void {
	kernel.createTask({
		id,
		runId: "run",
		title: id,
		objective: `Implement ${id}`,
		scope,
		constraints: [],
		acceptanceContract: { candidateChecks: [check], integrationChecks: [check], requireReview: false },
		riskClass: "LOW",
		actor: system,
	});
	kernel.recordTaskCoordination({
		taskId: id,
		assessment: {
			decomposability: "HIGH",
			sequentiality: "LOW",
			semanticCoupling: input.semanticCoupling ?? "LOW",
			integrationCost: "LOW",
			uncertainty: input.uncertainty ?? "LOW",
			rationale: "Explicitly isolated repository responsibility",
			evidenceRefs: scope,
			explorationQuestions:
				input.uncertainty === "HIGH"
					? [
							{
								key: "architecture",
								hypothesis: "one of two repository designs is authoritative",
								question: "Which design is used?",
							},
						]
					: [],
		},
		contract: {
			provides: input.provides ?? [`${id}-capability`],
			requires: input.requires ?? [],
			assumptions: [],
			ownedScope: scope,
			interfaces: input.interface ? [input.interface] : [],
			evidenceRefs: scope,
			obligations: input.obligations,
		},
		actor: system,
	});
	kernel.markTaskReady(id, system);
}

test("adaptive policy parallelizes only tasks with explicit semantic independence", async (context) => {
	const { database, kernel, catalog } = await fixture();
	context.after(() => database.close());
	addTask(kernel, "api", ["src/api"]);
	addTask(kernel, "docs", ["docs"]);
	const policy = new AdaptiveCoordinationPolicy(kernel, catalog, resources);
	const decision = policy.decide("run", catalog.listRunnableReady("run"));
	assert.equal(decision.mode, "PARALLEL_TASKS");
	assert.deepEqual(
		decision.tasks.map((task) => task.id),
		["api", "docs"],
	);
	assert.equal(
		database.sql.prepare("SELECT mode FROM coordination_decisions WHERE id = ?").get<{ mode: string }>(decision.id)
			?.mode,
		"PARALLEL_TASKS",
	);
});

test("semantic interface coupling serializes path-disjoint tasks", async (context) => {
	const { database, kernel, catalog } = await fixture();
	context.after(() => database.close());
	addTask(kernel, "producer", ["src/producer"], { interface: "public-user-schema" });
	addTask(kernel, "consumer", ["src/consumer"], { interface: "public-user-schema" });
	const decision = new AdaptiveCoordinationPolicy(kernel, catalog, resources).decide(
		"run",
		catalog.listRunnableReady("run"),
	);
	assert.equal(decision.mode, "SERIALIZE");
	assert.equal(decision.tasks.length, 1);
});

async function publishedInterface(context: TestContext, input: { enableContracts?: boolean; evidence?: boolean } = {}) {
	const state = await fixture(input.enableContracts);
	context.after(() => state.database.close());
	const key = "logging-ready";
	addTask(state.kernel, "logging", ["src/logging"], {
		provides: [key],
		obligations: [{ key, artifactPaths: ["src/logging/index.ts"], checkNames: [check.name] }],
	});
	if (input.evidence !== false) {
		const checkId = state.kernel.recordCheckResult({
			runId: "run",
			taskId: "logging",
			subjectKind: "INTEGRATION",
			subjectId: "published-logging",
			treeHash: "tree",
			checkKind: check.name,
			checkVersion: checkCommandVersion(check),
			command: check.argv,
			environmentHash: "fixture",
			state: "PASSED",
			actor: system,
		});
		state.kernel.recordContractEvidence({
			taskId: "logging",
			obligation: key,
			commitHash: "base",
			treeHash: "tree",
			artifacts: [{ path: "src/logging/index.ts", blobHash: "a".repeat(40) }],
			checkIds: [checkId],
		});
	}
	// Supply the accepted publication projection; integration validity is covered by kernel tests.
	state.database.sql.prepare("UPDATE tasks SET state='ACCEPTED' WHERE id='logging'").run();
	state.database.sql.prepare("UPDATE coordination_contracts SET state='SATISFIED' WHERE task_id='logging'").run();
	return { ...state, key };
}

test("an unrelated verified requirement cannot release high or medium semantic coupling", async (context) => {
	for (const semanticCoupling of ["HIGH", "MEDIUM"] as const) {
		const { kernel, catalog, key } = await publishedInterface(context);
		for (const id of ["payments", "refunds"])
			addTask(kernel, id, [`src/${id}`], {
				interface: "payment-state",
				requires: [key],
				semanticCoupling,
			});
		const decision = new AdaptiveCoordinationPolicy(kernel, catalog, resources).decide(
			"run",
			catalog.listRunnableReady("run"),
		);
		assert.equal(decision.mode, "SERIALIZE", semanticCoupling);
		assert.equal(decision.tasks.length, 1);
	}
});

test("medium coupling on the same verified required interface permits independent consumers", async (context) => {
	const { kernel, catalog, key } = await publishedInterface(context);
	for (const id of ["api", "cli"])
		addTask(kernel, id, [`src/${id}`], { interface: key, requires: [key], semanticCoupling: "MEDIUM" });
	const decision = new AdaptiveCoordinationPolicy(kernel, catalog, resources).decide(
		"run",
		catalog.listRunnableReady("run"),
	);
	assert.equal(decision.mode, "PARALLEL_TASKS");
	assert.equal(decision.tasks.length, 2);
});

test("high coupling remains serialized even when every declared interface has evidence", async (context) => {
	const { kernel, catalog, key } = await publishedInterface(context);
	for (const id of ["api", "cli"])
		addTask(kernel, id, [`src/${id}`], { interface: key, requires: [key], semanticCoupling: "HIGH" });
	const decision = new AdaptiveCoordinationPolicy(kernel, catalog, resources).decide(
		"run",
		catalog.listRunnableReady("run"),
	);
	assert.equal(decision.mode, "SERIALIZE");
});

test("contract state alone and disabled contracts cannot supply a semantic independence proof", async (context) => {
	for (const options of [{ evidence: false }, { enableContracts: false }]) {
		const { kernel, catalog, key } = await publishedInterface(context, options);
		for (const id of ["api", "cli"])
			addTask(kernel, id, [`src/${id}`], { interface: key, requires: [key], semanticCoupling: "MEDIUM" });
		const decision = new AdaptiveCoordinationPolicy(kernel, catalog, resources).decide(
			"run",
			catalog.listRunnableReady("run"),
		);
		assert.equal(decision.mode, "SERIALIZE");
	}
});

test("high unresolved uncertainty selects bounded diverse exploration before a writer", async (context) => {
	const { database, kernel, catalog } = await fixture();
	context.after(() => database.close());
	addTask(kernel, "uncertain", ["src"], { uncertainty: "HIGH" });
	const decision = new AdaptiveCoordinationPolicy(kernel, catalog, resources).decide(
		"run",
		catalog.listRunnableReady("run"),
	);
	assert.equal(decision.mode, "DIVERSE_EXPLORATION");
});

test("repeated identical failures change disposition and cannot retry forever", async (context) => {
	const { database, kernel, catalog } = await fixture();
	context.after(() => database.close());
	addTask(kernel, "failing", ["src"]);
	const policy = new FailurePolicy(kernel, catalog, config);
	const diagnose = () =>
		policy.diagnose({
			runId: "run",
			taskId: "failing",
			phase: "CANDIDATE_VERIFY",
			classification: "VERIFICATION",
			detail: "the same deterministic assertion failed at line 42",
		});
	assert.equal(diagnose().disposition, "RETRY");
	assert.equal(diagnose().disposition, "REPLAN");
	assert.equal(diagnose().disposition, "BLOCK");
});

test("human decisions are first-class and stale attempts cannot create them", async (context) => {
	const { database, kernel, catalog } = await fixture();
	context.after(() => database.close());
	addTask(kernel, "choice", ["src"]);
	const attempt = kernel.startAttempt({
		id: "attempt",
		taskId: "choice",
		baseCommit: "base",
		profileName: "implementer",
		profileVersion: "1",
		actor: system,
	});
	const requestId = kernel.createDecisionRequest({
		runId: "run",
		taskId: "choice",
		kind: "REQUIREMENT_CHOICE",
		question: "Which externally visible behavior is intended?",
		options: ["A", "B"],
		sourceKind: "ATTEMPT",
		sourceId: attempt.attemptId,
		actor: { kind: "ATTEMPT", id: attempt.attemptId },
	});
	assert.equal(catalog.getDecisionRequest(requestId).state, "OPEN");
	kernel.failAttempt({ attemptId: attempt.attemptId, reason: "Waiting for human", retryTask: false, actor: system });
	assert.throws(
		() =>
			kernel.createDecisionRequest({
				runId: "run",
				taskId: "choice",
				kind: "REQUIREMENT_CHOICE",
				question: "A stale follow-up question",
				options: ["A", "B"],
				actor: { kind: "ATTEMPT", id: attempt.attemptId },
			}),
		(error) => error instanceof DomainInvariantError && error.code === "STALE_DECISION_REQUEST",
	);
	kernel.resolveDecisionRequest({
		requestId,
		selectedOption: "A",
		rationale: "Product contract selects A",
		actor: { kind: "USER", id: "user" },
	});
	assert.equal(catalog.getDecisionRequest(requestId).state, "DECIDED");
});
