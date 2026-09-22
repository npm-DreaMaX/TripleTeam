import { resolveListReadOptions, value, } from "@earendil-works/pi-agent-core";
import { sql } from "../sql.js";
export function setScalarValueRow(db, sessionId, namespace, key, seq, storedValue) {
    sql `INSERT INTO scalar_values (session_id, namespace, key, seq, value)
		VALUES (${sessionId}, ${namespace}, ${key}, ${seq}, ${JSON.stringify(storedValue)})
		ON CONFLICT(session_id, namespace, key) DO UPDATE SET seq = excluded.seq, value = excluded.value`.run(db);
}
export function deleteScalarValueRow(db, sessionId, namespace, key) {
    sql `DELETE FROM scalar_values
		WHERE session_id = ${sessionId} AND namespace = ${namespace} AND key = ${key}`.run(db);
}
export function appendListValueRow(db, sessionId, namespace, key, seq, element) {
    sql `INSERT INTO list_values (session_id, namespace, key, seq, value)
		VALUES (${sessionId}, ${namespace}, ${key}, ${seq}, ${JSON.stringify(element)})`.run(db);
}
export function deleteListValueRows(db, sessionId, namespace, key) {
    sql `DELETE FROM list_values
		WHERE session_id = ${sessionId} AND namespace = ${namespace} AND key = ${key}`.run(db);
}
function decodeScalarValueRow(address, row) {
    if (row.namespace !== address.namespace || row.key !== address.key) {
        throw new Error(`Expected value ${address.namespace}:${address.key}, found ${row.namespace}:${row.key}`);
    }
    return { address, seq: row.seq, value: JSON.parse(row.value) };
}
export function readScalarValueRow(db, sessionId, address) {
    const row = sql `SELECT namespace, key, seq, value FROM scalar_values
		WHERE session_id = ${sessionId} AND namespace = ${address.namespace} AND key = ${address.key}`.get(db);
    return row === undefined ? undefined : decodeScalarValueRow(address, row);
}
export function readAllScalarValueRows(db, sessionId) {
    return sql `SELECT namespace, key, seq, value FROM scalar_values
		WHERE session_id = ${sessionId} ORDER BY seq ASC`
        .all(db)
        .map((row) => ({
        address: value(row.namespace, row.key),
        seq: row.seq,
        value: JSON.parse(row.value),
    }));
}
function nextPrefixBoundary(prefix) {
    if (prefix === "")
        return undefined;
    const codePoints = Array.from(prefix);
    for (let index = codePoints.length - 1; index >= 0; index--) {
        const codePoint = codePoints[index]?.codePointAt(0);
        if (codePoint === undefined)
            throw new Error("Invalid value key prefix");
        if (codePoint < 0x10ffff) {
            const nextCodePoint = codePoint >= 0xd7ff && codePoint < 0xe000 ? 0xe000 : codePoint + 1;
            return `${codePoints.slice(0, index).join("")}${String.fromCodePoint(nextCodePoint)}`;
        }
    }
    return undefined;
}
export function scanScalarValueRows(db, sessionId, prefix) {
    const upperBound = nextPrefixBoundary(prefix.key);
    const rows = upperBound === undefined
        ? sql `SELECT namespace, key, seq, value FROM scalar_values
				WHERE session_id = ${sessionId} AND namespace = ${prefix.namespace} AND key >= ${prefix.key}
				ORDER BY key ASC`.all(db)
        : sql `SELECT namespace, key, seq, value FROM scalar_values
				WHERE session_id = ${sessionId} AND namespace = ${prefix.namespace} AND key >= ${prefix.key} AND key < ${upperBound}
				ORDER BY key ASC`.all(db);
    return rows.map((row) => decodeScalarValueRow(value(row.namespace, row.key), row));
}
export function listValueReadQuery(sessionId, address, options) {
    const resolved = resolveListReadOptions(options);
    if (resolved.order === "asc") {
        return resolved.cursor === undefined
            ? sql `SELECT seq, value FROM list_values
				WHERE session_id = ${sessionId} AND namespace = ${address.namespace} AND key = ${address.key}
				ORDER BY seq ASC LIMIT ${resolved.limit}`
            : sql `SELECT seq, value FROM list_values
				WHERE session_id = ${sessionId} AND namespace = ${address.namespace} AND key = ${address.key} AND seq > ${resolved.cursor.seq}
				ORDER BY seq ASC LIMIT ${resolved.limit}`;
    }
    return resolved.cursor === undefined
        ? sql `SELECT seq, value FROM list_values
			WHERE session_id = ${sessionId} AND namespace = ${address.namespace} AND key = ${address.key}
			ORDER BY seq DESC LIMIT ${resolved.limit}`
        : sql `SELECT seq, value FROM list_values
			WHERE session_id = ${sessionId} AND namespace = ${address.namespace} AND key = ${address.key} AND seq < ${resolved.cursor.seq}
			ORDER BY seq DESC LIMIT ${resolved.limit}`;
}
export function readListValueRows(db, sessionId, address, options) {
    return listValueReadQuery(sessionId, address, options)
        .all(db)
        .map((row) => ({ seq: row.seq, value: JSON.parse(row.value) }));
}
//# sourceMappingURL=values.js.map