import type { SessionStats, UsageRow } from "@earendil-works/pi-agent-core";
import type { SqliteDatabase } from "../types.ts";
export declare function readSessionStats(db: SqliteDatabase, sessionId: string): SessionStats;
export declare function incrementMessageCount(db: SqliteDatabase, sessionId: string): void;
export declare function addUsageToSessionStats(db: SqliteDatabase, sessionId: string, usage: UsageRow["usage"]): void;
//# sourceMappingURL=session-stats.d.ts.map