import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadProjectConfig } from "../../src/config/project.ts";
import { LocalResourceGovernor } from "../../src/control/resource-governor.ts";
import { createDemoProject } from "../../src/demo/project.ts";
import { CheckRunner } from "../../src/verification/check-runner.ts";

test("demo creates a real clean repo with passing legacy gates and failing new-feature acceptance", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "tripleteam-demo-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, "atlas");
	const demo = await createDemoProject(repo);
	await assert.rejects(createDemoProject(repo), /EEXIST/);
	const config = await loadProjectConfig(repo);
	const runner = new CheckRunner(new LocalResourceGovernor());
	const context = {
		cwd: repo,
		baseCommit: demo.inputCommit,
		subjectCommit: demo.inputCommit,
		runInputCommit: demo.inputCommit,
		artifactDirectory: join(root, "evidence"),
	};
	for (const check of config.integrationChecks) assert.equal((await runner.run(check, context)).state, "PASSED");
	const [legacy, feature] = config.runChecks;
	assert.ok(legacy && feature);
	assert.equal((await runner.run(legacy, context)).state, "PASSED");
	assert.equal((await runner.run(feature, context)).state, "FAILED");
	assert.equal((await promisify(execFile)("git", ["-C", repo, "status", "--porcelain"])).stdout, "");
});
