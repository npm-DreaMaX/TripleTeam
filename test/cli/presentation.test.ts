import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createNodeSqliteFactory } from "@earendil-works/pi-session-backend-sqlite-node";
import { TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { DashboardScreen, renderDashboard } from "../../src/cli/dashboard.ts";
import { type DashboardSnapshot, demoDashboard, emptyDashboard, readDashboard } from "../../src/cli/dashboard-data.ts";
import { withLiveDashboard } from "../../src/cli/monitor.ts";
import { parseOutputOptions, renderError, renderResult } from "../../src/cli/output.ts";
import { clean, fit, pad, wrap } from "../../src/cli/theme.ts";
import { projectPaths } from "../../src/config/paths.ts";
import type { CheckCommand } from "../../src/config/project.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { openControlDatabase } from "../../src/store/database.ts";
import { MIGRATIONS } from "../../src/store/schema.ts";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");
const system = { kind: "SYSTEM", id: "presentation-test" } as const;
const attack = "\x1b[2J\x1b]52;c;YmFk\x07\r\n\u202e";

async function fixture(context: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-presentation-"));
	const previousState = process.env.TRIPLETEAM_STATE_DIR;
	process.env.TRIPLETEAM_STATE_DIR = join(directory, "state");
	context.after(async () => {
		if (previousState === undefined) delete process.env.TRIPLETEAM_STATE_DIR;
		else process.env.TRIPLETEAM_STATE_DIR = previousState;
		await rm(directory, { recursive: true, force: true });
	});
	const repository = join(directory, "repo");
	await mkdir(repository);
	return { directory, repository, paths: projectPaths(repository) };
}

function assertSafeLine(line: string): void {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Only product-generated SGR sequences are permitted.
	const withoutProductColors = line.replace(/\x1b\[[0-9;]*m/g, "");
	assert.doesNotMatch(withoutProductColors, /[\p{Cc}\p{Cf}]/u);
}

function poisonStrings(value: unknown): unknown {
	if (typeof value === "string") return attack + value + attack;
	if (Array.isArray(value)) return value.map(poisonStrings);
	if (value && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, poisonStrings(entry)]));
	return value;
}

function pretendTerminal(context: TestContext): void {
	for (const stream of [process.stdin, process.stdout]) {
		const previous = Object.getOwnPropertyDescriptor(stream, "isTTY");
		Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
		context.after(() => {
			if (previous) Object.defineProperty(stream, "isTTY", previous);
			else Reflect.deleteProperty(stream, "isTTY");
		});
	}
	const previousTerm = process.env.TERM;
	process.env.TERM = "xterm-256color";
	context.after(() => {
		if (previousTerm === undefined) delete process.env.TERM;
		else process.env.TERM = previousTerm;
	});
}

test("piped output stays JSON and explicit presentation flags preserve literal arguments", () => {
	assert.equal(parseOutputOptions(["status"], false, {}).json, true);
	assert.equal(parseOutputOptions(["status", "--json"], true, {}).json, true);
	assert.equal(parseOutputOptions(["status", "--plain"], false, {}).json, false);
	assert.equal(parseOutputOptions(["status", "--plain"], true, {}).color, false);
	assert.equal(parseOutputOptions(["status"], true, { NO_COLOR: "" }).color, false);
	assert.equal(parseOutputOptions(["status"], true, { TERM: "dumb" }).color, false);
	assert.deepEqual(parseOutputOptions(["run", "--", "--json", "--watch", "--plain"], false, {}).args, [
		"run",
		"--json",
		"--watch",
		"--plain",
	]);
	assert.throws(() => parseOutputOptions(["--plain", "--json"], true, {}), /Choose/);
	for (const flags of [["--watch"], ["--watch", "--plain"], ["--watch", "--json"]])
		assert.throws(() => parseOutputOptions(flags, false, {}), /interactive terminal/);
	assert.throws(() => parseOutputOptions(["--watch"], true, { TERM: "dumb" }), /interactive terminal/);
});

test("theme utilities remove terminal controls and preserve CJK cell widths", () => {
	assert.equal(clean(attack + "研发  工作区" + attack), "研发 工作区");
	assert.equal(visibleWidth(pad("研发", 7)), 7);
	for (const width of [1, 2, 3, 4, 7, 12]) {
		assert.ok(visibleWidth(fit("研发团队🙂e\u0301发布", width)) <= width);
		if (width < 2) continue;
		for (const line of wrap(attack + "研发团队 改善终端界面", width)) {
			assertSafeLine(line);
			assert.ok(visibleWidth(line) <= width);
		}
	}
	assertSafeLine(renderError(new Error(attack + "Failed"), false));
});

test("dashboard treats repository, model, task and view strings as data in every tab", () => {
	const source = demoDashboard();
	source.sample = false;
	source.delivery = { result: "STRUCTURAL_HANDOFF", ref: "refs/delivery", tree: "abc", manifest: "report.json" };
	source.decisions = [{ id: "decision", question: "Choose a path", options: ["A", "B"] }];
	const snapshot = poisonStrings(source) as DashboardSnapshot;
	for (const color of [false, true]) {
		for (const tab of [0, 1, 2]) {
			for (const row of renderDashboard(snapshot, { width: 124, height: 48, color, tab, error: attack + "Retry" }))
				assertSafeLine(row);
		}
		const empty = emptyDashboard(attack + "/repo");
		for (const row of renderDashboard(empty, { width: 80, height: 32, color, loading: attack + "Loading" }))
			assertSafeLine(row);
	}
});

test("dashboard respects narrow and short terminals with wide Unicode text", () => {
	const sample = demoDashboard();
	sample.repository = "研发工作区/含有很长的项目名称/🙂";
	assert.ok(sample.run);
	sample.run.objective = "检查跨模块改动与交付证据 ".repeat(20);
	assert.ok(sample.tasks[0]);
	sample.tasks[0].title = "实现持久化检查点与恢复机制 ".repeat(10);
	for (const snapshot of [emptyDashboard("空工作区"), sample])
		for (const width of [1, 8, 24, 40, 80, 160])
			for (const height of [1, 3, 12, 32])
				for (const tab of [0, 1, 2]) {
					const rows = renderDashboard(snapshot, { width, height, color: true, tab });
					assert.ok(rows.length <= height, "Rendered beyond terminal height " + height);
					for (const row of rows) assert.ok(visibleWidth(row) <= width, "Rendered beyond terminal width " + width);
				}
});

test("structured human output clips to terminal columns and sanitizes arbitrary result text", () => {
	const value = { ["长键名" + attack]: [{ objective: attack + "处理任务".repeat(40) }] };
	for (const width of [1, 8, 24, 40, 80]) {
		for (const line of renderResult(value, "发布结果" + attack, true, width).split("\n")) {
			assertSafeLine(line);
			assert.ok(visibleWidth(line) <= width, "Result exceeded terminal width " + width);
		}
	}
});

test("demo works outside Git with no provider credentials or executable search path", async (context) => {
	const { directory, repository } = await fixture(context);
	const environment = {
		PATH: "",
		PI_CODING_AGENT_DIR: join(directory, "pi"),
		TRIPLETEAM_STATE_DIR: join(directory, "state"),
		NO_COLOR: "1",
		TERM: "xterm-256color",
	};
	for (const flags of [[], ["--json"], ["--plain"]]) {
		const result = await execFileAsync(process.execPath, ["--import", tsx, cli, "demo", ...flags], {
			cwd: repository,
			env: environment,
			encoding: "utf8",
			timeout: 15_000,
		});
		assert.equal(result.stdout.includes("\x1b"), false);
		if (flags.includes("--plain")) assert.match(result.stdout, /PREVIEW \/ SAMPLE DATA/);
		else {
			const snapshot = JSON.parse(result.stdout) as DashboardSnapshot;
			assert.equal(snapshot.sample, true);
			assert.equal(snapshot.run?.id, "demo-run");
		}
	}
	assert.deepEqual(await readdir(directory), ["repo"]);
	assert.deepEqual(await readdir(repository), []);
});

test("dashboard reads an uninitialized repository without creating project state", async (context) => {
	const { repository, paths } = await fixture(context);
	assert.equal((await readDashboard(repository)).run, null);
	await assert.rejects(readDashboard(repository, "missing-run"), { code: "ENOENT" });
	await assert.rejects(access(paths.root), { code: "ENOENT" });
	await execFileAsync("git", ["init", repository]);
	const result = await execFileAsync(process.execPath, ["--import", tsx, cli, "dashboard", repository, "--json"], {
		env: process.env,
		encoding: "utf8",
		timeout: 15_000,
	});
	assert.equal((JSON.parse(result.stdout) as DashboardSnapshot).run, null);
	await assert.rejects(access(paths.root), { code: "ENOENT" });
});

test("dashboard reads persisted evidence without changing the database or schema", async (context) => {
	const { repository, paths } = await fixture(context);
	const database = await openControlDatabase(paths.database);
	const kernel = new ControlKernel(database);
	const check: CheckCommand = {
		name: "structural",
		argv: ["git", "diff", "--check"],
		timeoutMs: 1000,
		lane: "LIGHT_CHECK",
	};
	kernel.createRun({
		id: "run",
		repositoryRoot: repository,
		objective: "检查交付",
		inputCommit: "a".repeat(40),
		integrationRef: "refs/tripleteam/run",
		goalContract: { executionPolicy: { provider: "fixture", model: "model-a", costLimitUsd: 5 } },
		actor: system,
	});
	kernel.createTask({
		id: "task",
		runId: "run",
		title: "验证存储",
		objective: "Add storage checks",
		scope: ["src"],
		constraints: [],
		acceptanceContract: { candidateChecks: [check], integrationChecks: [check], requireReview: false },
		riskClass: "LOW",
		actor: system,
	});
	database.close();
	const before = await readFile(paths.database);
	const snapshot = await readDashboard(repository);
	assert.equal(snapshot.run?.id, "run");
	assert.equal(snapshot.run?.objective, "检查交付");
	assert.equal(snapshot.tasks[0]?.title, "验证存储");
	assert.equal(snapshot.model, "fixture / model-a");
	assert.equal(snapshot.usage.limit, 5);
	assert.ok(snapshot.events.some((event) => event.type === "RunCreated"));
	assert.deepEqual(await readFile(paths.database), before);
	const sql = await createNodeSqliteFactory().openReadOnly(paths.database);
	try {
		assert.equal(
			sql.prepare("PRAGMA user_version").get<{ user_version: number }>()?.user_version,
			MIGRATIONS.at(-1)?.version,
		);
	} finally {
		sql.close();
	}
});

test("dashboard refuses obsolete state without migrating it", async (context) => {
	const { repository, paths } = await fixture(context);
	await mkdir(dirname(paths.database), { recursive: true });
	const sql = await createNodeSqliteFactory().open(paths.database);
	sql.exec("PRAGMA user_version = 1");
	sql.close();
	const before = await readFile(paths.database);
	await assert.rejects(readDashboard(repository), /migration/i);
	assert.deepEqual(await readFile(paths.database), before);
});

test("live observation does not prevent continue from migrating older project state", async (context) => {
	const { repository, paths } = await fixture(context);
	await execFileAsync("git", ["init", repository]);
	await mkdir(dirname(paths.database), { recursive: true });
	const sql = await createNodeSqliteFactory().open(paths.database);
	sql.exec("PRAGMA user_version = 1");
	sql.close();
	pretendTerminal(context);
	context.mock.method(DashboardScreen.prototype, "start", () => {});
	context.mock.method(DashboardScreen.prototype, "stop", () => {});
	let calls = 0;
	const result = await withLiveDashboard(parseOutputOptions([], true, {}), repository, async () => {
		calls++;
		return "continued";
	});
	assert.equal(result, "continued");
	assert.equal(calls, 1);
});

test("JSON and plain operations bypass terminal and repository observation", async () => {
	for (const flag of ["--json", "--plain"]) {
		let calls = 0;
		assert.equal(
			await withLiveDashboard(parseOutputOptions([flag], true, {}), "/does-not-exist", async () => ++calls),
			1,
		);
	}
});

test("terminal startup failure leaves the engineering operation available", async (context) => {
	const { repository } = await fixture(context);
	await execFileAsync("git", ["init", repository]);
	pretendTerminal(context);
	const startupError = new Error("Terminal startup failed");
	context.mock.method(DashboardScreen.prototype, "start", () => {
		throw startupError;
	});
	context.mock.method(DashboardScreen.prototype, "stop", () => {});
	let calls = 0;
	const result = await withLiveDashboard(parseOutputOptions([], true, {}), repository, async () => {
		calls++;
		return "continued";
	});
	assert.equal(result, "continued");
	assert.equal(calls, 1);
});

test("failed dashboard startup cleans up terminal resources and signal handlers", (context) => {
	const startupError = new Error("Terminal startup failed");
	context.mock.method(TuiAltScreen.prototype, "start", () => {
		throw startupError;
	});
	const stop = context.mock.method(TuiAltScreen.prototype, "stop", () => {});
	const before = new Map(["SIGINT", "SIGTERM", "exit"].map((signal) => [signal, process.rawListeners(signal)]));
	const screen = new DashboardScreen(demoDashboard(), false);
	context.after(() => screen.stop());
	assert.throws(
		() => screen.start(() => {}),
		(error: unknown) => error === startupError,
	);
	assert.equal(stop.mock.callCount(), 1);
	for (const [signal, listeners] of before) assert.deepEqual(process.rawListeners(signal), listeners);
});

test("closing a dashboard is idempotent and restores signal listeners", (context) => {
	context.mock.method(TuiAltScreen.prototype, "start", () => {});
	const stop = context.mock.method(TuiAltScreen.prototype, "stop", () => {});
	const before = new Map(["SIGINT", "SIGTERM", "exit"].map((signal) => [signal, process.rawListeners(signal)]));
	const screen = new DashboardScreen(demoDashboard(), false);
	let closes = 0;
	screen.start(() => closes++);
	for (const [signal, listeners] of before) assert.equal(process.rawListeners(signal).length, listeners.length + 1);
	screen.stop();
	screen.stop();
	assert.equal(closes, 1);
	assert.equal(stop.mock.callCount(), 1);
	for (const [signal, listeners] of before) assert.deepEqual(process.rawListeners(signal), listeners);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	test("dashboard cleans up before preserving " + signal + " termination", (context) => {
		context.mock.method(TuiAltScreen.prototype, "start", () => {});
		const stop = context.mock.method(TuiAltScreen.prototype, "stop", () => {});
		const before = process.listeners(signal);
		const kill = context.mock.method(process, "kill", (pid: number, forwardedSignal?: NodeJS.Signals | number) => {
			assert.equal(pid, process.pid);
			assert.equal(forwardedSignal, signal);
			assert.deepEqual(process.listeners(signal), before);
			assert.equal(stop.mock.callCount(), 1);
			return true;
		});
		const screen = new DashboardScreen(demoDashboard(), false);
		context.after(() => screen.stop());
		let closes = 0;
		screen.start(() => closes++);
		const handler = process.listeners(signal).find((listener) => !before.includes(listener));
		assert.ok(handler);
		handler(signal);
		assert.equal(closes, 1);
		assert.equal(kill.mock.callCount(), 1);
	});
}
