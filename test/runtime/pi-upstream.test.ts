import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PiWorkerLauncher } from "../../src/runtime/pi/launcher.ts";
import { resolvePiCliPath } from "../../src/runtime/pi/rpc-worker.ts";
import { discoverPiAgents, PersistentSessionGuard } from "../../src/runtime/pi/upstream.ts";

test("vendored Pi package exposes the CLI used by the official RPC client", async () => {
	const cliPath = resolvePiCliPath();
	await access(cliPath);
	assert.equal(cliPath, resolve("vendor/pi/pi-coding-agent/dist/bundle/cli.js"));
});

test("standalone runtime exposes four evidence-backed default profiles", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-builtins-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	context.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	const names = new PiWorkerLauncher()
		.listProfiles(process.cwd())
		.filter((profile) => profile.source === "builtin")
		.map((profile) => profile.name);
	assert.deepEqual(names, ["explorer", "implementer", "planner", "reviewer"]);
});

test("mjakl agent discovery adapter uses the pinned upstream implementation", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-agents-"));
	context.after(() => rm(directory, { recursive: true, force: true }));

	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	context.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});

	const result = discoverPiAgents(directory, { createStarter: true });
	assert.ok(result.agents.some((agent) => agent.name === "explore"));
});

test("mjakl session guard rejects two owners for the same Pi session", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-lock-"));
	context.after(() => rm(directory, { recursive: true, force: true }));

	const target = { sessionId: "session-1", lockRoot: directory };
	const first = PersistentSessionGuard.acquire(target);
	context.after(() => first.release());

	assert.throws(() => PersistentSessionGuard.acquire(target), /already running/);
	first.release();

	const second = PersistentSessionGuard.acquire(target);
	second.release();
});

test("Pi worker launcher recovers a session lock owned by a dead control process", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-dead-lock-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const sessionDirectory = join(directory, "sessions");
	const sessionId = "resume-session";
	PersistentSessionGuard.acquire({
		sessionId,
		lockRoot: join(sessionDirectory, "locks"),
		agent: "implementer",
		cwd: directory,
	});
	const ownerFile = join(sessionDirectory, "locks", sessionId + ".lock", "owner.json");
	const owner = JSON.parse(await readFile(ownerFile, "utf8")) as Record<string, unknown>;
	await writeFile(ownerFile, JSON.stringify({ ...owner, pid: 2_147_483_647 }));

	const managed = await new PiWorkerLauncher().create({
		cwd: directory,
		sessionDirectory,
		sessionId,
		sessionName: "Recovered session",
		profileName: "implementer",
		defaultTools: ["read", "write"],
	});
	await managed.close();
});
