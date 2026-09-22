import { sql } from "../sql.js";
import { readSessionRow } from "./session-row.js";
function addUsage(left, right) {
    return {
        input: left.input + right.input,
        output: left.output + right.output,
        cacheRead: left.cacheRead + right.cacheRead,
        cacheWrite: left.cacheWrite + right.cacheWrite,
        ...(left.cacheWrite1h === undefined && right.cacheWrite1h === undefined
            ? {}
            : { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }),
        ...(left.reasoning === undefined && right.reasoning === undefined
            ? {}
            : { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }),
        totalTokens: left.totalTokens + right.totalTokens,
        cost: {
            input: left.cost.input + right.cost.input,
            output: left.cost.output + right.cost.output,
            cacheRead: left.cost.cacheRead + right.cost.cacheRead,
            cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
            total: left.cost.total + right.cost.total,
        },
    };
}
export function readSessionStats(db, sessionId) {
    const row = readSessionRow(db, sessionId);
    return {
        messageCount: row.message_count,
        usage: JSON.parse(row.usage_payload),
    };
}
export function incrementMessageCount(db, sessionId) {
    sql `UPDATE sessions SET message_count = message_count + 1 WHERE id = ${sessionId}`.run(db);
}
export function addUsageToSessionStats(db, sessionId, usage) {
    const current = readSessionStats(db, sessionId).usage;
    sql `UPDATE sessions SET usage_payload = ${JSON.stringify(addUsage(current, usage))} WHERE id = ${sessionId}`.run(db);
}
//# sourceMappingURL=session-stats.js.map