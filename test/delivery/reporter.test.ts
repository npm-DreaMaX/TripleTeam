import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ProjectPaths } from "../../src/config/paths.ts";
import { checkCommandVersion, evidenceClassForCheck } from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { DeliveryReporter } from "../../src/delivery/reporter.ts";
import { openControlDatabase } from "../../src/store/database.ts";
import { GitWorkspaceManager } from "../../src/workspace/git.ts";

const execFileAsync = promisify(execFile);
const check = {
	name: "final",
	argv: ["git", "status"],
	timeoutMs: 60_000,
	lane: "LIGHT_CHECK",
	evidenceClass: "BEHAVIORAL",
	oracle: { protectedPaths: ["oracle.py"] },
	isolation: { kind: "DOCKER", image: "sha256:" + "a".repeat(64) },
} as const;
const system = { kind: "SYSTEM", id: "test" } as const;

async function git(cwd: string, args: string[]): Promise<string> {
	return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

test("terminal runs materialize an idempotent Git delivery ref and evidence manifest", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "agent-runtime-delivery-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const repository = join(root, "repo");
	const state = join(root, "state");
	await mkdir(repository);
	await git(repository, ["init"]);
	await git(repository, ["config", "user.name", "Test User"]);
	await git(repository, ["config", "user.email", "test@example.com"]);
	await writeFile(join(repository, "file.txt"), "base\n");
	await git(repository, ["add", "file.txt"]);
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
	const snapshot = await workspaces.snapshot("delivery-run");
	const integrationRef = await workspaces.initializeIntegrationRef("delivery-run", snapshot.commitHash);
	const database = await openControlDatabase(paths.database);
	context.after(() => database.close());
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	kernel.createRun({
		id: "delivery-run",
		repositoryRoot: repository,
		objective: "Prove the terminal delivery projection",
		inputCommit: snapshot.commitHash,
		inputTreeHash: snapshot.treeHash,
		integrationRef,
		goalContract: { schema: "goal-contract/v1", runChecks: [check] },
		actor: system,
	});
	const taskId = kernel.createTask({
		id: "cancelled-task",
		runId: "delivery-run",
		title: "No-op",
		objective: "No longer needed",
		scope: [],
		constraints: [],
		acceptanceContract: { candidateChecks: [check], integrationChecks: [check], requireReview: false },
		riskClass: "LOW",
		actor: system,
	});
	const proposal = kernel.proposeTaskChanges({
		runId: "delivery-run",
		changes: {
			additions: [],
			revisions: [],
			dependencies: [],
			cancellations: [{ taskId, expectedVersion: 1, reason: "No change is required" }],
		},
		actor: system,
	});
	kernel.acceptTaskChanges(proposal, system);
	const treeHash = await workspaces.treeHash(snapshot.commitHash);
	kernel.recordCheckResult({
		runId: "delivery-run",
		subjectKind: "RUN",
		subjectId: "delivery-run",
		treeHash,
		checkKind: "final",
		checkVersion: checkCommandVersion(check),
		evidenceClass: evidenceClassForCheck(check),
		command: ["git", "status"],
		environmentHash: "test",
		state: "PASSED",
		actor: system,
	});
	kernel.completeRun({ runId: "delivery-run", treeHash }, system);

	const reporter = new DeliveryReporter(kernel, catalog, workspaces, paths);
	const first = await reporter.ensure("delivery-run");
	const second = await reporter.ensure("delivery-run");
	assert.deepEqual(second, first);
	assert.equal(first.result, "VERIFIED_DELIVERY");
	assert.equal(await workspaces.resolveRef(first.deliveryRef as string), snapshot.commitHash);
	const manifest = JSON.parse(await readFile(first.manifestPath, "utf8")) as {
		run: { result: string; finalTreeHash: string };
		evidence: { events: Array<{ type: string }> };
	};
	assert.equal(manifest.run.result, "VERIFIED_DELIVERY");
	assert.equal(manifest.run.finalTreeHash, treeHash);
	assert.ok(manifest.evidence.events.some((event) => event.type === "CheckPASSED"));
	assert.equal(database.sql.prepare("SELECT COUNT(*) AS count FROM run_reports").get<{ count: number }>()?.count, 1);
});
