import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExecutionPolicy } from "../../src/config/execution.ts";
import type { CheckCommand } from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { AdaptiveCoordinationPolicy } from "../../src/control/coordination-policy.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { LocalResourceGovernor } from "../../src/control/resource-governor.ts";
import { openControlDatabase } from "../../src/store/database.ts";

const actor = { kind: "SYSTEM", id: "compute-estimator-test" } as const;
const startedAt = "2026-01-01T00:00:00.000Z";
const check: CheckCommand = {
	name: "behavior",
	argv: [process.execPath, "-e", "process.exit(0)"],
	timeoutMs: 1000,
	lane: "LIGHT_CHECK",
	evidenceClass: "BEHAVIORAL",
};

async function fixture(context: TestContext, executionPolicy: Partial<ExecutionPolicy> = {}) {
	const database = await openControlDatabase(":memory:");
	context.after(() => database.close());
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	const resources = new LocalResourceGovernor({
		capacity: 4,
		lanes: {
			INTERACTIVE: { limit: 2, weight: 1, priority: 100 },
			CODING: { limit: 2, weight: 1, priority: 60 },
			LIGHT_CHECK: { limit: 2, weight: 1, priority: 50 },
			HEAVY_CHECK: { limit: 1, weight: 2, priority: 40 },
			INTEGRATION: { limit: 1, weight: 1, priority: 80 },
		},
	});
	const policy = new AdaptiveCoordinationPolicy(kernel, catalog, resources);
	kernel.createRun({
		id: "run",
		repositoryRoot: "/repo",
		inputCommit: "base",
		inputTreeHash: "base-tree",
		integrationRef: "refs/test/compute-estimator",
		goalContract: { executionPolicy: { policy: "ADAPTIVE", ...executionPolicy } },
		actor,
	});
	for (const id of ["alpha", "beta"]) {
		const scope = [`src/${id}`];
		kernel.createTask({
			id,
			runId: "run",
			title: id,
			objective: `Implement the independent ${id} component`,
			scope,
			constraints: [],
			acceptanceContract: { candidateChecks: [check], integrationChecks: [check], requireReview: false },
			riskClass: "LOW",
			actor,
		});
		kernel.recordTaskCoordination({
			taskId: id,
			assessment: {
				decomposability: "HIGH",
				sequentiality: "LOW",
				semanticCoupling: "LOW",
				integrationCost: "LOW",
				uncertainty: "LOW",
				rationale: "Separate components with no shared interface or dependencies",
				evidenceRefs: scope,
				explorationQuestions: [],
			},
			contract: { provides: [], requires: [], assumptions: [], ownedScope: scope, interfaces: [], evidenceRefs: scope },
			actor,
		});
		kernel.markTaskReady(id, actor);
	}
	return { database, kernel, catalog, policy };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Usage = Parameters<ControlKernel["recordUsage"]>[0];

function usage(state: Fixture, input: Omit<Usage, "runId" | "startedAt" | "finishedAt"> & { durationMs: number }) {
	const { durationMs, ...record } = input;
	return state.kernel.recordUsage({
		...record,
		runId: "run",
		startedAt,
		finishedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(),
	});
}

// Historical rows below are metrics projection fixtures only. They deliberately leave the live
// tasks READY so the policy can compare dispatch choices; they do not exercise or bypass acceptance.
// Git publication and exact-tree acceptance are covered by assurance-execution.test.ts.
function writer(
	state: Fixture,
	input: {
		id: string;
		taskId: string;
		state?: "SUBMITTED" | "FAILED" | "RUNNING";
		durationMs?: number;
		costUsd?: number;
		inputTokens?: number;
		integrated?: boolean;
	},
) {
	const epoch =
		(state.database.sql
			.prepare("SELECT MAX(epoch) AS epoch FROM attempts WHERE task_id=?")
			.get<{ epoch: number | null }>(input.taskId)?.epoch ?? 0) + 1;
	state.database.sql
		.prepare(
			`INSERT INTO attempts
(id,run_id,task_id,workflow_function,epoch,state,base_commit,profile_name,profile_version,created_at,updated_at)
VALUES (?,'run',?,'IMPLEMENT',?,?,'base','writer','test',?,?)`,
		)
		.run(input.id, input.taskId, epoch, input.state ?? "SUBMITTED", startedAt, startedAt);
	usage(state, {
		taskId: input.taskId,
		attemptId: input.id,
		kind: "AGENT",
		phase: "IMPLEMENT",
		durationMs: input.durationMs ?? 100_000,
		costUsd: input.costUsd ?? 1,
		inputTokens: input.inputTokens,
	});
	if (input.integrated) candidate(state, input.id, "INTEGRATED", `${input.id}-integrated`);
	return input.id;
}

function candidate(state: Fixture, attemptId: string, status: "INTEGRATED" | "REJECTED", id: string) {
	state.database.sql
		.prepare(
			`INSERT INTO candidates
(id,task_id,attempt_id,attempt_epoch,base_commit,commit_hash,tree_hash,changed_paths_json,state,submission_note,created_at,updated_at)
SELECT ?,task_id,id,epoch,'base',?,?,'[]',?,'metrics projection',?,? FROM attempts WHERE id=?`,
		)
		.run(id, `${id}-commit`, `${id}-tree`, status, startedAt, startedAt, attemptId);
}

interface Estimate {
	taskId: string;
	criticalPathMs: number;
	estimatedDurationMs: number;
	estimatedCostUsd: number;
	writerSamples: number;
	successProbability: number;
	conservativeSuccessScore: number;
	localOutcomes: number;
	transferredOutcomes: number;
	verificationCostMs: number;
	auxiliaryCostMs: number;
	marginalUsefulMs: number;
}

function decide(state: Fixture) {
	const previous = new Set(state.catalog.listControlActions("run", "COMPUTE_ESTIMATE").map((action) => action.id));
	const decision = state.policy.decide("run", state.catalog.listRunnableReady("run"));
	const action = state.catalog.listControlActions("run", "COMPUTE_ESTIMATE").find((action) => !previous.has(action.id));
	assert.ok(action, "a dispatch decision must persist its compute estimate");
	const detail = JSON.parse(action.detail_json) as {
		calibrated: boolean;
		source: string;
		estimates: Estimate[];
		budget: ReturnType<ControlKernel["computeSnapshot"]>;
	};
	const estimate = (taskId: string) => {
		const item = detail.estimates.find((item) => item.taskId === taskId);
		assert.ok(item, `missing estimate for ${taskId}`);
		return item;
	};
	return { decision, detail, estimate };
}

function history(state: Fixture, taskId: string) {
	const item = state.catalog.performanceHistory("run").find((item) => item.taskId === taskId);
	assert.ok(item);
	return item;
}

test("writer samples combine resume usage per completed attempt and keep checks, auxiliary work and exploration separate", async (context) => {
	const state = await fixture(context);
	const resumed = writer(state, { id: "resumed", taskId: "alpha", durationMs: 1000, costUsd: 1 });
	usage(state, {
		taskId: "alpha",
		attemptId: resumed,
		kind: "AGENT",
		phase: "IMPLEMENT_RESUME",
		durationMs: 2000,
		costUsd: 2,
	});
	writer(state, { id: "failed", taskId: "alpha", state: "FAILED", durationMs: 9000, costUsd: 9 });
	writer(state, { id: "still-live", taskId: "alpha", state: "RUNNING", durationMs: 9_000_000, costUsd: 900 });
	usage(state, { taskId: "alpha", kind: "CHECK", phase: "CANDIDATE", durationMs: 90_000 });
	usage(state, { taskId: "alpha", kind: "AGENT", phase: "REVIEW", durationMs: 12_000, costUsd: 4 });
	usage(state, { taskId: "alpha", kind: "AGENT", phase: "DIVERSE_EXPLORATION", durationMs: 6000, costUsd: 2 });
	usage(state, { taskId: "alpha", kind: "AGENT", phase: "REPLAN", durationMs: 10_000, costUsd: 6 });
	usage(state, { taskId: "alpha", kind: "COORDINATION", phase: "DISPATCH", durationMs: 500_000 });
	assert.deepEqual(
		{ ...history(state, "alpha") },
		{
			taskId: "alpha",
			durationMs: 6000,
			costUsd: 6,
			writerSamples: 2,
			checksMs: 45_000,
			auxiliaryMs: 14_000,
			auxiliaryCostUsd: 6,
			explorationMs: 8000,
			explorationCostUsd: 4,
			explorationSamples: 2,
			successes: 0,
			failures: 1,
		},
	);
	const estimate = decide(state).estimate("alpha");
	assert.equal(estimate.estimatedDurationMs, 6000);
	assert.equal(estimate.criticalPathMs, 6000);
	assert.equal(estimate.estimatedCostUsd, 12);
	assert.equal(estimate.verificationCostMs, 45_000);
	assert.ok(estimate.marginalUsefulMs < 0, "slow checks must reduce the benefit of another writer");
});

test("repeated failure diagnoses and rejected candidates count as one failed writer attempt", async (context) => {
	const state = await fixture(context);
	const attemptId = writer(state, { id: "failed-writer", taskId: "alpha", state: "FAILED" });
	candidate(state, attemptId, "REJECTED", "rejected-a");
	candidate(state, attemptId, "REJECTED", "rejected-b");
	const before = decide(state).estimate("alpha");
	assert.equal(before.successProbability, 2 / 5, "one failure updates the Beta(2,2) prior once");
	const reviewer = state.kernel.startAuxiliaryAttempt({
		runId: "run",
		taskId: "alpha",
		workflowFunction: "REVIEW",
		baseCommit: "base",
		profileName: "reviewer",
		profileVersion: "test",
		actor,
	});
	state.kernel.failAttempt({ attemptId: reviewer, reason: "review transport failed", retryTask: false, actor });
	for (let index = 0; index < 8; index++) {
		state.kernel.recordFailureDiagnosis({
			runId: "run",
			taskId: "alpha",
			attemptId: index % 2 ? attemptId : reviewer,
			phase: index % 2 ? "CANDIDATE_CHECKS" : "REVIEW",
			classification: "BEHAVIORAL_FAILURE",
			fingerprint: "same-underlying-failure",
			disposition: "RETRY",
			detail: "Repeated observation of the same failed attempt",
			actor,
		});
	}
	assert.equal(history(state, "alpha").failures, 1);
	const after = decide(state).estimate("alpha");
	assert.equal(after.localOutcomes, 1);
	assert.equal(after.successProbability, before.successProbability);
	assert.equal(after.conservativeSuccessScore, before.conservativeSuccessScore);
});

for (const overhead of ["CHECK", "AGENT"] as const) {
	test(`expensive ${overhead === "CHECK" ? "verification" : "auxiliary work"} serializes independent tasks without inflating writer duration`, async (context) => {
		const state = await fixture(context);
		for (const taskId of ["alpha", "beta"]) writer(state, { id: `${taskId}-writer`, taskId, integrated: true });
		const before = decide(state);
		assert.equal(before.decision.mode, "PARALLEL_TASKS");
		assert.equal(before.decision.tasks.length, 2);
		for (const taskId of ["alpha", "beta"]) {
			usage(state, {
				taskId,
				kind: overhead,
				phase: overhead === "CHECK" ? "CANDIDATE" : "REVIEW",
				durationMs: 60_000,
			});
		}
		const after = decide(state);
		assert.equal(after.decision.mode, "SERIALIZE");
		assert.equal(after.decision.tasks.length, 1);
		for (const taskId of ["alpha", "beta"]) {
			const current = after.estimate(taskId);
			assert.equal(current.estimatedDurationMs, before.estimate(taskId).estimatedDurationMs);
			assert.equal(current.writerSamples, 1);
			assert.equal(overhead === "CHECK" ? current.verificationCostMs : current.auxiliaryCostMs, 60_000);
			assert.ok(before.estimate(taskId).marginalUsefulMs > 0);
			assert.ok(current.marginalUsefulMs < 0);
		}
	});
}

test("successful writer history updates conservative estimates while cross-task transfer is capped at four outcomes", async (context) => {
	const state = await fixture(context);
	const before = decide(state);
	assert.equal(before.estimate("alpha").successProbability, 0.5);
	assert.equal(before.estimate("alpha").localOutcomes, 0);
	assert.equal(before.detail.source, "uncalibrated-priors");
	for (let index = 0; index < 8; index++) writer(state, { id: `success-${index}`, taskId: "alpha", integrated: true });
	// Multiple integrated snapshots from one attempt must still contribute only one success.
	candidate(state, "success-0", "INTEGRATED", "same-writer-second-snapshot");
	assert.equal(history(state, "alpha").successes, 8);
	const after = decide(state);
	const local = after.estimate("alpha");
	const transferred = after.estimate("beta");
	assert.equal(local.successProbability, 10 / 12);
	assert.equal(local.localOutcomes, 8);
	assert.equal(local.transferredOutcomes, 0);
	assert.ok(local.conservativeSuccessScore > before.estimate("alpha").conservativeSuccessScore);
	assert.ok(local.conservativeSuccessScore < local.successProbability);
	assert.equal(local.estimatedDurationMs, 100_000);
	assert.equal(transferred.successProbability, 6 / 8);
	assert.equal(transferred.localOutcomes, 0);
	assert.equal(transferred.transferredOutcomes, 4);
	assert.ok(transferred.conservativeSuccessScore < local.conservativeSuccessScore);
	assert.equal(after.detail.source, "runtime-history-with-priors");
	assert.equal(after.detail.calibrated, false, "runtime history must not claim measured calibration");
});

test("dispatch affordability includes auxiliary costs already spent and expected for each extra writer", async (context) => {
	const state = await fixture(context, { costLimitUsd: 18 });
	for (const taskId of ["alpha", "beta"])
		writer(state, { id: `${taskId}-writer`, taskId, costUsd: 1, integrated: true });
	assert.equal(decide(state).decision.mode, "PARALLEL_TASKS");
	for (const taskId of ["alpha", "beta"])
		usage(state, { taskId, kind: "AGENT", phase: "REVIEW", durationMs: 1000, costUsd: 4 });
	const after = decide(state);
	assert.equal(after.detail.budget.costUsd, 10);
	for (const taskId of ["alpha", "beta"]) {
		assert.equal(after.estimate(taskId).estimatedCostUsd, 5);
		assert.ok(after.estimate(taskId).marginalUsefulMs > 0, "time savings remain positive; cost is the limiting factor");
	}
	assert.ok(after.detail.budget.costUsd + 2 <= 18, "counting writer dollars alone would allow parallel dispatch");
	assert.ok(after.detail.budget.costUsd + 2 * after.estimate("alpha").estimatedCostUsd > 18);
	assert.equal(after.decision.mode, "SERIALIZE");
	assert.equal(after.decision.tasks.length, 1);
});

test("run compute budget includes task auxiliary agents, run-level planning, checks and all token classes", async (context) => {
	const state = await fixture(context, { costLimitUsd: 10, tokenLimit: 2000 });
	writer(state, { id: "writer", taskId: "alpha", costUsd: 1, inputTokens: 100 });
	usage(state, { kind: "AGENT", phase: "PLAN", durationMs: 1000, costUsd: 2, inputTokens: 200 });
	usage(state, {
		taskId: "alpha",
		kind: "AGENT",
		phase: "REVIEW",
		durationMs: 1000,
		costUsd: 3,
		inputTokens: 100,
		outputTokens: 200,
		cacheReadTokens: 300,
		cacheWriteTokens: 400,
	});
	assert.equal(state.kernel.computeSnapshot("run").costUsd, 6);
	assert.equal(state.kernel.computeSnapshot("run").unavailableReason, null);
	usage(state, { taskId: "alpha", kind: "CHECK", phase: "INTEGRATION", durationMs: 1000, costUsd: 4 });
	const snapshot = state.kernel.computeSnapshot("run");
	assert.equal(snapshot.costUsd, 10);
	assert.equal(snapshot.tokens, 1300);
	assert.equal(snapshot.unavailableReason, "Run cost budget exhausted or reserved");
	assert.equal(history(state, "alpha").costUsd, 1, "writer metrics must remain separate from the full run bill");
});
