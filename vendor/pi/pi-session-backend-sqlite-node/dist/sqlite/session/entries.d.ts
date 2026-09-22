import type { Entry, EntryScan, EntryStructure } from "@earendil-works/pi-agent-core";
import type { SqliteDatabase } from "../types.ts";
export interface EntryRow {
    id: string;
    parent_id: string | null;
    seq: number;
    type: Entry["type"];
    custom_type: string | null;
    timestamp: number;
    payload: string;
}
export declare class EntryRowWriter {
    private readonly insertStatement;
    private readonly sessionId;
    constructor(db: SqliteDatabase, sessionId: string);
    insert(entry: Entry): void;
}
export declare function insertEntryRow(db: SqliteDatabase, sessionId: string, entry: Entry): void;
export declare function decodeEntryRow(row: EntryRow): Entry;
export declare function entryStructureFromRow(row: EntryRow): EntryStructure;
export declare function readEntryRows(db: SqliteDatabase, sessionId: string, ids: readonly string[]): EntryRow[];
export declare function readAllEntryRows(db: SqliteDatabase, sessionId: string): EntryRow[];
export declare function scanEntryRows(db: SqliteDatabase, sessionId: string, query: EntryScan): EntryRow[];
//# sourceMappingURL=entries.d.ts.map