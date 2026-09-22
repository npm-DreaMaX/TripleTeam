import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { CheckCommand, ProjectConfig } from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { OperationJournal } from "../../src/control/operation-journal.ts";
import { Reconciler } from "../../src/control/reconciler.ts";
import { openControlDatabase } from "../../src/store/database.ts";
import { GitWorkspaceManager } from "../../src/workspace/git.ts";

const execFileAsync = promisify(execFile);
const system = { kind: "SYSTEM", id: "test" } as const;
const check: CheckCommand = {
	name: "diff-safety",
	argv: ["git", "diff", "--check", "$BASE", "$SUBJECT"],
	timeoutMs: 60_000,
	lane: "LIGHT_CHECK",
};

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	return result.stdout.trim();
}

const config: ProjectConfig = {
	maxAttemptsPerTask: 3,
	maxPlannerExplorations: 3,
	workerTimeoutMs: 60_000,
	candidateChecks: [],
	integrationChecks: [],
	runChecks: [],
	reviewRequiredFor: [],
	profiles: {
		explorer: "explorer",
		planner: "planner",
		implementer: "implementer",
		reviewer: "reviewer",
	},
};

test("reconciler preserves a recoverable implementation attempt and fences only its lost execution", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "tripleteam-reconcile-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const repository = join(root, "repo");
	await mkdir(repository);
	await git(repository, ["init"]);
	await git(repository, ["config", "user.name", "Test User"]);
	await git(repository, ["config", "user.email", "test@example.com"]);
	await writeFile(join(repository, "tracked.txt"), "base\n");
	await git(repository, ["add", "tracked.txt"]);
	await git(repository, ["commit", "-m", "initial"]);

	const workspaces = await GitWorkspaceManager.open(repository, join(root, "state", "worktrees"));
	const snapshot = await workspaces.snapshot("run-1");
	const integrationRef = await workspaces.initializeIntegrationRef("run-1", snapshot.commitHash);
	const database = await openControlDatabase(":memory:");
	context.after(() => database.close());
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	const journal = new OperationJournal(database);
	kernel.createRun({
		id: "run-1",
		repositoryRoot: repository,
		inputCommit: snapshot.commitHash,
		integrationRef,
		actor: system,
	});
	kernel.createTask({
		id: "task-1",
		runId: "run-1",
		title: "Recover work",
		objective: "Continue after a control-plane restart",
		scope: ["tracked.txt"],
		constraints: [],
		acceptanceContract: { candidateChecks: [check], integrationChecks: [check], requireReview: false },
		riskClass: "LOW",
		actor: system,
	});
	kernel.markTaskReady("task-1", system);
	const attempt = kernel.startAttempt({
		id: "attempt-1",
		taskId: "task-1",
		baseCommit: snapshot.commitHash,
		profileName: "implementer",
		profileVersion: "profile-v1",
		actor: system,
	});
	await workspaces.createWorktree(attempt.attemptId, snapshot.commitHash);
	const executionId = kernel.createExecution({
		id: "execution-1",
		attemptId: attempt.attemptId,
		piSessionId: "pi-session-1",
		contextManifestHash: "manifest-v1",
		actor: system,
	});
	kernel.markExecutionLive({ executionId, sessionFile: join(root, "session.jsonl"), actor: system });

	const reconciler = new Reconciler(database, kernel, catalog, journal, workspaces, config);
	const report = await reconciler.reconcile("run-1");

	assert.deepEqual(report.resumableAttemptIds, [attempt.attemptId]);
	assert.equal(report.lostExecutions, 1);
	assert.equal(report.failedAttempts, 0);
	assert.equal(catalog.getAttempt(attempt.attemptId).state, "RUNNING");
	assert.equal(kernel.getTask("task-1").state, "ACTIVE");
	assert.equal(
		database.sql.prepare("SELECT state FROM executions WHERE id = ?").get<{ state: string }>(executionId)?.state,
		"LOST",
	);
});
