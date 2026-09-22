import { joinSqlFragments, sql } from "../sql.js";
function entryPayload(entry) {
    switch (entry.type) {
        case "message": {
            const payload = {
                message: entry.message,
                ...(entry.terminate === undefined ? {} : { terminate: entry.terminate }),
            };
            return payload;
        }
        case "compaction": {
            const payload = {
                summary: entry.summary,
                retainedTail: entry.retainedTail,
                tokensBefore: entry.tokensBefore,
                ...(entry.details === undefined ? {} : { details: entry.details }),
                ...(entry.usage === undefined ? {} : { usage: entry.usage }),
                fromHook: entry.fromHook,
            };
            return payload;
        }
        case "branch_summary": {
            const payload = {
                fromId: entry.fromId,
                summary: entry.summary,
                ...(entry.details === undefined ? {} : { details: entry.details }),
                ...(entry.usage === undefined ? {} : { usage: entry.usage }),
                fromHook: entry.fromHook,
            };
            return payload;
        }
        case "custom": {
            const payload = entry.data === undefined ? {} : { data: entry.data };
            return payload;
        }
    }
}
function parsePayload(row) {
    return JSON.parse(row.payload);
}
const INSERT_ENTRY_SQL = `INSERT INTO entries (session_id, id, parent_id, seq, type, custom_type, timestamp, payload)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
function entryRowParams(sessionId, entry) {
    return [
        sessionId,
        entry.id,
        entry.parentId,
        entry.seq,
        entry.type,
        entry.type === "custom" ? entry.customType : null,
        entry.timestamp,
        JSON.stringify(entryPayload(entry)),
    ];
}
export class EntryRowWriter {
    insertStatement;
    sessionId;
    constructor(db, sessionId) {
        this.insertStatement = db.prepare(INSERT_ENTRY_SQL);
        this.sessionId = sessionId;
    }
    insert(entry) {
        this.insertStatement.run(...entryRowParams(this.sessionId, entry));
    }
}
export function insertEntryRow(db, sessionId, entry) {
    db.prepare(INSERT_ENTRY_SQL).run(...entryRowParams(sessionId, entry));
}
export function decodeEntryRow(row) {
    const base = {
        id: row.id,
        parentId: row.parent_id,
        seq: row.seq,
        timestamp: row.timestamp,
    };
    switch (row.type) {
        case "message":
            return { ...base, type: "message", ...parsePayload(row) };
        case "compaction":
            return { ...base, type: "compaction", ...parsePayload(row) };
        case "branch_summary":
            return { ...base, type: "branch_summary", ...parsePayload(row) };
        case "custom":
            if (row.custom_type === null)
                throw new Error(`Custom entry ${row.id} is missing custom_type`);
            return { ...base, type: "custom", customType: row.custom_type, ...parsePayload(row) };
    }
}
export function entryStructureFromRow(row) {
    return {
        id: row.id,
        parentId: row.parent_id,
        seq: row.seq,
        timestamp: row.timestamp,
        type: row.type,
        ...(row.custom_type === null ? {} : { customType: row.custom_type }),
    };
}
export function readEntryRows(db, sessionId, ids) {
    if (ids.length === 0)
        return [];
    const placeholders = joinSqlFragments(ids.map((id) => sql `${id}`), ", ");
    return sql `SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries
		WHERE session_id = ${sessionId} AND id IN (${placeholders})`.all(db);
}
export function readAllEntryRows(db, sessionId) {
    return sql `SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries WHERE session_id = ${sessionId} ORDER BY seq ASC`.all(db);
}
export function scanEntryRows(db, sessionId, query) {
    const filters = [sql `session_id = ${sessionId}`];
    if (query.type !== undefined)
        filters.push(sql `type = ${query.type}`);
    if (query.customType !== undefined)
        filters.push(sql `custom_type = ${query.customType}`);
    if (query.fromSeq !== undefined)
        filters.push(sql `seq >= ${query.fromSeq}`);
    if (query.toSeq !== undefined)
        filters.push(sql `seq <= ${query.toSeq}`);
    const order = query.order === "desc" ? sql `ORDER BY seq DESC` : sql `ORDER BY seq ASC`;
    const limit = query.limit === undefined ? sql `` : sql `LIMIT ${Math.max(0, query.limit)}`;
    return sql `SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries WHERE ${joinSqlFragments(filters, " AND ")} ${order} ${limit}`.all(db);
}
//# sourceMappingURL=entries.js.map