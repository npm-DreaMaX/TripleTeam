import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ProjectPaths } from "../../src/config/paths.ts";
import { type CheckCommand, loadProjectConfig } from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { LocalResourceGovernor } from "../../src/control/resource-governor.ts";
import { DeliveryReporter } from "../../src/delivery/reporter.ts";
import { openControlDatabase } from "../../src/store/database.ts";
import { CheckRunner } from "../../src/verification/check-runner.ts";
import { RunVerifier } from "../../src/verification/run-verifier.ts";
import { GitWorkspaceManager } from "../../src/workspace/git.ts";

const execFileAsync = promisify(execFile);
const system = { kind: "SYSTEM", id: "verification-test" } as const;

async function git(cwd: string, args: string[]): Promise<string> {
	return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

async function fixture(context: test.TestContext, checks?: CheckCommand[]) {
	const root = await mkdtemp(join(tmpdir(), "tripleteam-run-verifier-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const repository = join(root, "repo");
	const state = join(root, "state");
	await mkdir(repository);
	await git(repository, ["init"]);
	await git(repository, ["config", "user.name", "Check Test"]);
	await git(repository, ["config", "user.email", "check@example.test"]);
	await writeFile(join(repository, "value.txt"), "bad");
	await git(repository, ["add", "."]);
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
	const snapshot = await workspaces.snapshot("run");
	const integrationRef = await workspaces.initializeIntegrationRef("run", snapshot.commitHash);
	const config = await loadProjectConfig(repository);
	if (checks) config.runChecks = checks;
	const database = await openControlDatabase(paths.database);
	context.after(() => database.close());
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	kernel.createRun({
		id: "run",
		repositoryRoot: repository,
		objective: "Inspect the current repository",
		inputCommit: snapshot.commitHash,
		inputTreeHash: snapshot.treeHash,
		integrationRef,
		goalContract: { schema: "goal-contract/v1", runChecks: config.runChecks },
		actor: system,
	});
	const taskId = kernel.createTask({
		id: "task",
		runId: "run",
		title: "No change",
		objective: "Existing code satisfies this task",
		scope: [],
		constraints: [],
		acceptanceContract: {
			candidateChecks: config.candidateChecks,
			integrationChecks: config.integrationChecks,
			requireReview: false,
		},
		riskClass: "LOW",
		actor: system,
	});
	const proposal = kernel.proposeTaskChanges({
		runId: "run",
		changes: {
			additions: [],
			revisions: [],
			dependencies: [],
			cancellations: [{ taskId, expectedVersion: 1, reason: "No implementation required" }],
		},
		actor: system,
	});
	kernel.acceptTaskChanges(proposal, system);
	const verifier = new RunVerifier(
		kernel,
		catalog,
		workspaces,
		new CheckRunner(new LocalResourceGovernor()),
		paths,
		config,
	);
	return {
		kernel,
		catalog,
		workspaces,
		snapshot,
		verifier,
		reporter: new DeliveryReporter(kernel, catalog, workspaces, paths),
	};
}

test("the default diff gate yields structural handoff through the complete delivery path", async (context) => {
	const { kernel, verifier, reporter } = await fixture(context);
	const checked = await verifier.verify("run");
	assert.equal(checked.status, "PASSED");
	kernel.completeRun({ runId: "run", treeHash: checked.treeHash }, system);
	const delivery = await reporter.ensure("run");
	assert.equal(delivery.result, "STRUCTURAL_HANDOFF");
});

test("run verification cannot bind a check's repaired worktree to the original bad delivery tree", async (context) => {
	const check: CheckCommand = {
		name: "integration-test",
		argv: [process.execPath, "-e", "require('node:fs').writeFileSync('value.txt','good'); console.log('PASS')"],
		timeoutMs: 5_000,
		lane: "LIGHT_CHECK",
		evidenceClass: "BEHAVIORAL",
	};
	const { kernel, verifier, workspaces, snapshot } = await fixture(context, [check]);
	const checked = await verifier.verify("run");
	assert.equal(checked.status, "FAILED");
	assert.throws(() => kernel.completeRun({ runId: "run", treeHash: checked.treeHash }, system), /missing|failed|stale/);
	assert.equal(await git(workspaces.repositoryRoot, ["show", snapshot.commitHash + ":value.txt"]), "bad");
});

test("each final check receives a fresh source view", async (context) => {
	const checks: CheckCommand[] = [
		{
			name: "write-temp",
			argv: [process.execPath, "-e", "require('node:fs').writeFileSync('.ignored','artifact')"],
			timeoutMs: 5_000,
			lane: "LIGHT_CHECK",
		},
		{
			name: "read-temp",
			argv: [process.execPath, "-e", "if(require('node:fs').existsSync('.ignored')) process.exit(1)"],
			timeoutMs: 5_000,
			lane: "LIGHT_CHECK",
		},
	];
	const { verifier, workspaces } = await fixture(context, checks);
	// Only the repository's Git excludes govern generated files; checks must still use separate worktrees.
	await writeFile(join(workspaces.repositoryRoot, ".git", "info", "exclude"), ".ignored\n");
	const checked = await verifier.verify("run");
	assert.equal(checked.status, "PASSED");
	assert.equal(checked.checkIds.length, 2);
	assert.match(await readFile(join(workspaces.repositoryRoot, ".git", "info", "exclude"), "utf8"), /ignored/);
});
