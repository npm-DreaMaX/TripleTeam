import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { ProcessTerminal, type Terminal, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { LocalOrchestrator } from "../../src/app/orchestrator.ts";
import { type DashboardSnapshot, demoDashboard, emptyDashboard } from "../../src/cli/dashboard-data.ts";
import { ShellDiagnostics } from "../../src/cli/diagnostics.ts";
import { ShellScreen, showShell } from "../../src/cli/shell.ts";
import { settingsDocument, WorkspaceShellBackend } from "../../src/cli/shell-actions.ts";
import {
	parseShellRequest,
	SHELL_COMMANDS,
	type ShellBackend,
	type ShellReply,
	type ShellRequest,
	ShellSession,
	shellHelp,
} from "../../src/cli/shell-commands.ts";
import { overviewDocument, renderShell, tasksDocument } from "../../src/cli/shell-view.ts";
import { clean } from "../../src/cli/theme.ts";
import { AGENT_ROLES } from "../../src/config/execution.ts";
import { projectPaths } from "../../src/config/paths.ts";
import { loadSettings } from "../../src/config/settings.ts";
import { DaemonClient } from "../../src/daemon/client.ts";

const execFileAsync = promisify(execFile);
const attack = "\x1b[2J\x1b]52;c;YmFk\x07\r\n\u202e";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function backend(execute: ShellBackend["execute"] = async () => ({}), active = false): ShellBackend {
	return { execute, snapshot: async () => demoDashboard(), localWorkActive: () => active };
}

async function fixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "tripleteam-shell-"));
	const repository = join(root, "repo");
	await mkdir(repository);
	await execFileAsync("git", ["init", repository]);
	const environment = { TRIPLETEAM_STATE_DIR: join(root, "state"), PI_CODING_AGENT_DIR: join(root, "pi") };
	const previous = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]));
	Object.assign(process.env, environment);
	context.after(async () => {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await rm(root, { recursive: true, force: true });
	});
	return { root, repository, file: join(repository, ".tripleteam.json") };
}

function assertSafeLine(line: string): void {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Allow only the product's SGR color codes.
	assert.doesNotMatch(line.replace(/\x1b\[[0-9;]*m/g, ""), /[\p{Cc}\p{Cf}]/u);
}

class MemoryTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	output = "";
	input: (data: string) => void = () => {};
	resize = () => {};
	stops = 0;
	start(onInput: (data: string) => void, onResize: () => void) {
		this.input = onInput;
		this.resize = onResize;
	}
	stop() {
		this.stops++;
	}
	async drainInput() {}
	write(data: string) {
		this.output += data;
	}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
}

test("shell treats goals, quoted reasons and JSON settings as literal data", () => {
	const objective = "检查中文路径 $(touch should-not-exist) `echo literal`";
	assert.deepEqual(parseShellRequest(objective).args, [objective]);
	assert.equal(parseShellRequest(objective).name, "new");
	assert.deepEqual(parseShellRequest('/decision 2 1 "Review the evidence first"').args, [
		"2",
		"1",
		"Review the evidence first",
	]);
	const json = '[{"name":"syntax","argv":["git","diff","--check"],"timeoutMs":1000,"lane":"LIGHT_CHECK"}]';
	assert.deepEqual(parseShellRequest("/settings candidateChecks " + json).args, ["candidateChecks", json]);
	assert.deepEqual(parseShellRequest("/settings reset execution.tokenLimit").args, ["reset", "execution.tokenLimit"]);
	assert.equal(parseShellRequest("/result").name, "delivery");
	assert.equal(parseShellRequest("/run goal").name, "new");
	assert.equal(parseShellRequest("/exit").name, "quit");
	assert.throws(() => parseShellRequest('/message attempt "unfinished'), /quoted/);
});

test("help groups every product command and keeps syntax available on demand", () => {
	const names = SHELL_COMMANDS.map((command) => command.name);
	for (const name of [
		"new",
		"continue",
		"status",
		"tasks",
		"models",
		"settings",
		"pause",
		"resume",
		"delivery",
		"decisions",
		"decision",
		"cancel",
		"retry",
		"profiles",
		"events",
		"messages",
		"message",
		"proposals",
		"proposal",
		"artifacts",
		"init",
		"doctor",
		"quit",
	])
		assert.ok(names.includes(name as (typeof names)[number]), name);
	const help = shellHelp()
		.lines.map((line) => line.text)
		.join("\n");
	for (const name of names) assert.ok(help.includes("/" + name), name);
	assert.ok(shellHelp("settings").lines.some((line) => line.text.includes("[key [value]]")));
	assert.ok(shellHelp("Control").lines.some((line) => line.text.includes("/cancel reason")));
	assert.throws(() => shellHelp("missing"), /No command/);
});

test("a pending run leaves status, tasks, settings and control input responsive", async () => {
	const work = deferred<ShellReply>();
	const requests: string[] = [];
	const session = new ShellSession(
		backend(async (request) => {
			requests.push(request.name);
			if (request.name === "new") return work.promise;
			if (request.name === "status") return { overview: true };
			return { document: { title: request.name, lines: [] } };
		}, true),
		emptyDashboard("repo"),
	);
	const running = session.submit("Add the requested feature");
	assert.equal(session.state.busy, true);
	await session.submit("/status");
	await session.submit("/settings");
	await session.submit("/pause");
	assert.equal(session.state.paused, true);
	await session.submit("/resume");
	assert.equal(session.state.paused, false);
	await session.submit("/tasks");
	assert.equal(session.state.document?.title, "tasks");
	await session.submit("/new conflicting second goal");
	assert.deepEqual(requests, ["new", "status", "settings", "pause", "resume", "tasks"]);
	work.resolve({ overview: true, notice: "Finished" });
	await running;
	assert.equal(session.state.busy, false);
	assert.equal(
		session.state.document?.title,
		"tasks",
		"late work results must preserve the user's current detail view",
	);
	assert.equal(session.state.notice, "Finished");
});

test("failed commands preserve a usable shell and a local active run cannot silently detach", async () => {
	let active = true;
	const service = backend(async () => {
		throw new Error("request rejected");
	});
	service.localWorkActive = () => active;
	const session = new ShellSession(service, demoDashboard());
	let quits = 0;
	session.onQuit = () => quits++;
	await session.submit("/continue");
	assert.equal(session.state.busy, false);
	assert.equal(session.state.error, "request rejected");
	await session.submit("/quit");
	assert.equal(quits, 0);
	assert.match(session.state.notice ?? "", /\/cancel.*Ctrl\+C.*\/continue/);
	active = false;
	await session.submit("/quit");
	assert.equal(quits, 1);
	await session.submit("/help");
	assert.equal(session.state.error, undefined);
});

test("a daemon job permits closing the interface without issuing cancel", async () => {
	const work = deferred<ShellReply>();
	const requests: ShellRequest[] = [];
	const session = new ShellSession(
		backend(async (request) => {
			requests.push(request);
			return work.promise;
		}),
		demoDashboard(),
	);
	let closed = false;
	session.onQuit = () => {
		closed = true;
	};
	const running = session.submit("/continue");
	await session.submit("/quit");
	assert.equal(closed, true);
	assert.deepEqual(
		requests.map((request) => request.name),
		["continue"],
	);
	work.resolve({});
	await running;
});

test("shell overview hides internal identifiers and shows decisions before delivery actions", () => {
	const snapshot = demoDashboard();
	const text = overviewDocument(snapshot)
		.lines.map((line) => line.text)
		.join("\n");
	assert.ok(!text.includes(snapshot.run?.id ?? ""));
	for (const task of snapshot.tasks) assert.ok(!text.includes(task.id));
	snapshot.decisions = [{ id: "internal-decision-id", question: "Choose the supported API", options: ["A", "B"] }];
	assert.match(
		overviewDocument(snapshot)
			.lines.map((line) => line.text)
			.join("\n"),
		/Choose the supported API[\s\S]*\/decisions/,
	);
	const detail = tasksDocument(snapshot, "1");
	assert.ok(detail.lines.some((line) => line.text.includes(snapshot.tasks[0]?.id ?? "")));
	assert.throws(() => tasksDocument(snapshot, "99"), /Task not found/);
});

test("all shell documents stay inside narrow CJK terminals and reject external terminal control", () => {
	const poison = (value: unknown): unknown =>
		typeof value === "string"
			? attack + value + attack
			: Array.isArray(value)
				? value.map(poison)
				: value && typeof value === "object"
					? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, poison(entry)]))
					: value;
	const snapshot = poison(demoDashboard()) as DashboardSnapshot;
	assert.ok(snapshot.run);
	snapshot.run.objective += "中文实现🙂 ".repeat(30);
	const session = new ShellSession(backend(), snapshot);
	session.state.notice = attack + "继续运行或查看结果 中文".repeat(20);
	for (const color of [false, true])
		for (const width of [1, 8, 24, 40, 80, 160])
			for (const height of [1, 3, 12, 24, 40]) {
				for (const document of [
					undefined,
					shellHelp(),
					{ title: attack + "中文文档", lines: [{ text: attack + "正文".repeat(100) }] },
				]) {
					session.state.document = document;
					const lines = renderShell(session.state, { width, height, color });
					assert.ok(lines.length <= height);
					for (const line of lines) {
						assertSafeLine(line);
						assert.ok(visibleWidth(line) <= width, `overflow at ${width}x${height}`);
					}
				}
			}
});

test("settings landing page is short and full whitelisted values remain queryable", async (context) => {
	const f = await fixture(context);
	await writeFile(
		f.file,
		JSON.stringify({
			apiKey: "synthetic-secret-must-not-display",
			execution: { tokenLimit: 12345 },
			candidateChecks: [
				{ name: "check-source", argv: ["git", "diff", "--check"], timeoutMs: 1000, lane: "LIGHT_CHECK" },
			],
		}),
	);
	const snapshot = await loadSettings(f.repository);
	const summary = settingsDocument(snapshot)
		.lines.map((line) => line.text)
		.join("\n");
	assert.match(summary, /12345/);
	assert.match(summary, /\/settings roles/);
	assert.doesNotMatch(summary, /maxPlanningTokens|synthetic-secret|check-source/);
	const all = settingsDocument(snapshot, "all")
		.lines.map((line) => line.text)
		.join("\n");
	for (const group of snapshot.groups)
		for (const setting of group.settings) assert.ok(all.includes(setting.key), setting.key);
	const checks = settingsDocument(snapshot, "candidateChecks")
		.lines.map((line) => line.text)
		.join("\n");
	assert.match(checks, /"argv"[\s\S]*"git"[\s\S]*"--check"/);
	assert.doesNotMatch(all + checks, /synthetic-secret/);
	assert.throws(() => settingsDocument(snapshot, "apiKey"), /not found/);
});

test("shell model and settings commands persist validated next-run configuration without creating a run", async (context) => {
	const f = await fixture(context);
	const service = new WorkspaceShellBackend(f.repository);
	const initial = await service.execute(parseShellRequest("/settings"));
	assert.match(initial.document?.title ?? "", /next run/);
	await assert.rejects(access(f.file), { code: "ENOENT" });
	const changed = await service.execute(parseShellRequest("/settings execution.tokenLimit 12000"));
	assert.match(changed.notice ?? "", /next run.*frozen/);
	await service.execute(parseShellRequest("/model all fixture/model-a high"));
	await service.execute(parseShellRequest("/model reviewer fixture/model-b low"));
	let settings = await loadSettings(f.repository);
	assert.equal(settings.values.execution?.tokenLimit, 12000);
	for (const role of AGENT_ROLES)
		assert.deepEqual(settings.values.execution?.roles?.[role], {
			provider: "fixture",
			model: role === "reviewer" ? "model-b" : "model-a",
			reasoning: role === "reviewer" ? "low" : "high",
		});
	const models = await service.execute(parseShellRequest("/models"));
	assert.match(models.document?.title ?? "", /next run/);
	assert.match(models.document?.lines.map((line) => line.text).join("\n") ?? "", /reviewer.*fixture\/model-b/);
	const before = await readFile(f.file, "utf8");
	await assert.rejects(service.execute(parseShellRequest("/settings execution.maxParallelism 0")));
	assert.equal(await readFile(f.file, "utf8"), before);
	await service.execute(parseShellRequest("/model reviewer default"));
	await service.execute(parseShellRequest("/settings reset execution.tokenLimit"));
	settings = await loadSettings(f.repository);
	assert.equal(settings.values.execution?.roles?.reviewer, undefined);
	assert.equal(settings.values.execution?.tokenLimit, undefined);
	await assert.rejects(access(projectPaths(f.repository).database), { code: "ENOENT" });
	assert.ok(!(await readdir(f.repository)).includes("should-not-exist"));
});

test("local shell routes control to the live orchestrator and closes it only after work settles", async (context) => {
	const f = await fixture(context);
	const work = deferred<unknown>();
	const discover = deferred<DaemonClient | null>();
	context.mock.method(DaemonClient, "discover", () => discover.promise);
	const calls: string[] = [];
	const local = {
		run: async (goal: string) => {
			calls.push(goal);
			return work.promise;
		},
		resources: { pause: () => calls.push("pause"), resume: () => calls.push("resume") },
		cancel: async (run: string, reason: string) => {
			calls.push(`cancel:${run}:${reason}`);
		},
		close: () => calls.push("close"),
	} as unknown as LocalOrchestrator;
	context.mock.method(LocalOrchestrator, "open", async () => local);
	const service = new WorkspaceShellBackend(f.repository);
	context.mock.method(service, "snapshot", async () => demoDashboard());
	const running = service.execute(parseShellRequest("中文目标"));
	assert.equal(service.localWorkActive(), true, "quit must be guarded even while daemon discovery is unresolved");
	discover.resolve(null);
	await tick();
	await service.execute(parseShellRequest("/pause"));
	await service.execute(parseShellRequest("/resume"));
	await service.execute(parseShellRequest("/cancel user changed priorities"));
	assert.deepEqual(calls, ["中文目标", "pause", "resume", "cancel:demo-run:user changed priorities"]);
	assert.equal(service.localWorkActive(), true);
	work.resolve({ state: "CANCELLED" });
	await running;
	assert.equal(service.localWorkActive(), false);
	assert.equal(calls.at(-1), "close");
});

test("shell continue reaches recovery even when the read-only dashboard cannot read old schema", async (context) => {
	const f = await fixture(context);
	context.mock.method(DaemonClient, "discover", async () => null);
	let selected: string | undefined = "not-called";
	context.mock.method(
		LocalOrchestrator,
		"open",
		async () =>
			({
				continue: async (id?: string) => {
					selected = id;
					return { state: "OPEN" };
				},
				close() {},
			}) as unknown as LocalOrchestrator,
	);
	const service = new WorkspaceShellBackend(f.repository);
	context.mock.method(service, "snapshot", async () => {
		throw new Error("migration required");
	});
	await service.execute(parseShellRequest("/continue"));
	assert.equal(selected, undefined);
	await service.execute(parseShellRequest("/continue run-older"));
	assert.equal(selected, "run-older");
});

test("public Pi input keeps focus, completes commands, recalls history and sanitizes pasted controls", async (context) => {
	const requests: string[] = [];
	const session = new ShellSession(
		backend(async (request) => {
			requests.push(request.name);
			return {};
		}),
		emptyDashboard("repo"),
	);
	const terminal = new MemoryTerminal();
	const screen = new ShellScreen(session, false, terminal);
	context.after(() => screen.stop());
	screen.start(() => {});
	terminal.input("/stat");
	terminal.input("\t");
	assert.equal(screen.input.getValue(), "/status ");
	terminal.input("\r");
	await tick();
	assert.deepEqual(requests, ["status"]);
	terminal.input("\x1b[A");
	assert.equal(screen.input.getValue(), "/status ");
	terminal.input("\x1b");
	assert.equal(screen.input.getValue(), "");
	terminal.input("\x1b[200~" + attack + "中文输入" + "\x1b[201~");
	assertSafeLine(screen.input.getValue());
	assert.match(screen.input.getValue(), /中文输入/);
	assert.equal(clean(screen.input.getValue()), "中文输入");
	terminal.columns = 24;
	terminal.rows = 12;
	terminal.resize();
	await tick();
	screen.stop();
	screen.stop();
	assert.equal(terminal.stops, 1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
	test("shell restores terminal and listeners before returning an explicit " + signal + " exit status", (context) => {
		context.mock.method(TuiMainScreen.prototype, "start", () => {});
		const stop = context.mock.method(TuiMainScreen.prototype, "stop", () => {});
		const before = process.listeners(signal);
		const screen = new ShellScreen(new ShellSession(backend(), demoDashboard()), false);
		context.after(() => screen.stop());
		screen.start(() => {});
		const handler = process.listeners(signal).find((listener) => !before.includes(listener));
		assert.ok(handler);
		handler(signal);
		assert.equal(stop.mock.callCount(), 1);
		assert.deepEqual(process.listeners(signal), before);
		assert.equal(screen.exitCode, signal === "SIGINT" ? 130 : 143);
	});

for (const signal of ["SIGINT", "SIGTERM"] as const)
	test(
		"the actual CLI exits with interruption status after " + signal + " and restores stderr first",
		async (context) => {
			const f = await fixture(context);
			// Keep the input pipe alive like a real terminal, then remove it during stop. The
			// real main entrypoint and OS signal must still return 130/143 with no UI handles.
			const bootstrap = `
import { TuiMainScreen } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-tui"))};
Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true });
const originalStderr = process.stderr.write;
TuiMainScreen.prototype.start = function () { process.stdin.resume(); process.stdout.write('TTY_READY\\n'); };
TuiMainScreen.prototype.stop = function () { process.stdin.pause(); process.stdout.write('TERMINAL_RESTORED\\n'); };
process.once('exit', () => process.stdout.write(process.stderr.write === originalStderr ? 'STDERR_RESTORED\\n' : 'STDERR_NOT_RESTORED\\n'));
process.argv = [process.execPath, 'cli', 'shell', ${JSON.stringify(f.repository)}];
await import(${JSON.stringify(new URL("../../src/cli/main.ts", import.meta.url).href)});
`;
			const child = spawn(
				process.execPath,
				["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", bootstrap],
				{
					cwd: f.repository,
					env: {
						PATH: process.env.PATH,
						TERM: "xterm-256color",
						NO_COLOR: "1",
						PI_CODING_AGENT_DIR: join(f.root, "pi"),
						TRIPLETEAM_STATE_DIR: join(f.root, "state"),
					},
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			let stdout = "";
			let stderr = "";
			let signalled = false;
			context.after(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			});
			child.stdout.setEncoding("utf8").on("data", (text: string) => {
				stdout += text;
				if (!signalled && stdout.includes("TTY_READY")) {
					signalled = true;
					child.kill(signal);
				}
			});
			child.stderr.setEncoding("utf8").on("data", (text: string) => {
				stderr += text;
			});
			const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
				const timeout = setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error("CLI interruption timed out: " + stdout + stderr));
				}, 15000);
				child.once("error", (error) => {
					clearTimeout(timeout);
					reject(error);
				});
				child.once("close", (code, signal) => {
					clearTimeout(timeout);
					resolve({ code, signal });
				});
			});
			assert.deepEqual(result, { code: signal === "SIGINT" ? 130 : 143, signal: null }, stdout + stderr);
			assert.match(stdout, /TERMINAL_RESTORED[\s\S]*Interrupted\.[\s\S]*STDERR_RESTORED/);
			assert.doesNotMatch(stdout, /Workspace closed|STDERR_NOT_RESTORED/);
		},
	);

test("a shell terminal startup failure removes its listeners and restores the terminal", (context) => {
	context.mock.method(TuiMainScreen.prototype, "start", () => {
		throw new Error("terminal startup failed");
	});
	const stop = context.mock.method(TuiMainScreen.prototype, "stop", () => {});
	const before = new Map(["SIGINT", "SIGTERM", "exit"].map((signal) => [signal, process.rawListeners(signal)]));
	const screen = new ShellScreen(new ShellSession(backend(), demoDashboard()), false);
	assert.throws(() => screen.start(() => {}), /startup failed/);
	assert.equal(stop.mock.callCount(), 1);
	for (const [signal, listeners] of before) assert.deepEqual(process.rawListeners(signal), listeners);
});

test("stderr capture creates a private bounded log on demand and restores the original stream", async (context) => {
	const f = await fixture(context);
	let output = "";
	const stream = new Writable({
		write(chunk, _encoding, done) {
			output += chunk.toString();
			done();
		},
	});
	const original = stream.write;
	const diagnostics = new ShellDiagnostics(join(f.root, "logs"));
	let updates = 0;
	diagnostics.attach(
		() => updates++,
		(error) => {
			throw error;
		},
		stream as typeof process.stderr,
	);
	context.after(() => diagnostics.restore());
	await assert.rejects(access(join(f.root, "logs")), { code: "ENOENT" });
	let completed = false;
	stream.write(attack + "worker diagnostic\n", () => {
		completed = true;
	});
	await tick();
	assert.equal(completed, true);
	assert.equal(output, "");
	assert.equal(updates, 1);
	assert.equal((await stat(diagnostics.file)).mode & 0o777, 0o600);
	assert.match(await readFile(diagnostics.file, "utf8"), /worker diagnostic/);
	for (const line of diagnostics.document().lines) assertSafeLine(line.text);
	stream.write("a".repeat(3 * 1024 * 1024));
	stream.write("recent final diagnostic\n");
	assert.ok((await stat(diagnostics.file)).size < 2 * 1024 * 1024 + 100);
	assert.match(
		diagnostics
			.document()
			.lines.map((line) => line.text)
			.join("\n"),
		/recent final diagnostic/,
	);
	diagnostics.restore();
	diagnostics.restore();
	assert.equal(stream.write, original);
	stream.write("after restore");
	assert.equal(output, "after restore");
});

test("a failed diagnostic log restores stderr and forwards the original error output", async (context) => {
	const f = await fixture(context);
	const badDirectory = join(f.root, "not-a-directory");
	await writeFile(badDirectory, "occupied");
	let output = "";
	const stream = new Writable({
		write(chunk, _encoding, done) {
			output += chunk.toString();
			done();
		},
	});
	const original = stream.write;
	const diagnostics = new ShellDiagnostics(badDirectory);
	let failure: Error | undefined;
	diagnostics.attach(
		() => {},
		(error) => {
			failure = error;
		},
		stream as typeof process.stderr,
	);
	let completed = false;
	stream.write("must remain visible", () => {
		completed = true;
	});
	await tick();
	assert.ok(failure);
	assert.equal(completed, true);
	assert.equal(stream.write, original);
	assert.equal(output, "must remain visible");
});

test("showShell propagates startup failure and restores stderr capture", async (context) => {
	const f = await fixture(context);
	for (const stream of [process.stdin, process.stdout]) {
		const original = Object.getOwnPropertyDescriptor(stream, "isTTY");
		Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
		context.after(() => {
			if (original) Object.defineProperty(stream, "isTTY", original);
			else Reflect.deleteProperty(stream, "isTTY");
		});
	}
	const term = process.env.TERM;
	process.env.TERM = "xterm-256color";
	context.after(() => {
		if (term === undefined) delete process.env.TERM;
		else process.env.TERM = term;
	});
	const original = process.stderr.write;
	context.mock.method(ProcessTerminal.prototype, "clearScreen", () => {});
	context.mock.method(TuiMainScreen.prototype, "start", () => {
		throw new Error("injected startup failure");
	});
	context.mock.method(TuiMainScreen.prototype, "stop", () => {});
	await assert.rejects(
		showShell({ args: [], json: false, plain: false, color: false, watch: false }, f.repository),
		/injected startup failure/,
	);
	assert.equal(process.stderr.write, original);
});

test("blocked delivery explains recovery and reserves Git review guidance for an actual delivery ref", async (context) => {
	const snapshot = demoDashboard();
	assert.ok(snapshot.run);
	snapshot.run.state = "BLOCKED";
	snapshot.run.reason = "Independent verification design could not validate the control.";
	snapshot.delivery = { result: "BLOCKED", ref: null, tree: "exact-tree", manifest: "evidence.json" };
	context.mock.method(DaemonClient, "discover", async () => ({ result: async () => ({}) }) as unknown as DaemonClient);
	const service = new WorkspaceShellBackend("repo");
	context.mock.method(service, "snapshot", async () => snapshot);
	const blocked = await service.execute(parseShellRequest("/delivery"));
	const blockedText = blocked.document?.lines.map((line) => line.text).join("\n") ?? "";
	assert.match(blockedText, /Independent verification.*\nUse \/tasks.*\/continue/);
	assert.match(blockedText, /evidence.json/);
	assert.doesNotMatch(blockedText, /Git ref.*none|Review the delivery ref/);
	snapshot.run.state = "COMPLETED";
	snapshot.delivery = { ...snapshot.delivery, result: "VERIFIED_DELIVERY", ref: "refs/tripleteam/delivery" };
	const complete = await service.execute(parseShellRequest("/delivery"));
	assert.match(
		complete.document?.lines.map((line) => line.text).join("\n") ?? "",
		/Git ref.*refs\/tripleteam\/delivery[\s\S]*Review the delivery ref/,
	);
});
