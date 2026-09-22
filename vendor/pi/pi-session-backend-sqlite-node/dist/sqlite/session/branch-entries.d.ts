import type { Entry, EntryStructure, StorageBranchScan } from "@earendil-works/pi-agent-core";
import type { SqliteDatabase } from "../types.ts";
export declare function appendEntryToBranchIndex(db: SqliteDatabase, sessionId: string, entry: Entry): void;
export declare function scanBranchEntries(db: SqliteDatabase, sessionId: string, query: StorageBranchScan): Entry[];
export declare function scanBranchEntryStructures(db: SqliteDatabase, sessionId: string, query: StorageBranchScan): EntryStructure[];
//# sourceMappingURL=branch-entries.d.ts.map