import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "../../src/config/paths.ts";
import type { CheckCommand, ProjectConfig } from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { OperationJournal } from "../../src/control/operation-journal.ts";
import { LocalResourceGovernor } from "../../src/control/resource-governor.ts";
import { TaskExecutor, verificationDisposition } from "../../src/control/task-executor.ts";
import type { PiReviewer } from "../../src/review/reviewer.ts";
import type { ManagedPiWorker, PiWorkerLauncher, PiWorkerRequest } from "../../src/runtime/pi/launcher.ts";
import { openControlDatabase } from "../../src/store/database.ts";
import { CheckRunner } from "../../src/verification/check-runner.ts";
import { GitWorkspaceManager } from "../../src/workspace/git.ts";

const execFileAsync = promisify(execFile);

test("verification infrastructure errors block without consuming a code retry", () => {
	assert.deepEqual(verificationDisposition("ERROR", true), { retryTask: false, outcome: "BLOCKED" });
	assert.deepEqual(verificationDisposition("FAILED", true), { retryTask: true, outcome: "RETRY" });
	assert.deepEqual(verificationDisposition("FAILED", false), { retryTask: false, outcome: "BLOCKED" });
});

async function git(cwd: string, args: string[]): Promise<string> {
	return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

test("task executor accepts only after immutable candidate and post-integration checks", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "tripleteam-executor-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const repository = join(root, "repo");
	const state = join(root, "state");
	await mkdir(repository);
	await git(repository, ["init"]);
	await git(repository, ["config", "user.name", "Test User"]);
	await git(repository, ["config", "user.email", "test@example.com"]);
	await writeFile(join(repository, "base.txt"), "base\n");
	await git(repository, ["add", "base.txt"]);
	await git(repository, ["commit", "-m", "base"]);
	const paths: ProjectPaths = {
		root: state,
		database: join(state, "state.db"),
		worktrees: join(state, "worktrees"),
		sessions: join(state, "sessions"),
		artifacts: join(state, "artifacts"),
		logs: join(state, "logs"),
		daemon: join(state, "daemon.json"),
	};
	const workspaces = await GitWorkspaceManager.open(repository, paths.worktrees);
	const snapshot = await workspaces.snapshot("run-1");
	const integrationRef = await workspaces.initializeIntegrationRef("run-1", snapshot.commitHash);
	const database = await openControlDatabase(paths.database);
	context.after(() => database.close());
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	const check: CheckCommand = {
		name: "diff-safety",
		argv: ["git", "diff", "--check", "$BASE", "$SUBJECT"],
		timeoutMs: 5_000,
		lane: "LIGHT_CHECK",
	};
	const config: ProjectConfig = {
		maxAttemptsPerTask: 2,
		maxPlannerExplorations: 3,
		workerTimeoutMs: 5_000,
		candidateChecks: [check],
		integrationChecks: [check],
		runChecks: [check],
		reviewRequiredFor: ["HIGH"],
		profiles: { explorer: "explorer", planner: "planner", implementer: "implementer", reviewer: "reviewer" },
	};
	kernel.createRun({
		id: "run-1",
		repositoryRoot: repository,
		objective: "Add feature",
		inputCommit: snapshot.commitHash,
		integrationRef,
		actor: { kind: "USER", id: "user" },
	});
	kernel.createTask({
		id: "task-1",
		runId: "run-1",
		title: "Add feature",
		objective: "Create feature.txt",
		scope: ["feature.txt"],
		constraints: [],
		acceptanceContract: { candidateChecks: [check], integrationChecks: [check], requireReview: false },
		riskClass: "NORMAL",
		actor: { kind: "USER", id: "user" },
	});
	kernel.markTaskReady("task-1", { kind: "SYSTEM", id: "scheduler" });
	const priorOutput = join(state, "prior-check.log");
	await mkdir(state, { recursive: true });
	await writeFile(priorOutput, "AssertionError: expected validation error\n");
	kernel.startAttempt({
		id: "attempt-prior",
		taskId: "task-1",
		baseCommit: snapshot.commitHash,
		profileName: "implementer",
		profileVersion: "fake-profile",
		actor: { kind: "SYSTEM", id: "scheduler" },
	});
	kernel.failAttempt({
		attemptId: "attempt-prior",
		reason: "Prior implementation did not satisfy validation",
		retryTask: true,
		actor: { kind: "SYSTEM", id: "task-executor" },
	});
	kernel.recordCheckResult({
		runId: "run-1",
		taskId: "task-1",
		subjectKind: "CANDIDATE",
		subjectId: "candidate-prior",
		treeHash: snapshot.treeHash,
		checkKind: "focused-validation",
		checkVersion: "1",
		command: ["npm", "test"],
		environmentHash: "test",
		state: "FAILED",
		exitCode: 1,
		stdoutPath: priorOutput,
		actor: { kind: "SYSTEM", id: "verification-service" },
	});

	const rpcState = {
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "fake",
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
	} as RpcSessionState;
	const prompts: string[] = [];
	const launcher = {
		resolveProfile: (_cwd: string, name: string, tools: string[]) => ({
			name,
			systemPrompt: "",
			tools,
			version: "fake-profile",
		}),
		create: async (request: PiWorkerRequest): Promise<ManagedPiWorker> => ({
			profileVersion: "fake-profile",
			worker: {
				start: async () => rpcState,
				run: async (prompt: string) => {
					prompts.push(prompt);
					await writeFile(join(request.cwd, "feature.txt"), "implemented\n");
					return {
						state: rpcState,
						lastAssistantText: "implemented",
						usage: {
							inputTokens: 10,
							outputTokens: 5,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							costUsd: 0,
							toolCalls: 1,
						},
					};
				},
				steer: async () => undefined,
				followUp: async () => undefined,
				abort: async () => undefined,
				state: async () => rpcState,
				stop: async () => undefined,
			},
			close: async () => undefined,
		}),
	} as PiWorkerLauncher;
	const resources = new LocalResourceGovernor();
	const executor = new TaskExecutor(
		kernel,
		catalog,
		new OperationJournal(database),
		workspaces,
		launcher,
		{} as PiReviewer,
		new CheckRunner(resources),
		resources,
		paths,
		config,
	);
	assert.equal(await executor.execute("task-1"), "ACCEPTED");
	assert.match(prompts[0] ?? "", /Prior implementation did not satisfy validation/);
	assert.match(prompts[0] ?? "", /AssertionError: expected validation error/);
	const acceptedAttempt = database.sql
		.prepare(
			"SELECT predecessor_attempt_id FROM attempts WHERE task_id = 'task-1' AND workflow_function = 'IMPLEMENT' ORDER BY epoch DESC LIMIT 1",
		)
		.get<{ predecessor_attempt_id: string | null }>();
	assert.equal(acceptedAttempt?.predecessor_attempt_id, "attempt-prior");
	assert.equal(kernel.getTask("task-1").state, "ACCEPTED");
	const head = await workspaces.resolveRef(integrationRef);
	assert.equal(await git(repository, ["show", head + ":feature.txt"]), "implemented");
	assert.equal(
		database.sql
			.prepare("SELECT COUNT(*) AS count FROM check_runs WHERE subject_kind = 'INTEGRATION' AND state = 'PASSED'")
			.get<{ count: number }>()?.count,
		1,
	);
	assert.equal(database.sql.prepare("SELECT COUNT(*) AS count FROM artifacts").get<{ count: number }>()?.count, 4);
	assert.equal(
		database.sql
			.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE length(content_hash) = 64")
			.get<{ count: number }>()?.count,
		4,
	);
});
