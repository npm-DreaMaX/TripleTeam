import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { LocalControlDaemon } from "../../src/daemon/server.ts";

const execFileAsync = promisify(execFile);

test("standalone daemon binds loopback and protects control endpoints with its local token", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-daemon-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const repository = join(directory, "repo");
	await mkdir(repository);
	await execFileAsync("git", ["-C", repository, "init"]);
	await execFileAsync("git", ["-C", repository, "config", "user.name", "Test User"]);
	await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
	await writeFile(join(repository, "file.txt"), "base\n");
	await execFileAsync("git", ["-C", repository, "add", "file.txt"]);
	await execFileAsync("git", ["-C", repository, "commit", "-m", "base"]);
	const previous = process.env.TRIPLETEAM_STATE_DIR;
	process.env.TRIPLETEAM_STATE_DIR = join(directory, "state");
	context.after(() => {
		if (previous === undefined) delete process.env.TRIPLETEAM_STATE_DIR;
		else process.env.TRIPLETEAM_STATE_DIR = previous;
	});
	const daemon = await LocalControlDaemon.create(repository);
	context.after(() => daemon.stop());
	const endpoint = await daemon.start(0);
	await access(daemon.endpointFilePath);
	const origin = `http://${endpoint.host}:${endpoint.port}`;
	const health = await fetch(origin + "/health");
	assert.equal(health.status, 200);
	const unauthorized = await fetch(origin + "/v1/control/pause", { method: "POST" });
	assert.equal(unauthorized.status, 401);
	const paused = await fetch(origin + "/v1/control/pause", {
		method: "POST",
		headers: { authorization: "Bearer " + endpoint.token },
	});
	assert.equal(paused.status, 200);
	assert.equal(((await paused.json()) as { resources: { paused: boolean } }).resources.paused, true);
	const profiles = await fetch(origin + "/v1/profiles", {
		headers: { authorization: "Bearer " + endpoint.token },
	});
	assert.equal(profiles.status, 200);
	const profileNames = ((await profiles.json()) as { profiles: { name: string }[] }).profiles.map(
		(profile) => profile.name,
	);
	for (const expected of ["explorer", "planner", "implementer", "reviewer"]) {
		assert.ok(profileNames.includes(expected));
	}
	await daemon.stop();
	await assert.rejects(() => access(daemon.endpointFilePath));
});
