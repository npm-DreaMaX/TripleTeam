import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "@earendil-works/pi-session-backend-sqlite-node";
import type { ControlDatabase } from "../store/database.ts";

export type OperationKind =
	| "CREATE_WORKTREE"
	| "START_WORKER"
	| "SEAL_CANDIDATE"
	| "RUN_CHECK"
	| "RUN_REVIEW"
	| "UPDATE_INTEGRATION_REF"
	| "REMOVE_WORKTREE";

export interface OperationRecord {
	id: string;
	kind: OperationKind;
	aggregateType: string;
	aggregateId: string;
	desiredState: unknown;
	observedState: unknown | null;
	phase: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
	idempotencyKey: string;
	attempts: number;
	lastError: string | null;
}

interface OperationRow {
	id: string;
	kind: OperationKind;
	aggregate_type: string;
	aggregate_id: string;
	desired_state_json: string;
	observed_state_json: string | null;
	phase: OperationRecord["phase"];
	idempotency_key: string;
	attempts: number;
	last_error: string | null;
}

function now(): string {
	return new Date().toISOString();
}

function record(row: OperationRow): OperationRecord {
	return {
		id: row.id,
		kind: row.kind,
		aggregateType: row.aggregate_type,
		aggregateId: row.aggregate_id,
		desiredState: JSON.parse(row.desired_state_json) as unknown,
		observedState: row.observed_state_json === null ? null : (JSON.parse(row.observed_state_json) as unknown),
		phase: row.phase,
		idempotencyKey: row.idempotency_key,
		attempts: row.attempts,
		lastError: row.last_error,
	};
}

const SELECT =
	"SELECT id, kind, aggregate_type, aggregate_id, desired_state_json, observed_state_json, phase, idempotency_key, attempts, last_error FROM operations";

export class OperationJournal {
	private readonly db: SqliteDatabase;

	constructor(database: ControlDatabase) {
		this.db = database.sql;
	}

	ensure(input: {
		kind: OperationKind;
		aggregateType: string;
		aggregateId: string;
		desiredState: unknown;
		idempotencyKey: string;
	}): OperationRecord {
		const existing = this.byKey(input.idempotencyKey);
		if (existing) {
			if (
				existing.kind !== input.kind ||
				existing.aggregateType !== input.aggregateType ||
				existing.aggregateId !== input.aggregateId ||
				JSON.stringify(existing.desiredState) !== JSON.stringify(input.desiredState)
			) {
				throw new Error("Idempotency key was reused for a different operation: " + input.idempotencyKey);
			}
			return existing;
		}
		const id = randomUUID();
		const timestamp = now();
		this.db
			.prepare(
				"INSERT INTO operations (id, kind, aggregate_type, aggregate_id, desired_state_json, phase, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)",
			)
			.run(
				id,
				input.kind,
				input.aggregateType,
				input.aggregateId,
				JSON.stringify(input.desiredState),
				input.idempotencyKey,
				timestamp,
				timestamp,
			);
		return this.require(id);
	}

	async execute<T>(operation: OperationRecord, work: () => Promise<T>): Promise<T | undefined> {
		const current = this.require(operation.id);
		if (current.phase === "COMPLETED") return current.observedState as T | undefined;
		this.db
			.prepare(
				"UPDATE operations SET phase = 'RUNNING', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?",
			)
			.run(now(), current.id);
		try {
			const result = await work();
			this.db
				.prepare("UPDATE operations SET phase = 'COMPLETED', observed_state_json = ?, updated_at = ? WHERE id = ?")
				.run(JSON.stringify(result ?? null), now(), current.id);
			return result;
		} catch (error) {
			this.db
				.prepare("UPDATE operations SET phase = 'FAILED', last_error = ?, updated_at = ? WHERE id = ?")
				.run(error instanceof Error ? error.message : String(error), now(), current.id);
			throw error;
		}
	}

	recoverable(): OperationRecord[] {
		return this.db
			.prepare(SELECT + " WHERE phase IN ('PENDING', 'RUNNING', 'FAILED') ORDER BY created_at")
			.all<OperationRow>()
			.map(record);
	}

	find(kind: OperationKind, aggregateId: string): OperationRecord | null {
		const row = this.db
			.prepare(SELECT + " WHERE kind = ? AND aggregate_id = ? ORDER BY created_at DESC LIMIT 1")
			.get<OperationRow>(kind, aggregateId);
		return row ? record(row) : null;
	}

	markObservedCompleted(operationId: string, observedState: unknown): void {
		this.db
			.prepare(
				"UPDATE operations SET phase = 'COMPLETED', observed_state_json = ?, last_error = NULL, updated_at = ? WHERE id = ?",
			)
			.run(JSON.stringify(observedState), now(), operationId);
	}

	markInterruptedFailed(): number {
		return this.db
			.prepare(
				"UPDATE operations SET phase = 'FAILED', last_error = 'Control process exited while operation was running', updated_at = ? WHERE phase = 'RUNNING'",
			)
			.run(now()).changes;
	}

	private byKey(key: string): OperationRecord | null {
		const row = this.db.prepare(SELECT + " WHERE idempotency_key = ?").get<OperationRow>(key);
		return row ? record(row) : null;
	}

	private require(id: string): OperationRecord {
		const row = this.db.prepare(SELECT + " WHERE id = ?").get<OperationRow>(id);
		if (!row) throw new Error("Operation not found: " + id);
		return record(row);
	}
}
