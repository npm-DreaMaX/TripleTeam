import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalOrchestrator } from "../../src/app/orchestrator.ts";
import {
	artifactPatch,
	authoritativeArtifact,
	benchmarkGit,
	publishMilestoneTag,
} from "../../src/benchmark/artifact.ts";
import { compareFeatureBench, type ExperimentResults } from "../../src/benchmark/comparison.ts";
import { importFeatureBenchVerdicts } from "../../src/benchmark/evaluator.ts";
import {
	assertBenchmarkConfiguration,
	collectFeatureBench,
	exportFeatureBench,
	parseFeatureBenchTask,
} from "../../src/benchmark/featurebench.ts";
import { BenchmarkLedger } from "../../src/benchmark/ledger.ts";
import {
	BENCHMARK_REVISIONS,
	type BenchmarkManifest,
	freezeManifest,
	hashJson,
	readFrozenManifest,
	writeImmutableJson,
} from "../../src/benchmark/manifest.ts";
import { aggregateUsage, type BenchmarkTrial, summarizeTrials } from "../../src/benchmark/metrics.ts";
import { parseMilestoneQueue, readReleasedMilestones, runMilestoneStep } from "../../src/benchmark/milestone.ts";
import { runFeatureBench } from "../../src/benchmark/runner.ts";
import { checkCommandVersion } from "../../src/config/project.ts";

const system = { kind: "SYSTEM", id: "benchmark-contract-test" } as const;

test("paired comparison retains failure costs, rejects protocol drift and withholds missing-data claims", () => {
	const experiment = (model: string, results: boolean[]): ExperimentResults => {
		const frozen = freezeManifest({ ...manifest(), model });
		const trials = frozen.manifest.instanceIds.map(
			(instanceId): BenchmarkTrial => ({
				schema: "tripleteam-benchmark-trial/v1",
				manifestHash: frozen.sha256,
				instanceId,
				runId: instanceId,
				state: "SUBMITTED",
				deliveryResult: "STRUCTURAL_HANDOFF",
				commit: "c".repeat(40),
				tree: "e".repeat(40),
				startedAt: "2026-01-01T00:00:00Z",
				finishedAt: "2026-01-01T00:00:01Z",
				error: null,
				usage: { ...aggregateUsage([], 0), knownCostUsd: 1 },
			}),
		);
		return {
			frozen,
			trials,
			verdicts: trials.map((trial, index) => ({
				instanceId: trial.instanceId,
				manifestHash: frozen.sha256,
				tree: trial.tree as string,
				resolved: results[index] as boolean,
			})),
		};
	};
	const left = experiment("a", [true, true]),
		right = experiment("b", [true, false]);
	const compared = compareFeatureBench(left, right);
	assert.equal(compared.paired.resolveRateDifference, 0.5);
	assert.equal(compared.cost.leftCostPerResolvedUsd, 1);
	assert.equal(compared.cost.rightCostPerResolvedUsd, 2); // Failed attempts still cost money.
	assert.match(compared.interpretation, /Product-plus-model/);
	assert.ok(compared.paired.repositoryClusterBootstrap95);
	const incomplete = {
		...left,
		verdicts: left.verdicts.slice(1),
		trials: left.trials.map((t) => ({ ...t, usage: { ...t.usage, costComplete: false } })),
	};
	const missing = compareFeatureBench(incomplete, right);
	assert.equal(missing.paired.resolveRateDifference, null);
	assert.equal(missing.paired.repositoryClusterBootstrap95, null);
	assert.equal(missing.cost.totalDifferenceUsd, null);
	assert.throws(
		() =>
			compareFeatureBench(left, {
				...right,
				frozen: freezeManifest({ ...right.frozen.manifest, budget: { ...right.frozen.manifest.budget, costUsd: 11 } }),
			}),
		/same frozen/,
	);
});

function manifest(benchmark: "featurebench" | "swe-milestone" = "featurebench"): BenchmarkManifest {
	return {
		schema: "tripleteam-benchmark/v1",
		benchmark,
		evaluatorCommit: BENCHMARK_REVISIONS[benchmark],
		datasetRevision: "a".repeat(40),
		datasetDigest: "b".repeat(64),
		split: "offline-fixture",
		instanceIds: ["task-1", "task-2"],
		systemCommit: "c".repeat(40),
		model: "offline-fixture",
		provider: "fixture",
		replicate: "1",
		executionConfigHash: "d".repeat(64),
		budget: { costUsd: 10, tokens: 100_000, deadlineMs: 600_000, maxExecutions: 10 },
		protocol: {
			humanMode: "DISABLED",
			hiddenFeedback: "FORBIDDEN",
			submissionSelection: "FINAL",
			networkPolicy: "offline fixture",
			containerImages: { fixture: "example/image@sha256:" + "e".repeat(64) },
			...(benchmark === "swe-milestone" ? { earlyUnblock: true } : {}),
		},
		accounting: {
			priceSnapshot: "fixture only, not a pricing claim",
			costScope: "MODEL_API_ONLY",
			missingUsage: "UNKNOWN",
		},
	};
}

async function fixture(context: test.TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-benchmark-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const repository = join(directory, "repo");
	await mkdir(repository);
	await benchmarkGit(repository, ["init"]);
	await benchmarkGit(repository, ["config", "user.name", "Benchmark Test"]);
	await benchmarkGit(repository, ["config", "user.email", "benchmark@localhost"]);
	await writeFile(join(repository, "feature.txt"), "baseline\n");
	await writeFile(
		join(repository, ".tripleteam.json"),
		JSON.stringify({
			assurance: { mode: "off" }, // This fixture fabricates deliveries to test the evaluator adapter.
			execution: {
				decisionMode: "noninteractive",
				provider: "fixture",
				model: "offline-fixture",
				costLimitUsd: 10,
				tokenLimit: 100_000,
				deadlineMs: 600_000,
				maxExecutions: 10,
			},
		}),
	);
	await benchmarkGit(repository, ["add", "."]);
	await benchmarkGit(repository, ["commit", "-m", "Masked fixture baseline"]);
	const orchestrator = await LocalOrchestrator.open(repository);
	context.after(() => orchestrator.close());
	const initialized = await orchestrator.initialize("Implement fixture feature");
	const task = parseFeatureBenchTask({
		instance_id: "task-1",
		problem_statement: "Implement fixture feature",
		repo: "fixture/repository",
		image_name: "fixture",
		prepared_base_commit: initialized.inputCommit,
		prepared_base_tree: initialized.inputTree,
	});
	const input = manifest();
	input.executionConfigHash = hashJson(JSON.parse(JSON.stringify(orchestrator.config.execution)));
	return { directory, repository, orchestrator, initialized, task, input };
}

async function integrateFixture(orchestrator: LocalOrchestrator, runId: string, baseCommit: string) {
	const checks = orchestrator.config.candidateChecks;
	const taskId = orchestrator.kernel.createTask({
		runId,
		title: "Feature",
		objective: "Implement fixture",
		scope: ["feature.txt"],
		constraints: [],
		acceptanceContract: {
			candidateChecks: checks,
			integrationChecks: orchestrator.config.integrationChecks,
			requireReview: false,
		},
		riskClass: "LOW",
		actor: system,
	});
	orchestrator.kernel.markTaskReady(taskId, system);
	const attempt = orchestrator.kernel.startAttempt({
		taskId,
		baseCommit,
		profileName: "fixture",
		profileVersion: "1",
		actor: system,
	});
	const writer = await orchestrator.workspaces.createWorktree(attempt.attemptId, baseCommit);
	await writeFile(join(writer.path, "feature.txt"), "implemented\n");
	const sealed = await orchestrator.workspaces.sealCandidate(runId, writer, "Fixture implementation");
	const candidateId = orchestrator.kernel.submitCandidate({
		taskId,
		attemptId: attempt.attemptId,
		attemptEpoch: attempt.epoch,
		baseCommit,
		...sealed,
		actor: system,
	});
	for (const check of checks) {
		orchestrator.kernel.recordCheckResult({
			runId,
			subjectKind: "CANDIDATE",
			subjectId: candidateId,
			treeHash: sealed.treeHash,
			checkKind: check.name,
			checkVersion: checkCommandVersion(check),
			evidenceClass: "STRUCTURAL",
			command: check.argv,
			environmentHash: "offline-fixture",
			state: "PASSED",
			actor: system,
		});
	}
	orchestrator.kernel.markCandidateEligible(candidateId, system);
	const integrationId = orchestrator.kernel.queueIntegration({ candidateId, expectedHead: baseCommit, actor: system });
	const integrated = await orchestrator.workspaces.integrate({
		runId,
		integrationRef: orchestrator.catalog.getRun(runId).integrationRef,
		expectedHead: baseCommit,
		candidateCommit: sealed.commitHash,
	});
	orchestrator.kernel.commitIntegration({
		integrationId,
		resultCommit: integrated.commitHash,
		resultTreeHash: integrated.treeHash,
		actor: system,
	});
	await orchestrator.cancel(runId, "Fixture terminates without claiming benchmark success");
	return integrated;
}

test("manifest pins evaluator/data/images, detects tampering, and cannot overwrite frozen experiments", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-manifest-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const value = manifest();
	const frozen = freezeManifest(value);
	const path = join(directory, "manifest.json");
	await writeImmutableJson(path, frozen);
	assert.deepEqual(await readFrozenManifest(path), frozen);
	await writeImmutableJson(path, frozen);
	await assert.rejects(writeImmutableJson(path, { ...frozen, sha256: "tampered" }), /Immutable/);
	assert.throws(() => freezeManifest({ ...value, datasetRevision: "latest" }), /immutable/);
	assert.throws(() => freezeManifest({ ...value, evaluatorCommit: "f".repeat(40) }), /contract-tested/);
	assert.throws(
		() => freezeManifest({ ...value, protocol: { ...value.protocol, hiddenFeedback: "ALLOWED" } }),
		/feedback/,
	);
	await writeFile(path, JSON.stringify({ ...frozen, manifest: { ...value, model: "changed" } }));
	await assert.rejects(readFrozenManifest(path), /modified/);
});

test("full instance configuration pins check scope and preparation before any model invocation", async (context) => {
	const f = await fixture(context);
	const digest = hashJson(JSON.parse(JSON.stringify(f.orchestrator.config)));
	const frozen = freezeManifest({ ...f.input, runtimeConfigHashes: { "task-1": digest, "task-2": digest } });
	assertBenchmarkConfiguration(f.orchestrator, frozen, "task-1");
	f.orchestrator.config.integrationChecks = [
		{
			...f.orchestrator.config.integrationChecks[0],
			name: "weakened",
		} as (typeof f.orchestrator.config.integrationChecks)[number],
	];
	assert.throws(() => assertBenchmarkConfiguration(f.orchestrator, frozen, "task-1"), /checks, preparation/);
	assert.throws(
		() => freezeManifest({ ...f.input, runtimeConfigHashes: { "task-1": digest } }),
		/every planned instance/,
	);
	assert.equal(f.orchestrator.database.sql.prepare("SELECT COUNT(*) AS n FROM executions").get<{ n: number }>()?.n, 0);
});

test("FeatureBench export submits the integration tree, preserves failed runs, and excludes dirty user HEAD", async (context) => {
	const { directory, repository, orchestrator, initialized, task, input } = await fixture(context);
	const frozen = freezeManifest(input);
	await assert.rejects(authoritativeArtifact(orchestrator, initialized.runId), /open run/);
	const integrated = await integrateFixture(orchestrator, initialized.runId, initialized.inputCommit);
	await writeFile(join(repository, "feature.txt"), "unsubmitted user scratch work\n");
	const exported = await exportFeatureBench({
		orchestrator,
		runId: initialized.runId,
		task,
		frozen,
		outputDirectory: join(directory, "outputs"),
		startedAt: "2026-01-01T00:00:00.000Z",
		finishedAt: "2026-01-01T00:00:01.000Z",
	});
	assert.equal(exported.prediction.task_metadata.submitted_tree, integrated.treeHash);
	assert.equal(exported.prediction.success, false);
	assert.equal(exported.trial.state, "CANCELLED");
	assert.match(exported.prediction.model_patch, /\+implemented\n/);
	assert.doesNotMatch(exported.prediction.model_patch, /scratch/);
	assert.equal((await benchmarkGit(repository, ["rev-parse", "HEAD"])).trim(), initialized.inputCommit);
	const lines = (await collectFeatureBench(frozen, join(directory, "outputs")))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(lines.length, 2);
	assert.equal(lines[1].error, "MISSING_TRIAL");
	assert.equal(lines[1].model_patch, "");
	const evaluationDirectory = join(directory, "official-evaluator");
	const reportDirectory = join(evaluationDirectory, "eval_outputs", task.instance_id, "attempt-1");
	await mkdir(reportDirectory, { recursive: true });
	await writeFile(join(reportDirectory, "patch.diff"), exported.prediction.model_patch);
	await writeFile(
		join(reportDirectory, "report.json"),
		JSON.stringify({
			[task.instance_id]: {
				n_attempt: 1,
				resolved: true,
				featurebench_eval_completed: true,
			},
		}),
	);
	const imported = await importFeatureBenchVerdicts({
		frozen,
		predictionDirectory: join(directory, "outputs"),
		evaluationDirectory,
	});
	assert.equal(imported.verdicts[0]?.tree, integrated.treeHash);
	assert.deepEqual(imported.missingInstanceIds, ["task-2"]);
	await writeFile(join(reportDirectory, "patch.diff"), "a different candidate was evaluated");
	await assert.rejects(
		importFeatureBenchVerdicts({ frozen, predictionDirectory: join(directory, "outputs"), evaluationDirectory }),
		/another patch/,
	);
	await benchmarkGit(repository, ["update-ref", initialized.integrationRef, initialized.inputCommit]);
	await assert.rejects(authoritativeArtifact(orchestrator, initialized.runId), /disagrees/);
});

test("FeatureBench resumes a terminal mapped attempt without another model call or changing output timestamps", async (context) => {
	const { directory, orchestrator, initialized, task, input } = await fixture(context);
	const frozen = freezeManifest(input);
	const ledger = new BenchmarkLedger(orchestrator);
	ledger.register(frozen);
	ledger.attach(frozen.sha256, task.instance_id, initialized.runId, hashJson(task));
	await orchestrator.cancel(initialized.runId, "No provider calls in this fixture");
	const options = { orchestrator, task, frozen, outputDirectory: join(directory, "outputs") };
	const first = await runFeatureBench(options);
	const second = await runFeatureBench(options);
	assert.deepEqual(second, first);
	assert.equal(ledger.list(frozen.sha256).length, 1);
	assert.equal(first.trial.usage.agentExecutions, 0);
	assert.equal(first.trial.state, "CANCELLED");
});

test("public task boundary rejects evaluator answers and mismatched masked baseline", async (context) => {
	const { directory, orchestrator, initialized, task, input } = await fixture(context);
	assert.throws(() => parseFeatureBenchTask({ ...task, patch: "secret mask or solution" }), /non-public/);
	assert.throws(() => parseFeatureBenchTask({ ...task, FAIL_TO_PASS: ["hidden-test"] }), /non-public/);
	await orchestrator.cancel(initialized.runId, "fixture");
	await assert.rejects(
		exportFeatureBench({
			orchestrator,
			runId: initialized.runId,
			task: { ...task, prepared_base_tree: "a".repeat(40) },
			frozen: freezeManifest(input),
			outputDirectory: directory,
			startedAt: new Date().toISOString(),
		}),
		/tree/,
	);
});

test("official queue parser only reads released SRS paths and refuses outside symlinks", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-milestone-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const srs = join(directory, "srs");
	await mkdir(srs);
	const taskPath = join(srs, "task-1_SRS.md");
	const futurePath = join(srs, "future_SRS.md");
	await writeFile(taskPath, "Only this requirement was released");
	await writeFile(futurePath, "Future spec must not be read");
	const queue = `# Task Queue\n\n## Available Tasks\n- task-1: See SRS at ${taskPath}\n`;
	const queuePath = join(directory, "TASK_QUEUE.md");
	await writeFile(queuePath, queue);
	assert.deepEqual(
		(await readReleasedMilestones(queuePath)).map((task) => task.id),
		["task-1"],
	);
	assert.throws(() => parseMilestoneQueue(queue + `- task-1: See SRS at ${taskPath}\n`), /Duplicate/);
	const outside = join(directory, "evaluator-secret.md");
	await writeFile(outside, "Not public");
	await rm(taskPath);
	await symlink(outside, taskPath);
	await assert.rejects(readReleasedMilestones(queuePath), /escapes/);
});

test("milestone publication recovers from pending mapping, uses the integrated checkpoint, and tags do not move", async (context) => {
	const { directory, repository, orchestrator, initialized, input } = await fixture(context);
	const frozen = freezeManifest({
		...input,
		benchmark: "swe-milestone",
		evaluatorCommit: BENCHMARK_REVISIONS["swe-milestone"],
		protocol: { ...input.protocol, earlyUnblock: true },
	});
	const ledger = new BenchmarkLedger(orchestrator);
	ledger.register(frozen);
	ledger.campaign(frozen.sha256, initialized.inputCommit);
	ledger.attach(frozen.sha256, "task-1", initialized.runId, "public-input-fixture");
	const integrated = await integrateFixture(orchestrator, initialized.runId, initialized.inputCommit);
	// Queue is deliberately absent: replaying a persisted publication must not consult hidden/new specs.
	const result = await runMilestoneStep({
		orchestrator,
		frozen,
		queuePath: join(directory, "absent.md"),
		outputDirectory: join(directory, "outputs"),
	});
	assert.equal(result.state, "SUBMITTED");
	assert.equal(ledger.campaign(frozen.sha256, initialized.inputCommit).currentHead, integrated.commitHash);
	assert.equal((await benchmarkGit(repository, ["rev-parse", "agent-impl-task-1"])).trim(), integrated.commitHash);
	assert.equal(await publishMilestoneTag(repository, "task-1", integrated.commitHash), "refs/tags/agent-impl-task-1");
	await assert.rejects(publishMilestoneTag(repository, "task-1", initialized.inputCommit), /another artifact/);
	const artifact = await authoritativeArtifact(orchestrator, initialized.runId);
	assert.match(await artifactPatch(repository, initialized.inputCommit, artifact), /implemented/);
	assert.equal(
		JSON.parse(await readFile(join(directory, "outputs", "task-1", "trial.json"), "utf8")).tree,
		integrated.treeHash,
	);
	const queueRoot = join(directory, "public-queue");
	await mkdir(join(queueRoot, "srs"), { recursive: true });
	const releasedPath = join(queueRoot, "srs", "task-2_SRS.md");
	await writeFile(releasedPath, "Continue the feature from the current own code");
	const queuePath = join(queueRoot, "TASK_QUEUE.md");
	await writeFile(queuePath, `# Task Queue\n\n## Available Tasks\n- task-2: See SRS at ${releasedPath}\n`);
	orchestrator.kernel.recordUsage({
		runId: initialized.runId,
		kind: "AGENT",
		phase: "fixture-budget",
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		inputTokens: 100,
		outputTokens: 20,
		costUsd: 0.5,
		details: { complete: true },
	});
	context.mock.method(orchestrator, "continue", async () => {
		throw new Error("Injected pre-provider failure: no model is called in this test");
	});
	const next = await runMilestoneStep({ orchestrator, frozen, queuePath, outputDirectory: join(directory, "outputs") });
	assert.equal(next.state, "SUBMITTED");
	const nextMapping = ledger.get(frozen.sha256, "task-2");
	assert.ok(nextMapping);
	const nextRun = orchestrator.catalog.getRun(nextMapping.run_id);
	assert.equal(nextRun.inputCommit, integrated.commitHash);
	assert.equal((await benchmarkGit(repository, ["show", nextRun.inputCommit + ":feature.txt"])).trim(), "implemented");
	const nextPolicy = (nextRun.goalContract as { executionPolicy: { costLimitUsd: number; tokenLimit: number } })
		.executionPolicy;
	assert.equal(nextPolicy.costLimitUsd, 9.5);
	assert.equal(nextPolicy.tokenLimit, 99_880);
	assert.equal(nextRun.state, "CANCELLED");
});

test("summary includes failed/missing goals, rejects hidden best-of selection and mismatched evaluator trees", () => {
	const frozen = freezeManifest(manifest());
	const usage = aggregateUsage(
		[
			{
				kind: "AGENT",
				phase: "failed-implementation",
				duration_ms: 200,
				input_tokens: 100,
				output_tokens: 20,
				cache_read_tokens: 0,
				cache_write_tokens: 0,
				cost_usd: 0.5,
				tool_calls: 2,
				details_json: "{}",
			},
		],
		2,
	);
	assert.equal(usage.costComplete, false);
	assert.equal(usage.knownCostUsd, 0.5);
	const trial: BenchmarkTrial = {
		schema: "tripleteam-benchmark-trial/v1",
		manifestHash: frozen.sha256,
		instanceId: "task-1",
		runId: "run",
		state: "BLOCKED",
		deliveryResult: "BLOCKED",
		commit: "c".repeat(40),
		tree: "f".repeat(40),
		startedAt: "2026-01-01T00:00:00Z",
		finishedAt: "2026-01-01T00:00:01Z",
		error: "failed",
		usage,
	};
	const summary = summarizeTrials(
		frozen,
		[trial],
		[{ instanceId: "task-1", manifestHash: frozen.sha256, tree: trial.tree as string, resolved: true }],
	);
	assert.deepEqual(summary.missingInstanceIds, ["task-2"]);
	assert.equal(summary.resolveRateLowerBound, 0.5);
	assert.equal(summary.costPerResolvedUsd, null);
	assert.equal(summary.knownCostUsd, 0.5);
	assert.throws(() => summarizeTrials(frozen, [trial, trial]), /Repeated/);
	assert.throws(
		() =>
			summarizeTrials(
				frozen,
				[trial],
				[{ instanceId: "task-1", manifestHash: frozen.sha256, tree: "another-tree", resolved: true }],
			),
		/exact submitted tree/,
	);
});
