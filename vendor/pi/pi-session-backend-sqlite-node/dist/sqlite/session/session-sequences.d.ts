import type { SqliteDatabase } from "../types.ts";
export declare function readNextSeq(db: SqliteDatabase, sessionId: string): number;
export declare function advanceNextSeq(db: SqliteDatabase, sessionId: string, nextSeq: number): void;
//# sourceMappingURL=session-sequences.d.ts.map