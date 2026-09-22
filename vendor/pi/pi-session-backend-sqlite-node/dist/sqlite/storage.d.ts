import type { CommitResult, Context, Entry, EntryScan, EntryStructure, ForkOptions, ListElement, ListReadOptions, SessionStats, Storage, StorageBranchScan, StoredValue, UsageRow, UsageScan, Value, ValueList, Write } from "@earendil-works/pi-agent-core";
import type { SqliteDatabase } from "./types.ts";
export interface SqliteStorageOptions {
    sessionId: string;
    now?: () => number;
}
export interface SqliteStorageSnapshot {
    entries: Entry[];
    scalarValues: StoredValue<unknown>[];
    entriesComplete: boolean;
}
export declare class SqliteStorage implements Storage {
    private readonly db;
    private readonly sessionId;
    private readonly now;
    private readonly entryWriter;
    private readonly usageWriter;
    private commitQueue;
    private state;
    private closePromise;
    constructor(db: SqliteDatabase, options: SqliteStorageOptions);
    commit(writes: Write[], _context: Context): Promise<CommitResult>;
    getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>>;
    getValue<T>(address: Value<T>, _context: Context): Promise<StoredValue<T> | undefined>;
    scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]>;
    readList<T>(address: ValueList<T>, options: ListReadOptions | undefined, _context: Context): Promise<ListElement<T>[]>;
    scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]>;
    scanBranchStructure(query: StorageBranchScan, _context: Context): Promise<EntryStructure[]>;
    scanEntries(query: EntryScan, _context: Context): Promise<Entry[]>;
    scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]>;
    getStats(_context: Context): Promise<SessionStats>;
    snapshot(options: ForkOptions, _context: Context): Promise<SqliteStorageSnapshot>;
    private readSnapshot;
    private readSnapshotEntries;
    private applyCommit;
    close(_context: Context): Promise<void>;
}
//# sourceMappingURL=storage.d.ts.map