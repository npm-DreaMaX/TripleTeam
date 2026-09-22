import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	type CheckCommand,
	checkCommandVersion,
	evidenceClassForCheck,
	loadProjectConfig,
	parseCheckCommand,
} from "../../src/config/project.ts";
import { LocalResourceGovernor } from "../../src/control/resource-governor.ts";
import { CheckRunner } from "../../src/verification/check-runner.ts";

const execFileAsync = promisify(execFile);
const pinnedImage = "sha256:" + "a".repeat(64);

async function git(cwd: string, args: string[]): Promise<string> {
	return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

async function fixture(context: test.TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-check-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const cwd = join(directory, "repo");
	await mkdir(cwd);
	await git(cwd, ["init"]);
	await git(cwd, ["config", "user.name", "Check Test"]);
	await git(cwd, ["config", "user.email", "checks@example.test"]);
	await writeFile(join(cwd, "value.txt"), "bad");
	await writeFile(join(cwd, "oracle.py"), "from pathlib import Path\nassert Path('value.txt').read_text() == 'good'\n");
	await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "python3 oracle.py" } }));
	await git(cwd, ["add", "."]);
	await git(cwd, ["commit", "-m", "base"]);
	const commit = await git(cwd, ["rev-parse", "HEAD"]);
	return {
		cwd,
		directory,
		runner: new CheckRunner(new LocalResourceGovernor()),
		common: {
			cwd,
			baseCommit: commit,
			subjectCommit: commit,
			runInputCommit: commit,
			artifactDirectory: join(directory, "evidence"),
		},
	};
}

function command(script: string, extra: Partial<CheckCommand> = {}): CheckCommand {
	return { name: "test", argv: [process.execPath, "-e", script], timeoutMs: 5_000, lane: "LIGHT_CHECK", ...extra };
}

test("check runner records output and distinguishes pass from failure", async (context) => {
	const { directory, runner, common } = await fixture(context);
	const passed = await runner.run(
		{
			name: "pass",
			argv: [process.execPath, "-e", "process.stdout.write('ok')"],
			timeoutMs: 5_000,
			lane: "LIGHT_CHECK",
		},
		common,
	);
	assert.equal(passed.state, "PASSED");
	assert.equal(await readFile(passed.stdoutPath, "utf8"), "ok");
	if (process.platform !== "win32") assert.equal((await stat(passed.stdoutPath)).mode & 0o777, 0o600);
	const failed = await runner.run(
		{ name: "fail", argv: [process.execPath, "-e", "process.exit(7)"], timeoutMs: 5_000, lane: "LIGHT_CHECK" },
		common,
	);
	assert.equal(failed.state, "FAILED");
	assert.equal(failed.exitCode, 7);
	const errored = await runner.run(
		{
			name: "missing-runtime",
			argv: [join(directory, "command-that-does-not-exist")],
			timeoutMs: 5_000,
			lane: "LIGHT_CHECK",
		},
		common,
	);
	assert.equal(errored.state, "ERROR");
	assert.equal(errored.exitCode, undefined);
});

test("check names and npm test detection never imply behavioral assurance", async (context) => {
	const { cwd } = await fixture(context);
	assert.equal(evidenceClassForCheck(command("", { name: "integration-e2e-test" })), "STRUCTURAL");
	assert.equal(evidenceClassForCheck(command("", { evidenceClass: "BEHAVIORAL" })), "BUILD");
	const configured = await loadProjectConfig(cwd);
	assert.equal(evidenceClassForCheck(configured.runChecks[0] as CheckCommand), "BUILD");
	await rm(join(cwd, "package.json"));
	const plain = await loadProjectConfig(cwd);
	assert.equal(plain.runChecks[0]?.name, "integration-diff-safety");
	assert.equal(evidenceClassForCheck(plain.runChecks[0] as CheckCommand), "STRUCTURAL");
});

test("check identity freezes oracle and isolation independently of object property order", () => {
	const check = command("", {
		evidenceClass: "BEHAVIORAL",
		oracle: { protectedPaths: ["oracle.py"] },
		isolation: { kind: "DOCKER", image: pinnedImage },
	});
	assert.equal(evidenceClassForCheck(check), "BEHAVIORAL");
	assert.equal(checkCommandVersion(check), checkCommandVersion(parseCheckCommand(check, "check")));
	assert.notEqual(
		checkCommandVersion(check),
		checkCommandVersion({ ...check, oracle: { protectedPaths: ["another.py"] } }),
	);
	assert.throws(
		() => parseCheckCommand({ ...check, isolation: { kind: "DOCKER", image: "python:latest" } }, "check"),
		/immutable/,
	);
	assert.throws(
		() => parseCheckCommand({ ...check, oracle: { protectedPaths: ["../oracle.py"] } }, "check"),
		/repository-relative/,
	);
});

test("a check cannot claim success after changing its source tree", async (context) => {
	const { runner, common } = await fixture(context);
	const result = await runner.run(
		command("require('node:fs').writeFileSync('value.txt', 'good'); console.log('passed')"),
		common,
	);
	assert.equal(result.state, "FAILED");
	assert.equal(result.result.errorCode, "TREE_MISMATCH");
	assert.match(await readFile(result.stdoutPath, "utf8"), /passed/);
});

test("restoring original bytes and mtime does not hide a source mutation", async (context) => {
	const { runner, common } = await fixture(context);
	const result = await runner.run(
		command(
			"const fs=require('node:fs'); const s=fs.statSync('value.txt'); fs.writeFileSync('value.txt','good'); fs.writeFileSync('value.txt','bad'); fs.utimesSync('value.txt',s.atime,s.mtime)",
		),
		common,
	);
	assert.equal(result.state, "FAILED");
	assert.equal(result.result.errorCode, "SOURCE_MUTATED");
	assert.equal(await readFile(join(common.cwd, "value.txt"), "utf8"), "bad");
});

test("a dirty view is rejected before invoking its command", async (context) => {
	const { cwd, runner, common } = await fixture(context);
	await writeFile(join(cwd, "value.txt"), "good");
	const result = await runner.run(command("console.log('must not execute')"), common);
	assert.equal(result.state, "FAILED");
	assert.equal(await readFile(result.stdoutPath, "utf8"), "");
});

test("a weakened test cannot satisfy the oracle frozen at run input", async (context) => {
	const { cwd, runner, common } = await fixture(context);
	await writeFile(join(cwd, "oracle.py"), "pass\n");
	await git(cwd, ["add", "."]);
	await git(cwd, ["commit", "-m", "weaken oracle"]);
	common.subjectCommit = await git(cwd, ["rev-parse", "HEAD"]);
	const result = await runner.run(
		command("console.log('must not execute')", { oracle: { protectedPaths: ["oracle.py"] } }),
		common,
	);
	assert.equal(result.state, "FAILED");
	assert.equal(result.result.errorCode, "ORACLE_CHANGED");
	assert.equal(await readFile(result.stdoutPath, "utf8"), "");
});

test("changing npm scripts cannot silently change a frozen check", async (context) => {
	const { cwd, runner, common } = await fixture(context);
	await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
	await git(cwd, ["add", "."]);
	await git(cwd, ["commit", "-m", "weaken launcher"]);
	common.subjectCommit = await git(cwd, ["rev-parse", "HEAD"]);
	const result = await runner.run(command("", { oracle: { protectedPaths: ["oracle.py"] } }), common);
	assert.equal(result.state, "FAILED");
	assert.equal(result.result.errorCode, "ORACLE_LAUNCHER_CHANGED");
});

test(
	"completed local checks terminate descendants before releasing the workspace",
	{ skip: process.platform === "win32" },
	async (context) => {
		const { directory, runner, common } = await fixture(context);
		const marker = join(directory, "orphan-marker");
		const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'orphan'), 300)`)}],{stdio:'ignore'}).unref()`;
		const result = await runner.run(command(script), common);
		assert.equal(result.state, "PASSED");
		await new Promise((resolve) => setTimeout(resolve, 450));
		await assert.rejects(access(marker));
	},
);

test(
	"pinned Docker verification checks the immutable source and prevents mutation",
	{ skip: !process.env.TRIPLETEAM_TEST_DOCKER_IMAGE },
	async (context) => {
		const { cwd, runner, common } = await fixture(context);
		const check: CheckCommand = {
			name: "oracle",
			argv: ["python3", "oracle.py"],
			timeoutMs: 20_000,
			lane: "LIGHT_CHECK",
			evidenceClass: "BEHAVIORAL",
			oracle: { protectedPaths: ["oracle.py"] },
			isolation: { kind: "DOCKER", image: process.env.TRIPLETEAM_TEST_DOCKER_IMAGE as string },
		};
		const bad = await runner.run(check, common);
		assert.equal(bad.state, "FAILED", await readFile(bad.stderrPath, "utf8"));
		const mutation = await runner.run(
			{
				...check,
				argv: [
					"python3",
					"-c",
					"from pathlib import Path; Path('value.txt').write_text('good'); exec(Path('oracle.py').read_text())",
				],
			},
			common,
		);
		assert.equal(mutation.state, "FAILED", await readFile(mutation.stderrPath, "utf8"));
		assert.match(await readFile(mutation.stderrPath, "utf8"), /Read-only file system|Permission denied/);
		assert.equal(await readFile(join(cwd, "value.txt"), "utf8"), "bad");
		await writeFile(join(cwd, "value.txt"), "good");
		await git(cwd, ["add", "."]);
		await git(cwd, ["commit", "-m", "fix implementation"]);
		common.subjectCommit = await git(cwd, ["rev-parse", "HEAD"]);
		const passed = await runner.run(check, common);
		assert.equal(passed.state, "PASSED", await readFile(passed.stderrPath, "utf8"));
		assert.equal(passed.result.integrity?.isolation, "DOCKER_READ_ONLY");
		assert.match(passed.result.integrity?.oracleVersion ?? "", /^[a-f0-9]{64}$/);
	},
);
