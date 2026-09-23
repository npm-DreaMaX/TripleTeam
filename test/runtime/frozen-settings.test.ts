import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { LocalOrchestrator } from "../../src/app/orchestrator.ts";
import { updateSetting } from "../../src/config/settings.ts";
import { Reconciler } from "../../src/control/reconciler.ts";

const exec = promisify(execFile);
const actor = { kind: "SYSTEM", id: "frozen-settings-test" } as const;

async function fixture(context: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-frozen-settings-"));
	const previous = { state: process.env.TRIPLETEAM_STATE_DIR, pi: process.env.PI_CODING_AGENT_DIR };
	process.env.TRIPLETEAM_STATE_DIR = join(directory, "state");
	process.env.PI_CODING_AGENT_DIR = join(directory, "pi");
	let app: LocalOrchestrator | undefined;
	context.after(async () => {
		app?.close();
		for (const [name, value] of [
			["TRIPLETEAM_STATE_DIR", previous.state],
			["PI_CODING_AGENT_DIR", previous.pi],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await rm(directory, { recursive: true, force: true });
	});
	const repository = join(directory, "repo");
	await mkdir(repository);
	await exec("git", ["init", repository]);
	await writeFile(join(repository, "source.txt"), "baseline\n");
	await exec("git", ["-C", repository, "add", "."]);
	await exec("git", [
		"-C",
		repository,
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=t@example.test",
		"commit",
		"-m",
		"baseline",
	]);
	await writeFile(
		join(repository, ".tripleteam.json"),
		JSON.stringify({
			assurance: { mode: "off" },
			execution: { policy: "SINGLE", model: "original", tokenLimit: 100000 },
		}),
	);
	app = await LocalOrchestrator.open(repository);
	return {
		repository,
		app,
		reopen: async () => {
			app?.close();
			app = await LocalOrchestrator.open(repository);
			return app;
		},
	};
}

test("new goals read settings while older goals resume with their full frozen configuration", async (context) => {
	const state = await fixture(context);
	const first = await state.app.initialize("First goal");
	const original = state.app.catalog.getRun(first.runId).goalContract;
	await updateSetting(state.repository, "execution.model", "future");
	await updateSetting(state.repository, "execution.tokenLimit", 200000);
	const second = await state.app.initialize("Second goal");
	const next = state.app.catalog.getRun(second.runId).goalContract as {
		runtimeConfiguration: { execution: { model: string } };
	};
	assert.equal(next.runtimeConfiguration.execution.model, "future");
	assert.equal(state.app.config.execution?.model, "original", "initialize must not mutate live service settings");
	const app = await state.reopen();
	assert.equal(app.config.execution?.model, "future");
	const stopped = new Error("Stop before model execution");
	context.mock.method(Reconciler.prototype, "reconcile", async () => {
		throw stopped;
	});
	await assert.rejects(app.continue(first.runId), (error) => error === stopped);
	assert.equal(app.config.execution?.model, "original");
	assert.equal(app.config.execution?.tokenLimit, 100000);
	assert.deepEqual(app.catalog.getRun(first.runId).goalContract, original);
	await assert.rejects(app.continue(second.runId), (error) => error === stopped);
	assert.equal(app.config.execution?.model, "future");
	assert.equal(app.config.execution?.tokenLimit, 200000);
});

test("initializing a queued goal cannot alter active configuration and concurrent execution is rejected", async (context) => {
	const { app, repository } = await fixture(context);
	const first = await app.initialize("Active goal");
	let entered: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release: () => void = () => {};
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	const stopped = new Error("Fixture execution stops here");
	context.mock.method(Reconciler.prototype, "reconcile", async () => {
		entered();
		await wait;
		throw stopped;
	});
	const running = app.continue(first.runId);
	void running.catch(() => {});
	await started;
	try {
		await updateSetting(repository, "execution.model", "queued-model");
		const queued = await app.initialize("Queued goal");
		assert.equal(app.config.execution?.model, "original");
		await assert.rejects(app.continue(queued.runId), /already executing/);
		assert.equal(app.config.execution?.model, "original");
	} finally {
		release();
	}
	await assert.rejects(running, (error) => error === stopped);
});

test("legacy hash-only runs reject changed settings and corrupt frozen payloads cannot start", async (context) => {
	const { app, repository } = await fixture(context);
	const current = await app.initialize("Saved run");
	const goal = app.catalog.getRun(current.runId).goalContract as Record<string, unknown>;
	const { runtimeConfiguration: _saved, ...legacy } = goal;
	app.kernel.createRun({
		id: "legacy",
		repositoryRoot: repository,
		objective: "Old run",
		inputCommit: current.inputCommit,
		integrationRef: "refs/tripleteam/test-legacy",
		goalContract: legacy,
		actor,
	});
	await updateSetting(repository, "execution.model", "changed");
	await assert.rejects(app.continue("legacy"), /legacy run stores only a configuration hash/);
	app.kernel.createRun({
		id: "corrupt",
		repositoryRoot: repository,
		objective: "Corrupt run",
		inputCommit: current.inputCommit,
		integrationRef: "refs/tripleteam/test-corrupt",
		goalContract: { ...goal, runtimeConfigurationHash: "invalid" },
		actor,
	});
	await assert.rejects(app.continue("corrupt"), /does not match its recorded hash/);
});
