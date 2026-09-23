import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { modelSelectionFor } from "../../src/config/execution.ts";
import { evidenceClassForCheck, loadProjectConfig } from "../../src/config/project.ts";
import { LocalResourceGovernor } from "../../src/control/resource-governor.ts";
import { freezePiProfiles, PiWorkerLauncher } from "../../src/runtime/pi/launcher.ts";
import { assurancePolicyFor, parseAssurancePolicy } from "../../src/verification/assurance-types.ts";
import { CheckRunner } from "../../src/verification/check-runner.ts";

const execFileAsync = promisify(execFile);
const pinnedImage = "sha256:" + "a".repeat(64);

async function directory(context: TestContext, files: Record<string, string> = {}) {
	const root = await mkdtemp(join(tmpdir(), "tripleteam-config-assurance-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "repo");
	await mkdir(cwd);
	for (const [name, contents] of Object.entries(files)) await writeFile(join(cwd, name), contents);
	return { root, cwd };
}

async function git(cwd: string, args: string[]): Promise<string> {
	return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

async function committed(context: TestContext, files: Record<string, string>) {
	const paths = await directory(context, files);
	await git(paths.cwd, ["init"]);
	await git(paths.cwd, ["config", "user.name", "Config Test"]);
	await git(paths.cwd, ["config", "user.email", "config@example.test"]);
	await git(paths.cwd, ["add", "."]);
	await git(paths.cwd, ["commit", "-m", "baseline"]);
	const commit = await git(paths.cwd, ["rev-parse", "HEAD"]);
	return {
		...paths,
		context: {
			cwd: paths.cwd,
			baseCommit: commit,
			subjectCommit: commit,
			runInputCommit: commit,
			artifactDirectory: join(paths.root, "evidence"),
		},
	};
}

function syntheticEnvironment(context: TestContext, values: Record<string, string>) {
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	context.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

test("project checks detect declared npm, Rust, Go and Python test entry points", async (context) => {
	const python = ["python3", "-B", "-m", "pytest", "-q", "-p", "no:cacheprovider"];
	const cases: Array<{ name: string; files: Record<string, string>; argv: string[][] }> = [
		{
			name: "npm check",
			files: { "package.json": JSON.stringify({ scripts: { check: "tsc" } }) },
			argv: [["npm", "run", "check"]],
		},
		{
			name: "npm test",
			files: { "package.json": JSON.stringify({ scripts: { test: "node --test", check: false } }) },
			argv: [["npm", "test"]],
		},
		{
			name: "Cargo",
			files: { "Cargo.toml": '[package]\nname = "fixture"\nversion = "0.1.0"\n' },
			argv: [["cargo", "test", "--locked"]],
		},
		{ name: "Go", files: { "go.mod": "module example.test/fixture\n\ngo 1.23\n" }, argv: [["go", "test", "./..."]] },
		{ name: "pytest.ini", files: { "pytest.ini": "[pytest]\n" }, argv: [python] },
		{
			name: "pyproject pytest options",
			files: { "pyproject.toml": '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n' },
			argv: [python],
		},
		{
			name: "pyproject pytest dependency",
			files: { "pyproject.toml": '[project.optional-dependencies]\ntest = ["pytest>=8"]\n' },
			argv: [python],
		},
		{ name: "setup.cfg", files: { "setup.cfg": "[tool:pytest]\naddopts = -q\n" }, argv: [python] },
		{ name: "tox.ini", files: { "tox.ini": "[testenv]\ndeps = pytest\ncommands = pytest\n" }, argv: [python] },
		{ name: "development requirements", files: { "requirements-dev.txt": "pytest==8.0.0\n" }, argv: [python] },
		{ name: "test requirements", files: { "requirements-test.txt": "pytest>=8\n" }, argv: [python] },
		{
			name: "non-test npm manifest permits Rust detection",
			files: { "package.json": JSON.stringify({ scripts: { build: "node build.js" } }), "Cargo.toml": "[workspace]\n" },
			argv: [["cargo", "test", "--locked"]],
		},
	];
	for (const entry of cases) {
		await context.test(entry.name, async (subtest) => {
			const { cwd } = await directory(subtest, entry.files);
			const config = await loadProjectConfig(cwd);
			assert.deepEqual(
				config.integrationChecks.map((check) => check.argv),
				entry.argv,
			);
			assert.deepEqual(config.runChecks, config.integrationChecks);
			assert.ok(config.integrationChecks.every((check) => evidenceClassForCheck(check) === "BUILD"));
			assert.ok(config.integrationChecks.every((check) => check.lane === "HEAVY_CHECK" && check.timeoutMs > 0));
			assert.ok(config.candidateChecks.every((check) => evidenceClassForCheck(check) === "STRUCTURAL"));
		});
	}
});

test("projects without declared tests retain only structural fallback and reject malformed package JSON", async (context) => {
	const { cwd } = await directory(context, {
		"pyproject.toml": '[project]\nname = "example"\nversion = "0.1.0"\n',
		"setup.cfg": "[metadata]\nname = example\n",
		"package.json": JSON.stringify({ scripts: { test: false, check: 7 } }),
	});
	const config = await loadProjectConfig(cwd);
	assert.equal(config.integrationChecks.length, 1);
	const fallback = config.integrationChecks[0];
	assert.ok(fallback);
	assert.equal(fallback.name, "integration-diff-safety");
	assert.equal(evidenceClassForCheck(fallback), "STRUCTURAL");
	await writeFile(join(cwd, "package.json"), "{ invalid json");
	await assert.rejects(loadProjectConfig(cwd), /Invalid package.json/);
});

test("detected npm check and test both execute through the real native CheckRunner", async (context) => {
	const fixture = await committed(context, {
		"package.json": JSON.stringify({
			scripts: { check: "node -e \"console.log('fixture-check')\"", test: "node -e \"console.log('fixture-test')\"" },
		}),
	});
	const config = await loadProjectConfig(fixture.cwd);
	assert.deepEqual(
		config.integrationChecks.map((check) => check.name),
		["project-check", "project-test"],
	);
	const runner = new CheckRunner(new LocalResourceGovernor());
	for (const check of config.integrationChecks) {
		const result = await runner.run(check, fixture.context);
		assert.equal(result.state, "PASSED", await readFile(result.stderrPath, "utf8"));
		assert.match(
			await readFile(result.stdoutPath, "utf8"),
			new RegExp("fixture-" + check.name.slice("project-".length)),
		);
		assert.equal(result.result.integrity?.subjectTree, await git(fixture.cwd, ["rev-parse", "HEAD^{tree}"]));
	}
});

test("assurance defaults are adaptive while legacy frozen contracts remain off", async (context) => {
	const { cwd } = await directory(context);
	const config = await loadProjectConfig(cwd);
	assert.deepEqual(config.assurance, {
		mode: "adaptive",
		maxObligations: 8,
		maxProbes: 3,
		maxDesignAttempts: 2,
		maxDesignTokens: 300_000,
		maxDesignToolCalls: 40,
		maxDesignMs: 180_000,
		repetitions: 2,
		probeTimeoutMs: 30_000,
		isolation: undefined,
	});
	assert.equal(config.profiles.verifier, "verifier");
	assert.deepEqual(config.reviewRequiredFor, ["NORMAL", "HIGH"]);
	for (const legacy of [undefined, null, {}]) assert.equal(assurancePolicyFor(legacy).mode, "off");
	assert.deepEqual(assurancePolicyFor({ assurancePolicy: config.assurance }), config.assurance);
});

test("review risk configuration normalizes the MEDIUM alias without duplicate review gates", async (context) => {
	const { cwd } = await directory(context, {
		".tripleteam.json": JSON.stringify({ reviewRequiredFor: ["MEDIUM", "HIGH", "NORMAL"] }),
	});
	assert.deepEqual((await loadProjectConfig(cwd)).reviewRequiredFor, ["NORMAL", "HIGH"]);
});

test("assurance modes, bounded custom values and pinned isolation survive project config loading", async (context) => {
	const { cwd } = await directory(context);
	for (const mode of ["adaptive", "required", "off"] as const) {
		const assurance = {
			mode,
			maxObligations: 24,
			maxProbes: 8,
			maxDesignAttempts: 4,
			maxDesignTokens: 3_000_000,
			maxDesignToolCalls: 400,
			maxDesignMs: 1_800_000,
			repetitions: 3,
			probeTimeoutMs: 300_000,
			isolation: { kind: "DOCKER", image: pinnedImage, memoryMb: 128, cpus: 0.5 },
		};
		await writeFile(join(cwd, ".tripleteam.json"), JSON.stringify({ assurance }));
		assert.deepEqual((await loadProjectConfig(cwd)).assurance, assurance);
	}
	const minimal = parseAssurancePolicy({
		maxObligations: 1,
		maxProbes: 1,
		maxDesignAttempts: 1,
		maxDesignTokens: 1,
		maxDesignToolCalls: 1,
		maxDesignMs: 1,
		repetitions: 1,
		probeTimeoutMs: 1,
	});
	assert.equal(minimal.repetitions, 1);
	assert.equal(minimal.probeTimeoutMs, 1);
	assert.deepEqual(parseAssurancePolicy({ isolation: { kind: "DOCKER", image: pinnedImage } }).isolation, {
		kind: "DOCKER",
		image: pinnedImage,
		memoryMb: 2048,
		cpus: 2,
	});
});

test("assurance rejects malformed policies, out-of-range budgets and mutable isolation images", async (context) => {
	const { cwd } = await directory(context);
	const invalid: unknown[] = [null, [], false, "required", { mode: "always" }, { mode: "" }, { mode: null }];
	for (const [field, maximum] of Object.entries({
		maxObligations: 24,
		maxProbes: 8,
		maxDesignAttempts: 4,
		maxDesignTokens: 3_000_000,
		maxDesignToolCalls: 400,
		maxDesignMs: 1_800_000,
		repetitions: 3,
		probeTimeoutMs: 300_000,
	})) {
		for (const value of [0, -1, maximum + 1, 1.5, "2", true, null]) invalid.push({ [field]: value });
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY])
			assert.throws(() => parseAssurancePolicy({ [field]: value }), new RegExp(field));
	}
	for (const isolation of [
		null,
		{},
		{ kind: "LOCAL", image: pinnedImage },
		{ kind: "DOCKER", image: "python:latest" },
		{ kind: "DOCKER", image: pinnedImage, cpus: 0 },
		{ kind: "DOCKER", image: pinnedImage, memoryMb: 0 },
	])
		invalid.push({ isolation });
	for (const assurance of invalid) {
		await writeFile(join(cwd, ".tripleteam.json"), JSON.stringify({ assurance }));
		await assert.rejects(
			loadProjectConfig(cwd),
			/assurance/,
			`Accepted invalid assurance: ${JSON.stringify(assurance)}`,
		);
	}
});

test("verifier profiles and role model settings resolve and freeze independent read-only authority", async (context) => {
	const { root, cwd } = await directory(context);
	syntheticEnvironment(context, { PI_CODING_AGENT_DIR: join(root, "pi") });
	const selection = { provider: "fixture-provider", model: "fixture-model", reasoning: "high" };
	await writeFile(join(cwd, ".tripleteam.json"), JSON.stringify({ execution: { roles: { verifier: selection } } }));
	const config = await loadProjectConfig(cwd);
	assert.deepEqual(modelSelectionFor(config.execution, "verifier"), selection);
	assert.ok(config.execution);
	assert.ok(config.profiles.verifier);
	const launcher = new PiWorkerLauncher();
	const profile = launcher.resolveProfile(
		cwd,
		config.profiles.verifier,
		["bash", "write"],
		config.execution,
		"verifier",
	);
	assert.deepEqual(profile.tools, ["read", "grep", "find", "ls"]);
	assert.equal(profile.source, "builtin");
	assert.equal(profile.model, selection.model);
	const frozen = freezePiProfiles(launcher, cwd, config.profiles, config.execution);
	assert.deepEqual(frozen.VERIFY, { name: "verifier", version: profile.version });
	await writeFile(join(cwd, ".tripleteam.json"), JSON.stringify({ profiles: { verifier: "custom-verifier" } }));
	assert.equal((await loadProjectConfig(cwd)).profiles.verifier, "custom-verifier");
	for (const verifier of [null, "", "  ", 7, []]) {
		await writeFile(join(cwd, ".tripleteam.json"), JSON.stringify({ profiles: { verifier } }));
		await assert.rejects(loadProjectConfig(cwd), /profiles.verifier/);
	}
});

test("native checks receive ordinary runtime variables but no synthetic provider or authentication secrets", async (context) => {
	const fixture = await committed(context, { "README.md": "Synthetic environment regression fixture.\n" });
	const sensitiveNames = [
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
		"GEMINI_APIKEY",
		"GH_TOKEN",
		"AWS_SESSION_TOKEN",
		"AZURE_CLIENT_SECRET",
		"DB_PASSWORD",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"TRIPLETEAM_CONTROL_TOKEN",
		"PRIVATE_KEY",
		"DOCKER_AUTH_CONFIG",
		"NPM_CONFIG__AUTHTOKEN",
		"mixed_case_password",
	];
	syntheticEnvironment(
		context,
		Object.fromEntries([
			...sensitiveNames.map((name) => [name, "synthetic-not-a-credential"]),
			["TRIPLETEAM_CONFIG_ASSURANCE_FIXTURE", "ordinary-runtime-value"],
		]),
	);
	const script = `const names=${JSON.stringify(sensitiveNames)}; console.log(JSON.stringify({leaked:names.filter(name=>Object.hasOwn(process.env,name)), ordinary:process.env.TRIPLETEAM_CONFIG_ASSURANCE_FIXTURE, hasPath:typeof process.env.PATH==='string'}));`;
	const result = await new CheckRunner(new LocalResourceGovernor()).run(
		{ name: "environment-isolation", argv: [process.execPath, "-e", script], timeoutMs: 5_000, lane: "LIGHT_CHECK" },
		fixture.context,
	);
	assert.equal(result.state, "PASSED", await readFile(result.stderrPath, "utf8"));
	const output = JSON.parse(await readFile(result.stdoutPath, "utf8"));
	assert.equal(output.ordinary, "ordinary-runtime-value");
	assert.equal(output.hasPath, true);
	assert.deepEqual(output.leaked, []);
});
