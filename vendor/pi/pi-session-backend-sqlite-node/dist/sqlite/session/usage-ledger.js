import { joinSqlFragments, sql } from "../sql.js";
const INSERT_USAGE_LEDGER_SQL = `INSERT INTO usage_ledger (session_id, id, seq, entry_id, adjustment, usage, details)
	VALUES (?, ?, ?, ?, ?, ?, ?)`;
function usageLedgerRowParams(sessionId, row) {
    return [
        sessionId,
        row.id,
        row.seq,
        row.entryId ?? null,
        row.adjustment ? 1 : 0,
        JSON.stringify(row.usage),
        row.details === undefined ? null : JSON.stringify(row.details),
    ];
}
export class UsageLedgerRowWriter {
    insertStatement;
    sessionId;
    constructor(db, sessionId) {
        this.insertStatement = db.prepare(INSERT_USAGE_LEDGER_SQL);
        this.sessionId = sessionId;
    }
    insert(row) {
        this.insertStatement.run(...usageLedgerRowParams(this.sessionId, row));
    }
}
export function insertUsageLedgerRow(db, sessionId, row) {
    db.prepare(INSERT_USAGE_LEDGER_SQL).run(...usageLedgerRowParams(sessionId, row));
}
export function decodeUsageLedgerRow(row) {
    return {
        id: row.id,
        seq: row.seq,
        usage: JSON.parse(row.usage),
        ...(row.entry_id === null ? {} : { entryId: row.entry_id }),
        adjustment: row.adjustment !== 0,
        ...(row.details === null ? {} : { details: JSON.parse(row.details) }),
    };
}
export function scanUsageLedgerRows(db, sessionId, query) {
    const filters = [sql `session_id = ${sessionId}`];
    if (query.fromSeq !== undefined)
        filters.push(sql `seq >= ${query.fromSeq}`);
    if (query.toSeq !== undefined)
        filters.push(sql `seq <= ${query.toSeq}`);
    const order = query.order === "desc" ? sql `ORDER BY seq DESC` : sql `ORDER BY seq ASC`;
    const limit = query.limit === undefined ? sql `` : sql `LIMIT ${Math.max(0, query.limit)}`;
    return sql `SELECT id, seq, entry_id, adjustment, usage, details
		FROM usage_ledger WHERE ${joinSqlFragments(filters, " AND ")} ${order} ${limit}`.all(db);
}
//# sourceMappingURL=usage-ledger.js.map