import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { LocalOrchestrator } from "../../src/app/orchestrator.ts";
import { parseExecutionPolicy } from "../../src/config/execution.ts";
import { OperationJournal } from "../../src/control/operation-journal.ts";
import { TaskExecutor } from "../../src/control/task-executor.ts";
import { DomainInvariantError } from "../../src/domain/model.ts";
import { PiExplorer } from "../../src/exploration/explorer.ts";
import { PiPlanner } from "../../src/planning/plan.ts";
import { PiReviewer } from "../../src/review/reviewer.ts";
import {
	assertFrozenProfile,
	constrainProfileTools,
	type FrozenPiProfiles,
	freezePiProfiles,
	PiWorkerLauncher,
} from "../../src/runtime/pi/launcher.ts";
import { CheckRunner } from "../../src/verification/check-runner.ts";

const execFileAsync = promisify(execFile);
const names = { planner: "planner", explorer: "explorer", implementer: "implementer", reviewer: "reviewer" };
const readOnlyTools = ["read", "grep", "find", "ls"];
const mismatch = (error: unknown) =>
	error instanceof DomainInvariantError && error.code === "FROZEN_PI_PROFILE_MISMATCH";

test("profile identity freezes effective tools and model settings while preserving legacy run compatibility", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-frozen-profiles-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	context.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(directory, { recursive: true, force: true });
	});
	await mkdir(join(directory, "agents"));
	await writeFile(
		join(directory, "agents", "planner.md"),
		"---\nname: planner\ndescription: fixture\ntools: read, bash, edit\n---\nInspect before planning.\n",
	);
	const launcher = new PiWorkerLauncher();
	const execution = parseExecutionPolicy({ provider: "fixture", model: "model-a", reasoning: "high" });
	const piProfiles = freezePiProfiles(launcher, directory, names, execution);
	const profile = constrainProfileTools(
		launcher.resolveProfile(directory, names.planner, readOnlyTools, execution),
		readOnlyTools,
	);
	assert.deepEqual(profile.tools, ["read"]);
	assertFrozenProfile({ piProfiles }, "PLAN", profile);
	for (const override of [{ model: "model-b" }, { provider: "other" }, { reasoning: "low" as const }]) {
		const changed = constrainProfileTools(
			launcher.resolveProfile(directory, names.planner, readOnlyTools, { ...execution, ...override }),
			readOnlyTools,
		);
		assert.throws(() => assertFrozenProfile({ piProfiles }, "PLAN", changed), mismatch);
	}
	assert.throws(() => assertFrozenProfile({ piProfiles }, "PLAN", { ...profile, name: "replacement" }), mismatch);
	assert.throws(() => assertFrozenProfile({ piProfiles: {} }, "PLAN", profile), mismatch);
	assert.doesNotThrow(() => assertFrozenProfile({}, "PLAN", { ...profile, version: "legacy" }));
});

test("persisted run profiles reject changed external definitions before every fresh worker role", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-profile-resume-"));
	const repository = join(directory, "repo");
	const agentDirectory = join(directory, "pi");
	const previousPi = process.env.PI_CODING_AGENT_DIR;
	const previousState = process.env.TRIPLETEAM_STATE_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.TRIPLETEAM_STATE_DIR = join(directory, "state");
	let orchestrator: LocalOrchestrator | undefined;
	context.after(async () => {
		orchestrator?.close();
		if (previousPi === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousPi;
		if (previousState === undefined) delete process.env.TRIPLETEAM_STATE_DIR;
		else process.env.TRIPLETEAM_STATE_DIR = previousState;
		await rm(directory, { recursive: true, force: true });
	});
	await mkdir(repository);
	await mkdir(join(agentDirectory, "agents"), { recursive: true });
	const defineProfiles = async (prompt: string) => {
		for (const name of Object.values(names))
			await writeFile(
				join(agentDirectory, "agents", `${name}.md`),
				`---\nname: ${name}\ndescription: fixture\ntools: read, grep, bash, edit\n---\n${prompt}\n`,
			);
	};
	await defineProfiles("Original instructions.");
	await execFileAsync("git", ["init", repository]);
	await writeFile(join(repository, "source.txt"), "baseline\n");
	await execFileAsync("git", ["-C", repository, "add", "."]);
	await execFileAsync("git", [
		"-C",
		repository,
		"-c",
		"user.name=Profile Test",
		"-c",
		"user.email=test@localhost",
		"commit",
		"-m",
		"baseline",
	]);
	orchestrator = await LocalOrchestrator.open(repository);
	const initialized = await orchestrator.initialize("Implement source changes");
	const originalGoal = orchestrator.catalog.getRun(initialized.runId).goalContract as { piProfiles: FrozenPiProfiles };
	assert.deepEqual(Object.keys(originalGoal.piProfiles), ["PLAN", "EXPLORE", "IMPLEMENT", "REVIEW"]);
	assert.ok(Object.values(originalGoal.piProfiles).every((profile) => /^[a-f0-9]{64}$/.test(profile.version)));
	orchestrator.close();
	orchestrator = undefined;
	await defineProfiles("Changed instructions while the daemon was stopped.");
	orchestrator = await LocalOrchestrator.open(repository);
	const { kernel, catalog, workspaces, resources, paths, config, database } = orchestrator;
	assert.deepEqual(catalog.getRun(initialized.runId).goalContract, originalGoal);
	const taskId = kernel.createTask({
		runId: initialized.runId,
		title: "Change source",
		objective: "Update source.txt",
		scope: ["source.txt"],
		constraints: [],
		acceptanceContract: {
			candidateChecks: config.candidateChecks,
			integrationChecks: config.integrationChecks,
			requireReview: false,
		},
		riskClass: "LOW",
		actor: { kind: "SYSTEM", id: "profile-test" },
	});
	kernel.markTaskReady(taskId, { kind: "SYSTEM", id: "profile-test" });
	let workerStarts = 0;
	const launcher = new PiWorkerLauncher();
	launcher.create = async () => {
		workerStarts++;
		throw new Error("The offline profile test must not launch a worker");
	};
	const explorer = new PiExplorer(kernel, catalog, workspaces, launcher, resources, paths, config);
	const planner = new PiPlanner(kernel, catalog, workspaces, launcher, explorer, resources, paths, config);
	const reviewer = new PiReviewer(kernel, catalog, workspaces, launcher, resources, paths, config);
	const executor = new TaskExecutor(
		kernel,
		catalog,
		new OperationJournal(database),
		workspaces,
		launcher,
		reviewer,
		new CheckRunner(resources),
		resources,
		paths,
		config,
	);
	const common = { runId: initialized.runId, repositoryRoot: repository, objective: "Implement source changes" };
	await assert.rejects(planner.plan({ ...common, inputCommit: initialized.inputCommit }), mismatch);
	await assert.rejects(executor.execute(taskId), mismatch);
	await assert.rejects(
		explorer.explore({ ...common, taskId, baseCommit: initialized.inputCommit, question: "Inspect source" }),
		mismatch,
	);
	await assert.rejects(
		explorer.explore({
			...common,
			taskId,
			baseCommit: initialized.inputCommit,
			question: "Diagnose failure",
			purpose: "REPLAN",
		}),
		mismatch,
	);
	await assert.rejects(
		reviewer.review({
			...common,
			task: catalog.getTask(taskId),
			candidateId: "candidate",
			candidateCommit: initialized.inputCommit,
			baseCommit: initialized.inputCommit,
		}),
		mismatch,
	);
	assert.equal(workerStarts, 0);
	assert.equal(catalog.countAttempts(taskId), 0);
	assert.equal(database.sql.prepare("SELECT COUNT(*) AS count FROM attempts").get<{ count: number }>()?.count, 0);
});
