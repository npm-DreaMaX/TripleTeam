import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { access, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { AGENT_ROLES, modelSelectionFor } from "../../src/config/execution.ts";
import { projectPaths } from "../../src/config/paths.ts";
import { evidenceClassForCheck } from "../../src/config/project.ts";
import { loadSettings, parseSettingValue, resetSetting, updateSetting } from "../../src/config/settings.ts";
import { PersistentSessionGuard } from "../../src/runtime/pi/upstream.ts";

const execFileAsync = promisify(execFile);
const image = "sha256:" + "a".repeat(64);
const protectedCheck = {
	name: "protected-api",
	argv: ["node", "--test", "tests/api.test.mjs"],
	timeoutMs: 5000,
	lane: "HEAVY_CHECK",
	evidenceClass: "BEHAVIORAL",
	oracle: { protectedPaths: ["tests", "package.json"] },
	isolation: { kind: "DOCKER", image, memoryMb: 128, cpus: 0.5 },
};

async function fixture(context: TestContext, config?: Record<string, unknown>) {
	const root = await mkdtemp(join(tmpdir(), "tripleteam-settings-"));
	const repository = join(root, "repo");
	const state = join(root, "state");
	const pi = join(root, "pi");
	await mkdir(repository);
	await execFileAsync("git", ["init", repository]);
	await writeFile(
		join(repository, "package.json"),
		JSON.stringify({ scripts: { test: "must-not-run-during-settings" } }),
	);
	const file = join(repository, ".tripleteam.json");
	if (config !== undefined) await writeFile(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
	const environment = { TRIPLETEAM_STATE_DIR: state, PI_CODING_AGENT_DIR: pi };
	const previous = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]));
	Object.assign(process.env, environment);
	context.after(async () => {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await rm(root, { recursive: true, force: true });
	});
	return { root, repository, file, state, pi };
}

async function assertUnchanged(repository: string, file: string, before: string) {
	assert.equal(await readFile(file, "utf8"), before);
	assert.deepEqual(
		(await readdir(repository)).filter((name) => name.startsWith(".tripleteam.json.")),
		[],
	);
	assert.equal(Reflect.get({}, "tripleteamPolluted"), undefined);
}

test("settings reads resolve defaults and metadata without writing config, state, a database or Pi files", async (context) => {
	const f = await fixture(context);
	const nested = join(f.repository, "nested");
	await mkdir(nested);
	const before = await readdir(f.repository, { recursive: true });
	const snapshot = await loadSettings(nested);
	assert.equal(snapshot.file, f.file);
	assert.equal(snapshot.appliesTo, "new-runs");
	assert.deepEqual(snapshot.explicit, []);
	assert.equal(snapshot.values.execution?.policy, "ADAPTIVE");
	assert.equal(snapshot.values.assurance?.mode, "adaptive");
	assert.equal(snapshot.values.runChecks[0]?.name, "project-test");
	const keys = snapshot.groups.flatMap((group) => group.settings.map((setting) => setting.key));
	assert.equal(new Set(keys).size, keys.length);
	for (const key of [
		"execution.costLimitUsd",
		"execution.maxPlanningTokens",
		"assurance.maxDesignTokens",
		"assurance.isolation",
		"candidateChecks",
		"runChecks",
		"profiles.verifier",
		"maxAttemptsPerTask",
	])
		assert.ok(keys.includes(key), key);
	for (const role of AGENT_ROLES)
		for (const key of ["model", "provider", "reasoning"]) assert.ok(keys.includes(`execution.roles.${role}.${key}`));
	assert.deepEqual(await readdir(f.repository, { recursive: true }), before);
	for (const path of [f.file, f.state, f.pi]) await assert.rejects(access(path), { code: "ENOENT" });
	await writeFile(f.file, '{ "workerTimeoutMs": 1234 }\n');
	const bytes = await readFile(f.file, "utf8");
	assert.equal((await loadSettings(f.repository)).values.workerTimeoutMs, 1234);
	assert.equal(await readFile(f.file, "utf8"), bytes);
	await assert.rejects(access(f.state), { code: "ENOENT" });
});

test("setting value parsing handles typed JSON and preserves shell-looking text as literal data", () => {
	assert.equal(parseSettingValue("42"), 42);
	assert.equal(parseSettingValue("0.25"), 0.25);
	assert.equal(parseSettingValue("false"), false);
	assert.equal(parseSettingValue("null"), null);
	assert.equal(parseSettingValue('"42"'), "42");
	assert.deepEqual(parseSettingValue('{"model":"example","reasoning":"high"}'), {
		model: "example",
		reasoning: "high",
	});
	assert.deepEqual(parseSettingValue('["LOW","HIGH"]'), ["LOW", "HIGH"]);
	for (const text of ["provider/model", "$(not-a-command)", "`not-a-command`", "{invalid json"])
		assert.equal(parseSettingValue(text), text);
});

test("global selections and role overrides preserve other settings and inherit unset model fields", async (context) => {
	const f = await fixture(context, {
		execution: { maxParallelism: 2, roles: { reviewer: { model: "review-model" } } },
		assurance: { mode: "required" },
	});
	await updateSetting(f.repository, "execution.provider", "shared-provider");
	await updateSetting(f.repository, "execution.model", "shared-model");
	await updateSetting(f.repository, "execution.reasoning", "medium");
	await updateSetting(f.repository, "execution.roles.planner", {
		provider: "plan-provider",
		model: "plan-model",
		reasoning: "high",
	});
	const snapshot = await updateSetting(f.repository, "execution.model", "shared-next");
	assert.deepEqual(modelSelectionFor(snapshot.values.execution, "planner"), {
		provider: "plan-provider",
		model: "plan-model",
		reasoning: "high",
	});
	assert.deepEqual(modelSelectionFor(snapshot.values.execution, "reviewer"), {
		provider: "shared-provider",
		model: "review-model",
		reasoning: "medium",
	});
	assert.deepEqual(modelSelectionFor(snapshot.values.execution, "implementer"), {
		provider: "shared-provider",
		model: "shared-next",
		reasoning: "medium",
	});
	assert.equal(snapshot.values.execution?.maxParallelism, 2);
	assert.equal(snapshot.values.assurance?.mode, "required");
	assert.equal(snapshot.appliesTo, "new-runs");
	assert.ok(snapshot.explicit.includes("execution.roles.planner.model"));
	assert.ok(!snapshot.explicit.includes("execution.roles.implementer.model"));
	assert.deepEqual((await loadSettings(f.repository)).values, snapshot.values);
	await assert.rejects(access(projectPaths(f.repository).database), { code: "ENOENT" });
});

test("reset restores inheritance for the selected key or role and preserves unrelated explicit values", async (context) => {
	const f = await fixture(context, {
		execution: {
			provider: "global",
			model: "base",
			reasoning: "low",
			tokenLimit: 1000,
			maxParallelism: 2,
			roles: { planner: { provider: "plan", model: "thinking", reasoning: "high" }, reviewer: { model: "review" } },
		},
		assurance: { mode: "required" },
		workerTimeoutMs: 1234,
	});
	let snapshot = await resetSetting(f.repository, "execution.roles.planner.reasoning");
	assert.deepEqual(modelSelectionFor(snapshot.values.execution, "planner"), {
		provider: "plan",
		model: "thinking",
		reasoning: "low",
	});
	snapshot = await resetSetting(f.repository, "execution.roles.planner");
	assert.deepEqual(modelSelectionFor(snapshot.values.execution, "planner"), {
		provider: "global",
		model: "base",
		reasoning: "low",
	});
	assert.equal(snapshot.values.execution?.roles?.reviewer?.model, "review");
	snapshot = await resetSetting(f.repository, "execution.tokenLimit");
	assert.equal(snapshot.values.execution?.tokenLimit, undefined);
	assert.equal(snapshot.values.execution?.maxParallelism, 2);
	assert.equal(snapshot.values.workerTimeoutMs, 1234);
	assert.equal(snapshot.values.assurance?.mode, "required");
	const raw = JSON.parse(await readFile(f.file, "utf8"));
	assert.deepEqual(raw.execution.roles, { reviewer: { model: "review" } });
	assert.ok(!Object.hasOwn(raw.execution, "tokenLimit"));
	const before = await readFile(f.file, "utf8");
	await assert.rejects(resetSetting(f.repository, "execution.unknown"));
	await assertUnchanged(f.repository, f.file, before);
	snapshot = await resetSetting(f.repository, "assurance");
	assert.equal(snapshot.values.assurance?.mode, "adaptive");
	assert.equal(snapshot.values.execution?.roles?.reviewer?.model, "review");
});

test("invalid values, unknown fields, nulls, credentials and prototype keys never replace the saved configuration", async (context) => {
	const f = await fixture(context, {
		execution: { model: "keep", maxParallelism: 2 },
		assurance: { mode: "required" },
	});
	const before = await readFile(f.file, "utf8");
	const invalid: Array<[string, unknown]> = [
		["unknown", 1],
		["execution.unknown", true],
		["execution.policy", "AUTO"],
		["execution.maxParallelism", 0],
		["execution.tokenLimit", Number.NaN],
		["workerTimeoutMs", "1000"],
		["execution.model", null],
		["execution.model", undefined],
		["profiles.verifier", ""],
		["execution.roles.planner", { provider: "provider-only" }],
		["assurance", null],
		["reviewRequiredFor", ["UNKNOWN"]],
		["candidateChecks", []],
		["__proto__.tripleteamPolluted", true],
		["execution.constructor.prototype.tripleteamPolluted", true],
		["execution.roles.planner.__proto__", {}],
		["execution..model", "bad"],
		["execution", JSON.parse('{"__proto__":{"tripleteamPolluted":true}}')],
		["assurance", Object.create({ mode: "off" })],
		["assurance.isolation", { kind: "DOCKER", image, cpus: null }],
		["execution.apiKey", "synthetic-credential"],
		["execution.roles.verifier", { model: "example", apiKey: "synthetic-credential" }],
	];
	for (const key of [
		"apiKey",
		"token",
		"authToken",
		"privateKey",
		"authorization",
		"password",
		"unknown",
		"constructor",
		"prototype",
		"__proto__",
	]) {
		invalid.push([
			"runChecks",
			[{ ...protectedCheck, ...JSON.parse(JSON.stringify({ [key]: "synthetic-credential" })) }],
		]);
		invalid.push([
			"assurance.isolation",
			{ kind: "DOCKER", image, ...JSON.parse(JSON.stringify({ [key]: "synthetic-credential" })) },
		]);
	}
	for (const [key, value] of invalid) {
		await assert.rejects(
			updateSetting(f.repository, key, value),
			(error: unknown) => error instanceof Error,
			`Accepted invalid ${key}`,
		);
		await assertUnchanged(f.repository, f.file, before);
	}
});

test("complex checks retain protected oracle and immutable image settings while rejecting malformed variants", async (context) => {
	const f = await fixture(context, { workerTimeoutMs: 4321 });
	let snapshot = await updateSetting(f.repository, "runChecks", [protectedCheck]);
	const check = snapshot.values.runChecks[0];
	assert.ok(check);
	assert.equal(evidenceClassForCheck(check), "BEHAVIORAL");
	assert.deepEqual(check.oracle?.protectedPaths, ["package.json", "tests"]);
	assert.deepEqual(check.isolation, protectedCheck.isolation);
	assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")).runChecks, [protectedCheck]);
	assert.equal(snapshot.values.workerTimeoutMs, 4321);
	const before = await readFile(f.file, "utf8");
	for (const invalid of [
		{ ...protectedCheck, isolation: { kind: "DOCKER", image: "node:latest" } },
		{ ...protectedCheck, oracle: { protectedPaths: ["../outside"] } },
		{ ...protectedCheck, argv: [] },
		{ ...protectedCheck, lane: "UNKNOWN" },
		{ ...protectedCheck, timeoutMs: 0 },
		{ ...protectedCheck, oracle: { protectedPaths: ["tests"], token: "synthetic" } },
	]) {
		await assert.rejects(updateSetting(f.repository, "runChecks", [invalid]));
		await assertUnchanged(f.repository, f.file, before);
	}
	snapshot = await updateSetting(f.repository, "reviewRequiredFor", ["MEDIUM", "HIGH", "NORMAL"]);
	assert.deepEqual(snapshot.values.reviewRequiredFor, ["NORMAL", "HIGH"]);
	assert.equal((await loadSettings(f.repository)).values.runChecks[0]?.name, "protected-api");
});

test("settings read, update and reset refuse symbolic links without touching the target", async (context) => {
	const f = await fixture(context);
	const target = join(f.root, "outside.json");
	const original = '{"execution":{"model":"outside"}}\n';
	await writeFile(target, original);
	await symlink(target, f.file);
	await assert.rejects(loadSettings(f.repository), /regular.*file/);
	await assert.rejects(updateSetting(f.repository, "execution.model", "changed"), /regular.*file/);
	await assert.rejects(resetSetting(f.repository, "execution.model"), /regular.*file/);
	assert.equal(await readFile(target, "utf8"), original);
	assert.ok((await lstat(f.file)).isSymbolicLink());
});

test("a failed atomic rename preserves the original file and permissions and releases the settings guard", async (context) => {
	const f = await fixture(context, { execution: { model: "original" }, workerTimeoutMs: 4321 });
	await chmod(f.file, 0o640);
	const before = await readFile(f.file, "utf8");
	const rename = fs.rename;
	let injected = false;
	const failure = context.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
		if (args[1] === f.file) {
			injected = true;
			assert.equal(JSON.parse(await readFile(args[0], "utf8")).execution.model, "replacement");
			throw Object.assign(new Error("Injected atomic rename failure"), { code: "EACCES" });
		}
		return rename(...args);
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(
			updateSetting(f.repository, "execution.model", "replacement"),
			/Injected atomic rename failure/,
		);
	} finally {
		failure.mock.restore();
		syncBuiltinESMExports();
	}
	assert.equal(injected, true);
	await assertUnchanged(f.repository, f.file, before);
	if (process.platform !== "win32") assert.equal((await lstat(f.file)).mode & 0o777, 0o640);
	const snapshot = await updateSetting(f.repository, "execution.reasoning", "low");
	assert.equal(snapshot.values.execution?.model, "original");
	assert.equal(snapshot.values.execution?.reasoning, "low");
	assert.equal(snapshot.values.workerTimeoutMs, 4321);
});

test("settings writes honor the pinned Pi session guard and preserve changes after contention", async (context) => {
	const f = await fixture(context, { execution: { model: "original" } });
	const before = await readFile(f.file, "utf8");
	const guard = PersistentSessionGuard.acquire({
		sessionId: "project-settings",
		lockRoot: join(projectPaths(f.repository).root, "locks"),
		agent: "test",
		cwd: f.repository,
	});
	try {
		await assert.rejects(updateSetting(f.repository, "execution.model", "racing-writer"), /already running/);
		await assertUnchanged(f.repository, f.file, before);
	} finally {
		guard.release();
	}
	const snapshot = await updateSetting(f.repository, "execution.reasoning", "high");
	assert.equal(snapshot.values.execution?.model, "original");
	assert.equal(snapshot.values.execution?.reasoning, "high");
});
