import assert from "node:assert/strict";
import test from "node:test";
import { OperationJournal } from "../../src/control/operation-journal.ts";
import { openControlDatabase } from "../../src/store/database.ts";

test("operation journal makes side-effect intent idempotent and recoverable", async (context) => {
	const database = await openControlDatabase(":memory:");
	context.after(() => database.close());
	const journal = new OperationJournal(database);
	const operation = journal.ensure({
		kind: "CREATE_WORKTREE",
		aggregateType: "ATTEMPT",
		aggregateId: "attempt-1",
		desiredState: { base: "abc" },
		idempotencyKey: "worktree:attempt-1",
	});
	assert.equal(
		journal.ensure({
			kind: "CREATE_WORKTREE",
			aggregateType: "ATTEMPT",
			aggregateId: "attempt-1",
			desiredState: { base: "abc" },
			idempotencyKey: "worktree:attempt-1",
		}).id,
		operation.id,
	);
	await assert.rejects(() =>
		journal.execute(operation, async () => {
			throw new Error("disk unavailable");
		}),
	);
	assert.equal(journal.recoverable()[0]?.phase, "FAILED");
	const result = await journal.execute(operation, async () => ({ path: "/tmp/worktree" }));
	assert.deepEqual(result, { path: "/tmp/worktree" });
	const replayed = await journal.execute(operation, async () => {
		throw new Error("completed operations must not repeat their side effect");
	});
	assert.deepEqual(replayed, { path: "/tmp/worktree" });
	assert.equal(journal.recoverable().length, 0);
});
