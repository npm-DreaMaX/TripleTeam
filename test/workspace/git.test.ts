import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GitWorkspaceManager } from "../../src/workspace/git.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	return result.stdout.trim();
}

async function repositoryFixture(context: test.TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-git-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const repository = join(directory, "repo");
	const worktrees = join(directory, "runtime-state", "worktrees");
	await mkdir(repository);
	await git(repository, ["init"]);
	await git(repository, ["config", "user.name", "Test User"]);
	await git(repository, ["config", "user.email", "test@example.com"]);
	await writeFile(join(repository, "tracked.txt"), "base\n");
	await git(repository, ["add", "tracked.txt"]);
	await git(repository, ["commit", "-m", "initial"]);
	const manager = await GitWorkspaceManager.open(repository, worktrees);
	return { repository, worktrees, manager };
}

test("snapshot captures dirty and untracked files without changing the user worktree", async (context) => {
	const { repository, manager } = await repositoryFixture(context);
	await writeFile(join(repository, "tracked.txt"), "dirty\n");
	await writeFile(join(repository, "untracked.txt"), "new\n");
	const statusBefore = await git(repository, ["status", "--porcelain"]);

	const snapshot = await manager.snapshot("run-1");

	assert.equal(snapshot.dirty, true);
	assert.equal(await git(repository, ["show", snapshot.commitHash + ":tracked.txt"]), "dirty");
	assert.equal(await git(repository, ["show", snapshot.commitHash + ":untracked.txt"]), "new");
	assert.equal(await git(repository, ["status", "--porcelain"]), statusBefore);
});

test("writer worktree seals an immutable candidate and integrates by CAS", async (context) => {
	const { repository, manager } = await repositoryFixture(context);
	const snapshot = await manager.snapshot("run-1");
	const worktree = await manager.createWorktree("attempt-1", snapshot.commitHash);
	await writeFile(join(worktree.path, "tracked.txt"), "implemented\n");

	const candidate = await manager.sealCandidate("run-1", worktree, "Implement feature");
	assert.deepEqual(candidate.changedPaths, ["tracked.txt"]);
	assert.equal(await git(repository, ["show", candidate.commitHash + ":tracked.txt"]), "implemented");

	const integrationRef = "refs/tripleteam/runs/run-1/integration";
	await git(repository, ["update-ref", integrationRef, snapshot.commitHash]);
	const integrated = await manager.integrate({
		runId: "run-1",
		integrationRef,
		expectedHead: snapshot.commitHash,
		candidateCommit: candidate.commitHash,
	});
	assert.equal(await git(repository, ["rev-parse", integrationRef]), integrated.commitHash);
	assert.equal(await git(repository, ["show", integrated.commitHash + ":tracked.txt"]), "implemented");

	await manager.removeWorktree(worktree);
	await assert.rejects(() => readFile(join(worktree.path, "tracked.txt")));
});

test("prepared integration stays unpublished until the explicit CAS boundary", async (context) => {
	const { manager } = await repositoryFixture(context);
	const snapshot = await manager.snapshot("run-2");
	const writer = await manager.createWorktree("attempt-2", snapshot.commitHash);
	await writeFile(join(writer.path, "tracked.txt"), "candidate\n");
	const candidate = await manager.sealCandidate("run-2", writer, "candidate");
	const integrationRef = await manager.initializeIntegrationRef("run-2", snapshot.commitHash);
	const prepared = await manager.prepareIntegration({
		runId: "run-2",
		integrationRef,
		expectedHead: snapshot.commitHash,
		candidateCommit: candidate.commitHash,
	});
	assert.equal(await manager.resolveRef(integrationRef), snapshot.commitHash);
	assert.notEqual(prepared.commitHash, snapshot.commitHash);
	await manager.publishIntegration({
		integrationRef,
		expectedHead: snapshot.commitHash,
		resultCommit: prepared.commitHash,
	});
	assert.equal(await manager.resolveRef(integrationRef), prepared.commitHash);
	await manager.removeWorktree(writer);
});
