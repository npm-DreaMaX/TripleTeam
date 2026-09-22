import type { SessionMetadata } from "@earendil-works/pi-agent-core";
import type { SqliteDatabase } from "../types.ts";
export interface SessionRow {
    id: string;
    created_at: number;
    parent_session_id: string | null;
    storage_version: number;
    metadata: string | null;
    message_count: number;
    usage_payload: string;
    next_seq: number;
}
export interface SqliteSessionMetadata extends SessionMetadata {
    /** SQLite container/shard path containing this session. */
    path: string;
}
export declare function readSessionRow(db: SqliteDatabase, sessionId: string): SessionRow;
export declare function readAllSessionRows(db: SqliteDatabase): SessionRow[];
export declare function hasSessionRow(db: SqliteDatabase, sessionId: string): boolean;
export declare function metadataFromSessionRow(path: string, row: SessionRow, currentStorageVersion: number): SqliteSessionMetadata;
export declare function insertSessionRow(db: SqliteDatabase, metadata: SqliteSessionMetadata, storageVersion: number, nextSeq: number): void;
export declare function deleteSessionRows(db: SqliteDatabase, sessionId: string): void;
//# sourceMappingURL=session-row.d.ts.map