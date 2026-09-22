import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import { type ExecutionPolicy, parseExecutionPolicy } from "../../src/config/execution.ts";
import { type CheckCommand, checkCommandVersion } from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { LocalResourceGovernor } from "../../src/control/resource-governor.ts";
import { RunScheduler } from "../../src/control/scheduler.ts";
import type { TaskExecutor } from "../../src/control/task-executor.ts";
import { openControlDatabase } from "../../src/store/database.ts";
import type { RunVerifier } from "../../src/verification/run-verifier.ts";

const system = { kind: "SYSTEM", id: "scheduler-test" } as const;
const check: CheckCommand = {
	name: "task-check",
	argv: ["test"],
	timeoutMs: 1000,
	lane: "LIGHT_CHECK",
	evidenceClass: "STRUCTURAL",
};
const finalCheck: CheckCommand = { ...check, name: "final-check" };
const resources = () =>
	new LocalResourceGovernor({
		capacity: 4,
		lanes: {
			INTERACTIVE: { limit: 2, weight: 1, priority: 100 },
			CODING: { limit: 2, weight: 1, priority: 60 },
			LIGHT_CHECK: { limit: 2, weight: 1, priority: 50 },
			HEAVY_CHECK: { limit: 1, weight: 1, priority: 40 },
			INTEGRATION: { limit: 1, weight: 1, priority: 80 },
		},
	});

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function beforeTimeout(promise: Promise<void>): Promise<void> {
	await Promise.race([
		promise,
		delay(1000).then(() => {
			throw new Error("Expected scheduling progress did not occur");
		}),
	]);
}

async function fixture(context: TestContext, overrides: Partial<ExecutionPolicy> = {}) {
	const database = await openControlDatabase(":memory:");
	context.after(() => database.close());
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	const policy = parseExecutionPolicy({ policy: "FIXED", maxParallelism: 2, ...overrides });
	const goal = {
		objective: "Deliver both components",
		authorizedScope: ["src"],
		runChecks: [finalCheck],
		taskAcceptancePolicy: { candidateChecks: [check], integrationChecks: [check], reviewRequiredFor: [] },
		executionPolicy: policy,
		coordinationPolicy: { maxRepeatedFailureFingerprints: 2 },
	};
	kernel.createRun({
		id: "run",
		repositoryRoot: "/repo",
		objective: goal.objective,
		inputCommit: "head",
		inputTreeHash: "tree",
		integrationRef: "refs/test/run",
		goalContract: goal,
		actor: system,
	});
	const addTask = (id: string, interfaceName?: string) => {
		kernel.createTask({
			id,
			runId: "run",
			title: id,
			objective: `Implement ${id}`,
			scope: [`src/${id}`],
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
				semanticCoupling: "LOW",
				integrationCost: "LOW",
				uncertainty: "LOW",
				rationale: "Independent component",
				evidenceRefs: [`src/${id}`],
				explorationQuestions: [],
			},
			contract: {
				provides: [],
				requires: [],
				assumptions: [],
				ownedScope: [`src/${id}`],
				interfaces: interfaceName ? [interfaceName] : [],
				evidenceRefs: [],
			},
			actor: system,
		});
	};
	const started: string[] = [];
	const finished: string[] = [];
	let active = 0;
	let maxActive = 0;
	let operation = async (_taskId: string): Promise<void> => {
		await nextTurn();
	};
	let meter = false;
	const executor = {
		execute: async (taskId: string) => {
			started.push(taskId);
			active++;
			maxActive = Math.max(maxActive, active);
			const task = catalog.getTask(taskId);
			const baseCommit = catalog.getRun("run").integrationHead;
			const attempt = kernel.startAttempt({
				taskId,
				baseCommit,
				profileName: "fake",
				profileVersion: "1",
				actor: system,
			});
			let executionId: string | undefined;
			let reservationId: string | undefined;
			try {
				if (meter) {
					executionId = kernel.createExecution({
						attemptId: attempt.attemptId,
						piSessionId: attempt.attemptId,
						contextManifestHash: "context",
						actor: system,
					});
					reservationId = attempt.attemptId;
					kernel.reserveCompute({ id: reservationId, runId: "run", executionId });
				}
				await operation(taskId);
				if (executionId) kernel.finishExecution({ executionId, state: "EXITED", exitCode: 0, actor: system });
				const contract = task.acceptanceContract as {
					candidateChecks: CheckCommand[];
					integrationChecks: CheckCommand[];
				};
				const candidateId = kernel.submitCandidate({
					taskId,
					attemptId: attempt.attemptId,
					attemptEpoch: attempt.epoch,
					baseCommit,
					commitHash: `candidate-${attempt.attemptId}`,
					treeHash: "tree",
					changedPaths: [`src/${taskId}/change`],
					actor: { kind: "ATTEMPT", id: attempt.attemptId },
				});
				for (const specification of contract.candidateChecks)
					kernel.recordCheckResult({
						runId: "run",
						taskId,
						subjectKind: "CANDIDATE",
						subjectId: candidateId,
						treeHash: "tree",
						checkKind: specification.name,
						checkVersion: checkCommandVersion(specification),
						command: specification.argv,
						environmentHash: "env",
						state: "PASSED",
						actor: system,
					});
				kernel.markCandidateEligible(candidateId, system);
				const integrationId = kernel.queueIntegration({
					candidateId,
					expectedHead: catalog.getRun("run").integrationHead,
					actor: system,
				});
				kernel.markIntegrationApplying(integrationId, system);
				for (const specification of contract.integrationChecks)
					kernel.recordCheckResult({
						runId: "run",
						taskId,
						subjectKind: "INTEGRATION",
						subjectId: integrationId,
						treeHash: "tree",
						checkKind: specification.name,
						checkVersion: checkCommandVersion(specification),
						command: specification.argv,
						environmentHash: "env",
						state: "PASSED",
						actor: system,
					});
				kernel.commitIntegration({
					integrationId,
					resultCommit: `integrated-${attempt.attemptId}`,
					resultTreeHash: "tree",
					actor: system,
				});
				kernel.acceptTask({ taskId, integrationId, actor: system });
				finished.push(taskId);
				return "ACCEPTED";
			} catch (error) {
				if (executionId) kernel.finishExecution({ executionId, state: "EXITED", exitCode: 1, actor: system });
				if (catalog.getAttempt(attempt.attemptId).state === "RUNNING")
					kernel.failAttempt({ attemptId: attempt.attemptId, reason: String(error), retryTask: false, actor: system });
				throw error;
			} finally {
				if (reservationId) kernel.releaseCompute(reservationId);
				active--;
			}
		},
	} as TaskExecutor;
	let verifyCount = 0;
	let verification = async (): Promise<{ state: "PASSED" | "FAILED" | "ERROR"; stderrPath?: string }> => ({
		state: "PASSED",
	});
	const verifier = {
		verify: async () => {
			verifyCount++;
			const result = await verification();
			kernel.bindIntegrationTree("run", catalog.getRun("run").integrationHead, "tree");
			const checkId = kernel.recordCheckResult({
				runId: "run",
				subjectKind: "RUN",
				subjectId: "run",
				treeHash: "tree",
				checkKind: finalCheck.name,
				checkVersion: checkCommandVersion(finalCheck),
				command: finalCheck.argv,
				environmentHash: "env",
				state: result.state,
				stderrPath: result.stderrPath,
				actor: system,
			});
			return { status: result.state, treeHash: "tree", checkIds: [checkId] };
		},
	} as unknown as RunVerifier;
	return {
		database,
		kernel,
		catalog,
		goal,
		addTask,
		started,
		finished,
		executor,
		verifier,
		scheduler: new RunScheduler(kernel, catalog, executor, verifier, resources()),
		setOperation: (handler: typeof operation) => {
			operation = handler;
		},
		setVerification: (handler: typeof verification) => {
			verification = handler;
		},
		setMeter: () => {
			meter = true;
		},
		maximumActive: () => maxActive,
		verifyCount: () => verifyCount,
	};
}

test("a dependency successor starts when its short prerequisite finishes while an unrelated writer remains active", async (context) => {
	const state = await fixture(context);
	state.addTask("slow");
	state.addTask("short");
	state.addTask("successor");
	state.kernel.addDependency({ taskId: "successor", dependsOnTaskId: "short", kind: "REQUIRES", actor: system });
	const releaseSlow = deferred();
	const successorStarted = deferred();
	context.after(releaseSlow.resolve);
	state.setOperation(async (id) => {
		if (id === "slow") await releaseSlow.promise;
		if (id === "successor") successorStarted.resolve();
	});
	const result = state.scheduler.runUntilSettled("run");
	await beforeTimeout(successorStarted.promise);
	assert.equal(state.catalog.getTask("slow").state, "ACTIVE");
	assert.equal(state.maximumActive(), 2);
	releaseSlow.resolve();
	assert.equal((await result).state, "COMPLETED");
});

for (const policy of ["SINGLE", "FIXED", "HEURISTIC", "ADAPTIVE"] as const) {
	test(`${policy} uses its frozen concurrency policy and semantic coupling still fences active work`, async (context) => {
		const state = await fixture(context, { policy });
		state.addTask("first", "shared-schema");
		state.addTask("independent");
		state.addTask("coupled", "shared-schema");
		state.setOperation(async (id) => {
			if (id === "coupled") assert.ok(state.finished.includes("first"));
			await nextTurn();
		});
		assert.equal((await state.scheduler.runUntilSettled("run")).state, "COMPLETED");
		assert.equal(state.maximumActive(), policy === "SINGLE" ? 1 : 2);
	});
}

test("reserved budget waits for active work and the final gate still runs at the execution limit", async (context) => {
	const state = await fixture(context, { costLimitUsd: 1, reservationUsd: 1, maxExecutions: 2 });
	state.addTask("first");
	state.addTask("second");
	state.setMeter();
	state.setOperation(async (id) => {
		assert.match(state.kernel.computeSnapshot("run").unavailableReason ?? "", /budget.*reserved|execution limit/);
		if (id === "second") assert.ok(state.finished.includes("first"));
		await nextTurn();
	});
	assert.equal((await state.scheduler.runUntilSettled("run")).state, "COMPLETED");
	assert.equal(state.maximumActive(), 1);
	assert.equal(state.verifyCount(), 1);
	assert.equal(state.catalog.listOpenDecisionRequests("run").length, 0);
});

test("an exhausted budget blocks ready work without starting an agent or asking a product decision", async (context) => {
	const state = await fixture(context, { maxExecutions: 1 });
	state.addTask("waiting");
	const attemptId = state.kernel.startAuxiliaryAttempt({
		runId: "run",
		workflowFunction: "PLAN",
		baseCommit: "head",
		profileName: "fake",
		profileVersion: "1",
		actor: system,
	});
	const executionId = state.kernel.createExecution({
		attemptId,
		piSessionId: "spent",
		contextManifestHash: "context",
		actor: system,
	});
	state.kernel.finishExecution({ executionId, state: "EXITED", exitCode: 0, actor: system });
	state.kernel.completeAuxiliaryAttempt(attemptId, system);
	assert.equal((await state.scheduler.runUntilSettled("run")).state, "BLOCKED");
	assert.deepEqual(state.started, []);
	assert.equal(state.catalog.getTask("waiting").state, "BLOCKED");
	assert.equal(state.catalog.listOpenDecisionRequests("run").length, 0);
});

test("a failure cannot return from the scheduler until its live sibling has settled", async (context) => {
	const state = await fixture(context);
	state.addTask("failing");
	state.addTask("slow");
	const releaseSlow = deferred();
	context.after(releaseSlow.resolve);
	let escaped = false;
	state.setOperation(async (id) => {
		if (id === "failing") throw new Error("expected executor fault");
		await releaseSlow.promise;
	});
	const result = state.scheduler.runUntilSettled("run").then(
		() => {
			escaped = true;
			return null;
		},
		(error: unknown) => {
			escaped = true;
			return error;
		},
	);
	await nextTurn();
	assert.equal(escaped, false);
	assert.equal(state.catalog.getTask("slow").state, "ACTIVE");
	releaseSlow.resolve();
	assert.match(String(await result), /expected executor fault/);
	assert.ok(state.finished.includes("slow"));
});

test("final failures create a bounded repair task with original checks, scope, and real failure evidence", async (context) => {
	const state = await fixture(context, { maxFinalRepairs: 2 });
	state.addTask("original");
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-final-repair-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "failure.log");
	await writeFile(path, "AssertionError: integration output failed the original acceptance\n");
	state.setVerification(async () => ({ state: state.verifyCount() === 1 ? "FAILED" : "PASSED", stderrPath: path }));
	const frozen = JSON.stringify(state.catalog.getRun("run").goalContract);
	assert.equal((await state.scheduler.runUntilSettled("run")).state, "COMPLETED");
	const repair = state.catalog.getTask("run:final-repair:1");
	assert.deepEqual(repair.scope, ["src"]);
	assert.match(repair.objective, /AssertionError: integration output failed the original acceptance/);
	assert.match(repair.objective, /tree tree/);
	assert.deepEqual(
		(repair.acceptanceContract as { integrationChecks: CheckCommand[] }).integrationChecks.map((item) => item.name),
		["task-check", "final-check"],
	);
	assert.equal(JSON.stringify(state.catalog.getRun("run").goalContract), frozen);
	assert.equal(state.catalog.listControlActions("run", "FINAL_REPAIR").length, 1);
	assert.equal(state.catalog.listOpenDecisionRequests("run").length, 0);
});

test("persistent final failure stops after its frozen repair budget and the limit survives scheduler reconstruction", async (context) => {
	const state = await fixture(context, { maxFinalRepairs: 2 });
	state.addTask("original");
	state.setVerification(async () => ({ state: "FAILED" }));
	assert.equal((await state.scheduler.runUntilSettled("run")).state, "BLOCKED");
	assert.equal(state.started.length, 3);
	assert.equal(state.catalog.listControlActions("run", "FINAL_REPAIR").length, 2);
	state.kernel.resumeRun("run", system);
	const next = new RunScheduler(state.kernel, state.catalog, state.executor, state.verifier, resources());
	assert.equal((await next.runUntilSettled("run")).state, "BLOCKED");
	assert.equal(state.started.length, 3);
});

for (const eventuallyPasses of [true, false]) {
	test(`final infrastructure checks retry on the same tree without writer work: recovery=${eventuallyPasses}`, async (context) => {
		const state = await fixture(context);
		state.addTask("original");
		state.setVerification(async () => ({ state: eventuallyPasses && state.verifyCount() === 3 ? "PASSED" : "ERROR" }));
		const result = await state.scheduler.runUntilSettled("run");
		assert.equal(result.state, eventuallyPasses ? "COMPLETED" : "BLOCKED");
		assert.equal(state.verifyCount(), 3);
		assert.deepEqual(state.started, ["original"]);
		assert.equal(state.catalog.listControlActions("run", "FINAL_INFRA_RETRY").length, 2);
		assert.equal(state.catalog.listControlActions("run", "FINAL_REPAIR").length, 0);
		assert.equal(state.catalog.listOpenDecisionRequests("run").length, 0);
	});
}

test("the failure-adaptation ablation retains final checks and blocks instead of starting a repair", async (context) => {
	const state = await fixture(context, { enableFailureAdaptation: false });
	state.addTask("original");
	state.setVerification(async () => ({ state: "FAILED" }));
	assert.equal((await state.scheduler.runUntilSettled("run")).state, "BLOCKED");
	assert.equal(state.verifyCount(), 1);
	assert.deepEqual(state.started, ["original"]);
	assert.equal(state.catalog.listControlActions("run", "FINAL_REPAIR").length, 0);
});

test("unresolved semantic decisions fence their ready task while independent work may continue", async (context) => {
	const state = await fixture(context);
	state.addTask("waiting");
	state.addTask("independent");
	state.kernel.createDecisionRequest({
		runId: "run",
		taskId: "waiting",
		kind: "REQUIREMENT_CHOICE",
		question: "Which externally visible behavior is intended?",
		options: ["A", "B"],
		actor: system,
	});
	assert.equal((await state.scheduler.runUntilSettled("run")).state, "BLOCKED");
	assert.deepEqual(state.started, ["independent"]);
	assert.equal(state.catalog.getTask("waiting").state, "BLOCKED");
	assert.equal(state.verifyCount(), 0);
});
