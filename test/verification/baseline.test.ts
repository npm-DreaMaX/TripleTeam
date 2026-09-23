import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { projectPaths } from "../../src/config/paths.ts";
import { type CheckCommand, parseProjectConfig } from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { LocalResourceGovernor } from "../../src/control/resource-governor.ts";
import { openControlDatabase } from "../../src/store/database.ts";
import { BaselineVerifier } from "../../src/verification/baseline.ts";
import { CheckRunner } from "../../src/verification/check-runner.ts";
import { GitWorkspaceManager } from "../../src/workspace/git.ts";

const exec = promisify(execFile);

async function fixture(t: test.TestContext, argv: string[], enabled = true) {
	const root = await mkdtemp(join(tmpdir(), "tripleteam-baseline-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	await mkdir(repo);
	const git = async (...args: string[]) => (await exec("git", ["-C", repo, ...args])).stdout.trim();
	await git("init");
	await git("config", "user.name", "Baseline");
	await git("config", "user.email", "test@example.test");
	await writeFile(join(repo, "value.txt"), "initial");
	await git("add", ".");
	await git("commit", "-m", "baseline");
	const paths = projectPaths(repo, { TRIPLETEAM_STATE_DIR: join(root, "state") });
	const workspaces = await GitWorkspaceManager.open(repo, paths.worktrees);
	const snapshot = await workspaces.snapshot("run");
	const check: CheckCommand = { name: "regression", argv, timeoutMs: 5000, lane: "LIGHT_CHECK" };
	const config = parseProjectConfig({ integrationChecks: [check], runChecks: [check] }, [check]);
	const database = await openControlDatabase(paths.database);
	t.after(() => database.close());
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	kernel.createRun({
		id: "run",
		repositoryRoot: repo,
		objective: "Implement a feature",
		inputCommit: snapshot.commitHash,
		inputTreeHash: snapshot.treeHash,
		integrationRef: await workspaces.initializeIntegrationRef("run", snapshot.commitHash),
		goalContract: {
			...(enabled ? { baselinePolicy: config.baseline } : {}),
			runChecks: [check],
			taskAcceptancePolicy: {
				candidateChecks: config.candidateChecks,
				integrationChecks: [check],
				reviewRequiredFor: [],
			},
		},
		actor: { kind: "SYSTEM", id: "test" },
	});
	return {
		database,
		catalog,
		kernel,
		verifier: new BaselineVerifier(
			kernel,
			catalog,
			workspaces,
			new CheckRunner(new LocalResourceGovernor()),
			paths,
			config,
		),
	};
}

test("baseline failures inform planning, are cached on recovery, and cannot pass final gates", async (t) => {
	const { verifier, catalog, database } = await fixture(t, [process.execPath, "-e", "process.exit(1)"]);
	const receipt = await verifier.verify("run");
	assert.equal(receipt?.checks[0]?.state, "FAILED");
	assert.deepEqual(await verifier.verify("run"), receipt);
	assert.equal(catalog.listControlActions("run").filter((a) => a.kind === "BASELINE_STARTED").length, 1);
	const rows = database.sql.prepare("SELECT check_kind FROM check_runs").all<{ check_kind: string }>();
	assert.deepEqual(
		rows.map((row) => row.check_kind),
		["baseline:regression"],
	);
	assert.equal(database.sql.prepare("SELECT COUNT(*) AS n FROM executions").get<{ n: number }>()?.n, 0);
});

test("broken baseline environments stop before model compute; old runs keep their protocol", async (t) => {
	const runtimeDirectory = await mkdtemp(join(tmpdir(), "tripleteam-prepared-runtime-"));
	t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
	const executable = join(runtimeDirectory, "check");
	const { verifier, database } = await fixture(t, [executable]);
	await assert.rejects(verifier.verify("run"), /Baseline environment/);
	await assert.rejects(verifier.verify("run"), /Baseline environment/);
	await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	assert.equal((await verifier.verify("run"))?.checks[0]?.state, "PASSED");
	assert.equal(database.sql.prepare("SELECT COUNT(*) AS n FROM executions").get<{ n: number }>()?.n, 0);
	assert.equal(await (await fixture(t, ["/missing-tripleteam-runtime"], false)).verifier.verify("run"), null);
});
