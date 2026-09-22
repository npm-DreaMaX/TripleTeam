import type { Context, ForkOptions, SessionCreateOptions } from "@earendil-works/pi-agent-core";
import { type SqliteSessionMetadata } from "./session/session-row.ts";
import { SqliteOpenSession } from "./session.ts";
import type { SqliteDatabaseFactory } from "./types.ts";
export declare const SQLITE_STORAGE_VERSION = 1;
export declare const SQLITE_SESSION_EXTENSION = ".sqlite";
export type SqliteSessionCreateOptions = SessionCreateOptions;
export interface SqliteSessionRepoOptions {
    directory: string;
    /** Optional single container path. Defaults to one encoded `${id}.sqlite` file per session under directory. */
    databasePath?: string;
    databaseFactory: SqliteDatabaseFactory;
    now?: () => number;
}
export declare class SqliteSessionRepo {
    private readonly directory;
    private readonly databasePath;
    private readonly databaseFactory;
    private readonly now;
    private readonly pendingIds;
    private readonly openStorages;
    private readonly openSessions;
    private closed;
    private closePromise;
    constructor(options: SqliteSessionRepoOptions);
    create(options: SqliteSessionCreateOptions | undefined, _context: Context): Promise<SqliteOpenSession>;
    open(metadata: SqliteSessionMetadata, _context: Context): Promise<SqliteOpenSession>;
    list(_options: undefined, _context: Context): Promise<SqliteSessionMetadata[]>;
    delete(metadata: SqliteSessionMetadata, _context: Context): Promise<void>;
    fork(source: SqliteSessionMetadata, options: ForkOptions, context: Context): Promise<SqliteOpenSession>;
    close(context: Context): Promise<void>;
    private createForkSnapshotFromExternalSource;
    private closeOpenSessions;
    private openStorageBackedSession;
    private repositoryPathForMetadata;
    private reserveId;
    private pathForSession;
    private usesSharedDatabase;
    private assertOpen;
}
//# sourceMappingURL=repo.d.ts.map