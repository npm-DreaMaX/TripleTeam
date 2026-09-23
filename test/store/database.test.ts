import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeSqliteFactory } from "@earendil-works/pi-session-backend-sqlite-node";
import { openControlDatabase } from "../../src/store/database.ts";
import { MIGRATIONS } from "../../src/store/schema.ts";

test("control database creates the complete authoritative schema", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-db-"));
	context.after(() => rm(directory, { recursive: true, force: true }));

	const projectState = join(directory, "project-state");
	const databasePath = join(projectState, "state.db");
	const database = await openControlDatabase(databasePath);
	context.after(() => database.close());
	if (process.platform !== "win32") {
		assert.equal((await stat(projectState)).mode & 0o777, 0o700);
		assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
	}

	const tables = database.sql
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.all<{ name: string }>()
		.map((row) => row.name);

	for (const expected of [
		"acceptance_decisions",
		"artifacts",
		"attempts",
		"candidates",
		"check_runs",
		"coordination_assessments",
		"coordination_contracts",
		"coordination_decisions",
		"decision_requests",
		"decisions",
		"domain_events",
		"executions",
		"exploration_records",
		"failure_diagnoses",
		"integrations",
		"messages",
		"operations",
		"reviews",
		"run_reports",
		"session_bindings",
		"task_change_proposals",
		"task_graph_proposals",
		"task_revisions",
		"tasks",
		"usage_records",
	]) {
		assert.ok(tables.includes(expected), "missing table " + expected);
	}

	const version = database.sql.prepare("PRAGMA user_version").get<{ user_version: number }>();
	assert.equal(version?.user_version, 9);
});

test("legacy v1 state migrates without losing active attempt ownership", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-migration-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "state.db");
	const migration = MIGRATIONS.find((candidate) => candidate.version === 1);
	assert.ok(migration);
	const legacy = await createNodeSqliteFactory().open(path);
	legacy.exec("PRAGMA foreign_keys = ON");
	legacy.exec(migration.sql);
	legacy.exec("PRAGMA user_version = 1");
	const timestamp = new Date().toISOString();
	legacy
		.prepare(
			"INSERT INTO runs (id, repository_root, input_commit, integration_ref, integration_head, state, created_at, updated_at) VALUES ('run', '/repo', 'abc', 'refs/test', 'abc', 'OPEN', ?, ?)",
		)
		.run(timestamp, timestamp);
	legacy
		.prepare(
			"INSERT INTO tasks (id, run_id, state, risk_class, created_at, updated_at) VALUES ('task', 'run', 'ACTIVE', 'NORMAL', ?, ?)",
		)
		.run(timestamp, timestamp);
	legacy
		.prepare(
			"INSERT INTO attempts (id, task_id, epoch, state, base_commit, profile_name, profile_version, created_at, updated_at) VALUES ('attempt', 'task', 1, 'RUNNING', 'abc', 'implementer', 'v1', ?, ?)",
		)
		.run(timestamp, timestamp);
	legacy.close();

	const database = await openControlDatabase(path);
	context.after(() => database.close());
	const run = database.sql.prepare("SELECT objective FROM runs WHERE id = 'run'").get<{ objective: string }>();
	assert.equal(run?.objective, "");
	const terminal = database.sql
		.prepare("SELECT goal_contract_json, terminal_reason FROM runs WHERE id = 'run'")
		.get<{ goal_contract_json: string; terminal_reason: string | null }>();
	assert.deepEqual({ ...terminal }, { goal_contract_json: "{}", terminal_reason: null });
	const attempt = database.sql
		.prepare("SELECT run_id, task_id, workflow_function, epoch FROM attempts WHERE id = 'attempt'")
		.get<{ run_id: string; task_id: string; workflow_function: string; epoch: number }>();
	assert.deepEqual({ ...attempt }, { run_id: "run", task_id: "task", workflow_function: "IMPLEMENT", epoch: 1 });
	assert.deepEqual(database.sql.prepare("PRAGMA foreign_key_check").all(), []);
});
