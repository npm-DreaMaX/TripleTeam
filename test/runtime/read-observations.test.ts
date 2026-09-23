import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { observationsUnchanged, ReadObservationCollector } from "../../src/runtime/pi/read-observations.ts";
import { GitWorkspaceManager } from "../../src/workspace/git.ts";

const exec = promisify(execFile);

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "tripleteam-observations-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	await mkdir(repo);
	const git = async (...args: string[]) => (await exec("git", ["-C", repo, ...args])).stdout.trim();
	await git("init");
	await git("config", "user.name", "Observations");
	await git("config", "user.email", "test@example.test");
	const commit = async (path: string, data: string) => {
		await writeFile(join(repo, path), data);
		await git("add", ".");
		await git("commit", "-m", path);
		return git("rev-parse", "HEAD");
	};
	const base = await commit("api.txt", "interface v1");
	const manager = await GitWorkspaceManager.open(repo, join(root, "worktrees"));
	return { repo, manager, base, commit, git };
}

function event(collector: ReadObservationCollector, toolName: string, path?: string) {
	collector.onEvent({
		type: "tool_execution_start",
		toolCallId: "call",
		toolName,
		args: path === undefined ? {} : { path },
	});
}

test("read footprints reuse unrelated changes and invalidate reads, absence and repository context", async (t) => {
	const { repo, manager, base, commit, git } = await fixture(t);
	const collector = new ReadObservationCollector(repo);
	event(collector, "read", "api.txt");
	event(collector, "read", "missing.txt");
	const observations = await collector.freeze(manager, base);
	assert.ok(observations);
	assert.equal(await observationsUnchanged(manager, await commit("other.txt", "unrelated"), observations), true);
	const changes = [
		["api.txt", "interface v2"],
		["api.txt", "interface v1"],
		["missing.txt", "exists"],
	];
	for (const [path, value] of changes) {
		const changed = await commit(path as string, value as string);
		assert.equal(
			await observationsUnchanged(manager, changed, observations),
			path === "api.txt" && value === "interface v1",
		);
	}
	const fresh = new ReadObservationCollector(repo);
	event(fresh, "read", "api.txt");
	const head = await git("rev-parse", "HEAD");
	const footprint = await fresh.freeze(manager, head);
	assert.ok(footprint);
	assert.equal(await observationsUnchanged(manager, await commit(".gitignore", "*.txt\n"), footprint), false);
});

test("directory searches, new nested instructions, symlinks and unsafe tools fail closed", async (t) => {
	const { repo, manager, base, commit, git } = await fixture(t);
	const search = new ReadObservationCollector(repo);
	event(search, "grep");
	const footprint = await search.freeze(manager, base);
	assert.ok(footprint);
	assert.equal(await observationsUnchanged(manager, await commit("other.txt", "new search match"), footprint), false);
	const reader = new ReadObservationCollector(repo);
	event(reader, "read", "api.txt");
	const readFootprint = await reader.freeze(manager, await git("rev-parse", "HEAD"));
	assert.ok(readFootprint);
	await mkdir(join(repo, "nested"));
	assert.equal(
		await observationsUnchanged(manager, await commit("nested/AGENTS.md", "new instructions"), readFootprint),
		false,
	);
	for (const [tool, path] of [
		["bash", "."],
		["read", "../outside"],
	]) {
		const unsafe = new ReadObservationCollector(repo);
		event(unsafe, tool as string, path);
		assert.equal(await unsafe.freeze(manager, base), null);
	}
	await symlink("api.txt", join(repo, "link.txt"));
	const linked = new ReadObservationCollector(repo);
	event(linked, "read", "link.txt");
	assert.equal(await linked.freeze(manager, base), null);
});
