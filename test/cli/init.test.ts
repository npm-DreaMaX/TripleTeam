import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
	await execFileAsync("git", ["-C", cwd, ...args]);
}

test("standalone CLI initializes and reads a repository run", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-cli-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const repository = join(directory, "repo");
	const state = join(directory, "state");
	await mkdir(repository);
	await git(repository, ["init"]);
	await git(repository, ["config", "user.name", "Test User"]);
	await git(repository, ["config", "user.email", "test@example.com"]);
	await writeFile(join(repository, "file.txt"), "base\n");
	await git(repository, ["add", "file.txt"]);
	await git(repository, ["commit", "-m", "initial"]);
	await writeFile(join(repository, "file.txt"), "dirty input\n");

	const environment = { ...process.env, TRIPLETEAM_STATE_DIR: state };
	const initialized = await execFileAsync(
		process.execPath,
		["--import", "tsx", "src/cli/main.ts", "init", repository],
		{ cwd: process.cwd(), env: environment, encoding: "utf8" },
	);
	const result = JSON.parse(initialized.stdout) as {
		runId: string;
		stateDirectory: string;
		capturedDirtyState: boolean;
	};
	assert.equal(result.capturedDirtyState, true);
	assert.ok(result.stateDirectory.startsWith(state));
	await access(join(result.stateDirectory, "state.db"));

	const status = await execFileAsync(
		process.execPath,
		["--import", "tsx", "src/cli/main.ts", "status", repository, result.runId],
		{ cwd: process.cwd(), env: environment, encoding: "utf8" },
	);
	const statusResult = JSON.parse(status.stdout) as { run: { id: string; state: string }; tasks: unknown[] };
	assert.equal(statusResult.run.id, result.runId);
	assert.equal(statusResult.run.state, "OPEN");
	assert.deepEqual(statusResult.tasks, []);
});
