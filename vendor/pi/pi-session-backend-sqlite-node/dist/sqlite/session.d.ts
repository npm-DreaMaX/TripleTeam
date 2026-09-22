import type { Branch, Context, Entry, EntryQuery, ListElement, ListReadOptions, Session, SessionMutation, SessionMutationCallback, SessionStats, StorageBranchScan, StoredValue, Value, ValueList } from "@earendil-works/pi-agent-core";
import type { SqliteSessionMetadata } from "./session/session-row.ts";
export interface SqliteOpenSessionOptions {
    onClose: () => void;
}
/** SQLite-specific open-session lifecycle wrapper. */
export declare class SqliteOpenSession implements Session<SqliteSessionMetadata> {
    readonly metadata: SqliteSessionMetadata;
    readonly idGenerator: Session<SqliteSessionMetadata>["idGenerator"];
    private readonly session;
    private readonly onClose;
    private readonly admitted;
    private readonly closedError;
    private state;
    private closePromise;
    constructor(session: Session<SqliteSessionMetadata>, options: SqliteOpenSessionOptions);
    beginMutation(context: Context): Promise<SessionMutation>;
    mutate<T>(mutation: SessionMutationCallback<T>, context: Context): Promise<T>;
    getEntries(ids: string[], context: Context): Promise<Map<string, Entry>>;
    getEntry(id: string, context: Context): Promise<Entry | undefined>;
    getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined>;
    scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]>;
    readList<T>(address: ValueList<T>, options: ListReadOptions | undefined, context: Context): Promise<ListElement<T>[]>;
    scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]>;
    getStats(context: Context): Promise<SessionStats>;
    getName(context: Context): Promise<string | undefined>;
    getLabel(targetId: string, context: Context): Promise<string | undefined>;
    findEntries(query: EntryQuery | undefined, context: Context): Promise<Entry[]>;
    findEntry(query: EntryQuery | undefined, context: Context): Promise<Entry | undefined>;
    branch(name: string, context: Context): Promise<Branch | undefined>;
    createBranch(name: string, at: string | null, context: Context): Promise<Branch>;
    setValue<T>(address: Value<T>, next: NoInfer<T>, context: Context): Promise<void>;
    deleteValue<T>(address: Value<T>, context: Context): Promise<void>;
    appendList<T>(address: ValueList<T>, element: NoInfer<T>, context: Context): Promise<void>;
    deleteList<T>(address: ValueList<T>, context: Context): Promise<void>;
    setName(name: string | undefined, context: Context): Promise<void>;
    setLabel(targetId: string, label: string | undefined, context: Context): Promise<void>;
    close(context: Context): Promise<void>;
    private wrapBranch;
    private admit;
}
//# sourceMappingURL=session.d.ts.map