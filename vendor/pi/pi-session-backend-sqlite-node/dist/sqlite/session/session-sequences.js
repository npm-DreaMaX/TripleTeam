import { sql } from "../sql.js";
export function readNextSeq(db, sessionId) {
    const row = sql `SELECT next_seq FROM sessions WHERE id = ${sessionId}`.get(db);
    if (row === undefined)
        throw new Error(`Unknown SQLite session: ${sessionId}`);
    return row.next_seq;
}
export function advanceNextSeq(db, sessionId, nextSeq) {
    const result = sql `UPDATE sessions SET next_seq = ${nextSeq} WHERE id = ${sessionId}`.run(db);
    if (result.changes !== 1)
        throw new Error(`Expected to update one SQLite session ${sessionId}, updated ${result.changes}`);
}
//# sourceMappingURL=session-sequences.js.map