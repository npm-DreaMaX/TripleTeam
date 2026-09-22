import { sql } from "../sql.js";
function zeroUsage() {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}
export function readSessionRow(db, sessionId) {
    const row = sql `SELECT id, created_at, parent_session_id, storage_version, metadata,
			message_count, usage_payload, next_seq
		FROM sessions
		WHERE id = ${sessionId}`.get(db);
    if (row === undefined)
        throw new Error(`Unknown SQLite session: ${sessionId}`);
    return row;
}
export function readAllSessionRows(db) {
    return sql `SELECT id, created_at, parent_session_id, storage_version, metadata,
			message_count, usage_payload, next_seq
		FROM sessions`.all(db);
}
export function hasSessionRow(db, sessionId) {
    return sql `SELECT id FROM sessions WHERE id = ${sessionId}`.get(db) !== undefined;
}
export function metadataFromSessionRow(path, row, currentStorageVersion) {
    if (row.storage_version > currentStorageVersion) {
        throw new Error(`SQLite session storage version ${row.storage_version} is newer than ${currentStorageVersion}`);
    }
    if (row.storage_version < currentStorageVersion) {
        throw new Error(`SQLite session storage version ${row.storage_version} requires migrations`);
    }
    return {
        id: row.id,
        createdAt: row.created_at,
        storageVersion: row.storage_version,
        ...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
        path,
    };
}
export function insertSessionRow(db, metadata, storageVersion, nextSeq) {
    sql `INSERT INTO sessions
			(id, created_at, parent_session_id, storage_version, metadata, message_count, usage_payload, next_seq)
		VALUES (
			${metadata.id},
			${metadata.createdAt},
			${metadata.parentSessionId ?? null},
			${storageVersion},
			${null},
			${0},
			${JSON.stringify(zeroUsage())},
			${nextSeq}
		)`.run(db);
}
export function deleteSessionRows(db, sessionId) {
    sql `DELETE FROM entries WHERE session_id = ${sessionId}`.run(db);
    sql `DELETE FROM scalar_values WHERE session_id = ${sessionId}`.run(db);
    sql `DELETE FROM list_values WHERE session_id = ${sessionId}`.run(db);
    sql `DELETE FROM usage_ledger WHERE session_id = ${sessionId}`.run(db);
    sql `DELETE FROM branch_entries WHERE session_id = ${sessionId}`.run(db);
    sql `DELETE FROM branch_meta WHERE session_id = ${sessionId}`.run(db);
    const result = sql `DELETE FROM sessions WHERE id = ${sessionId}`.run(db);
    if (result.changes !== 1)
        throw new Error(`Expected to delete one SQLite session ${sessionId}, deleted ${result.changes}`);
}
//# sourceMappingURL=session-row.js.map