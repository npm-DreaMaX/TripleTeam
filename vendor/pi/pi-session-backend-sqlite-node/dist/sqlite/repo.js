import { mkdir, open as openFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { branchTip, createForkSnapshot, StorageBackedSession } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import { applyInitialSchema } from "./migrations.js";
import { appendEntryToBranchIndex, scanBranchEntries } from "./session/branch-entries.js";
import { decodeEntryRow, EntryRowWriter } from "./session/entries.js";
import { deleteSessionRows, hasSessionRow, insertSessionRow, metadataFromSessionRow, readAllSessionRows, readSessionRow, } from "./session/session-row.js";
import { readAllScalarValueRows, setScalarValueRow } from "./session/values.js";
import { SqliteOpenSession } from "./session.js";
import { sql } from "./sql.js";
import { SqliteStorage } from "./storage.js";
export const SQLITE_STORAGE_VERSION = 1;
export const SQLITE_SESSION_EXTENSION = ".sqlite";
const FIRST_AVAILABLE_COMMIT_SEQ = 1;
const SAFE_SESSION_FILE_ID = /^[A-Za-z0-9_-]+$/;
function sessionFileName(id) {
    if (SAFE_SESSION_FILE_ID.test(id))
        return `${id}${SQLITE_SESSION_EXTENSION}`;
    const encoded = Buffer.from(id, "utf16le").toString("base64url");
    return `~${encoded}${SQLITE_SESSION_EXTENSION}`;
}
function sessionPath(directory, id) {
    return join(directory, sessionFileName(id));
}
function storageIdentity(path, sessionId) {
    return JSON.stringify([path, sessionId]);
}
function isErrorWithCode(error, code) {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
async function removeSessionFiles(path, options) {
    await rm(path, { force: options.force });
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
}
function configureWritableConnection(db) {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
}
function configureReadOnlyConnection(db) {
    db.exec("PRAGMA busy_timeout = 5000;");
}
function readSourceEntries(db, sessionId) {
    return sql `SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries WHERE session_id = ${sessionId} ORDER BY seq ASC`
        .all(db)
        .map(decodeEntryRow);
}
function buildForkSnapshot(source, options) {
    const snapshot = createForkSnapshot({
        entries: source.entries,
        scalarValues: source.scalarValues,
        entriesComplete: source.entriesComplete,
    }, options);
    const entries = [...snapshot.entries.values()].sort((left, right) => left.seq - right.seq);
    return {
        entries,
        scalarValues: snapshot.scalarValues,
        messageCount: entries.filter((entry) => entry.type === "message").length,
        nextSeq: snapshot.nextSeq,
    };
}
// TODO(WP08): Remove this snapshot path when SQLite forks use streaming staging.
function readForkSourceEntries(db, sessionId, scalarValues, options) {
    if (options.scope === "tree")
        return readSourceEntries(db, sessionId);
    const sourceAddress = branchTip(options.branch);
    const sourceTip = scalarValues.find((stored) => stored.address.namespace === sourceAddress.namespace && stored.address.key === sourceAddress.key);
    if (sourceTip === undefined)
        throw new Error(`Unknown source branch: ${options.branch}`);
    return sourceTip.value === null
        ? []
        : scanBranchEntries(db, sessionId, { start: sourceTip.value, order: "oldestFirst" });
}
function createSqliteForkSnapshot(sourceDb, source, options) {
    sourceDb.exec("BEGIN");
    let committed = false;
    try {
        metadataFromSessionRow(source.path, readSessionRow(sourceDb, source.id), SQLITE_STORAGE_VERSION);
        const scalarValues = readAllScalarValueRows(sourceDb, source.id);
        const snapshot = buildForkSnapshot({
            entries: readForkSourceEntries(sourceDb, source.id, scalarValues, options),
            scalarValues,
            entriesComplete: options.scope === "tree",
        }, options);
        sourceDb.exec("COMMIT");
        committed = true;
        return snapshot;
    }
    catch (error) {
        if (!committed)
            sourceDb.exec("ROLLBACK");
        throw error;
    }
}
function insertForkValue(db, sessionId, stored) {
    setScalarValueRow(db, sessionId, stored.address.namespace, stored.address.key, stored.seq, stored.value);
}
function updateForkSessionStats(db, sessionId, messageCount) {
    sql `UPDATE sessions SET message_count = ${messageCount} WHERE id = ${sessionId}`.run(db);
}
export class SqliteSessionRepo {
    directory;
    databasePath;
    databaseFactory;
    now;
    pendingIds = new Set();
    openStorages = new Map();
    openSessions = new Set();
    closed = false;
    closePromise;
    constructor(options) {
        this.directory = options.directory;
        this.databasePath = options.databasePath;
        this.databaseFactory = options.databaseFactory;
        this.now = options.now ?? Date.now;
    }
    async create(options, _context) {
        this.assertOpen();
        options ??= {};
        const createdAt = this.now();
        const id = options.id ?? uuidv7(createdAt);
        this.reserveId(id);
        const path = this.pathForSession(id);
        let db;
        let reservedFile = false;
        let initialized = false;
        let session;
        try {
            await mkdir(dirname(path), { recursive: true });
            if (!this.usesSharedDatabase()) {
                const file = await openFile(path, "wx");
                await file.close();
                reservedFile = true;
            }
            const activeDb = await this.databaseFactory.open(path);
            db = activeDb;
            configureWritableConnection(activeDb);
            await applyInitialSchema(activeDb);
            const canonicalPath = await realpath(path);
            const metadata = {
                id,
                createdAt,
                storageVersion: SQLITE_STORAGE_VERSION,
                ...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
                path: canonicalPath,
            };
            activeDb.transaction(() => {
                if (hasSessionRow(activeDb, id))
                    throw new Error(`SQLite session already exists: ${id}`);
                insertSessionRow(activeDb, metadata, SQLITE_STORAGE_VERSION, FIRST_AVAILABLE_COMMIT_SEQ);
            });
            initialized = true;
            session = this.openStorageBackedSession(metadata, activeDb);
            return session;
        }
        catch (error) {
            if (reservedFile && !initialized)
                await removeSessionFiles(path, { force: true });
            throw error;
        }
        finally {
            if (session === undefined) {
                try {
                    db?.close();
                }
                finally {
                    this.pendingIds.delete(id);
                }
            }
        }
    }
    async open(metadata, _context) {
        this.assertOpen();
        this.reserveId(metadata.id);
        let db;
        let session;
        try {
            const path = await this.repositoryPathForMetadata(metadata);
            const activeDb = await this.databaseFactory.openExisting(path);
            db = activeDb;
            configureWritableConnection(activeDb);
            const stored = metadataFromSessionRow(path, readSessionRow(activeDb, metadata.id), SQLITE_STORAGE_VERSION);
            session = this.openStorageBackedSession(stored, activeDb);
            return session;
        }
        finally {
            if (session === undefined) {
                try {
                    db?.close();
                }
                finally {
                    this.pendingIds.delete(metadata.id);
                }
            }
        }
    }
    async list(_options, _context) {
        this.assertOpen();
        let paths;
        if (this.usesSharedDatabase()) {
            paths = [this.databasePath];
        }
        else {
            let names;
            try {
                names = await readdir(this.directory);
            }
            catch (error) {
                if (isErrorWithCode(error, "ENOENT"))
                    return [];
                throw error;
            }
            paths = names
                .filter((name) => name.endsWith(SQLITE_SESSION_EXTENSION))
                .map((name) => join(this.directory, name));
        }
        const sessions = [];
        for (const path of paths) {
            let db;
            try {
                const canonicalPath = await realpath(path);
                db = await this.databaseFactory.openReadOnly(canonicalPath);
                configureReadOnlyConnection(db);
                for (const row of readAllSessionRows(db)) {
                    sessions.push(metadataFromSessionRow(canonicalPath, row, SQLITE_STORAGE_VERSION));
                }
            }
            catch {
                // Discovery is best-effort: corrupt files, incompatible versions, and
                // unrelated *.sqlite files are reported when explicitly opened.
            }
            finally {
                db?.close();
            }
        }
        return sessions.sort((left, right) => right.createdAt - left.createdAt);
    }
    async delete(metadata, _context) {
        this.assertOpen();
        this.reserveId(metadata.id);
        try {
            const path = await this.repositoryPathForMetadata(metadata);
            const db = await this.databaseFactory.openExisting(path);
            try {
                configureWritableConnection(db);
                if (this.usesSharedDatabase()) {
                    db.transaction(() => {
                        metadataFromSessionRow(path, readSessionRow(db, metadata.id), SQLITE_STORAGE_VERSION);
                        deleteSessionRows(db, metadata.id);
                    });
                }
                else {
                    metadataFromSessionRow(path, readSessionRow(db, metadata.id), SQLITE_STORAGE_VERSION);
                }
            }
            finally {
                db.close();
            }
            if (!this.usesSharedDatabase())
                await removeSessionFiles(path, { force: false });
        }
        finally {
            this.pendingIds.delete(metadata.id);
        }
    }
    async fork(source, options, context) {
        this.assertOpen();
        const createdAt = this.now();
        const id = options.id ?? uuidv7(createdAt);
        this.reserveId(id);
        const sourceStorage = this.openStorages.get(storageIdentity(source.path, source.id));
        const activeSourceSnapshot = sourceStorage?.snapshot(options, context);
        void activeSourceSnapshot?.catch(() => undefined);
        const path = this.pathForSession(id);
        let db;
        let reservedFile = false;
        let initialized = false;
        let session;
        try {
            await mkdir(dirname(path), { recursive: true });
            if (!this.usesSharedDatabase()) {
                const file = await openFile(path, "wx");
                await file.close();
                reservedFile = true;
            }
            const snapshot = activeSourceSnapshot === undefined
                ? await this.createForkSnapshotFromExternalSource(source, options)
                : buildForkSnapshot(await activeSourceSnapshot, options);
            const activeDb = await this.databaseFactory.open(path);
            db = activeDb;
            configureWritableConnection(activeDb);
            await applyInitialSchema(activeDb);
            const canonicalPath = await realpath(path);
            const metadata = {
                id,
                createdAt,
                storageVersion: SQLITE_STORAGE_VERSION,
                parentSessionId: source.id,
                path: canonicalPath,
            };
            activeDb.transaction(() => {
                if (hasSessionRow(activeDb, id))
                    throw new Error(`SQLite session already exists: ${id}`);
                insertSessionRow(activeDb, metadata, SQLITE_STORAGE_VERSION, snapshot.nextSeq);
                const entryWriter = new EntryRowWriter(activeDb, id);
                for (const entry of snapshot.entries) {
                    entryWriter.insert(entry);
                    appendEntryToBranchIndex(activeDb, id, entry);
                }
                for (const stored of snapshot.scalarValues)
                    insertForkValue(activeDb, id, stored);
                updateForkSessionStats(activeDb, id, snapshot.messageCount);
            });
            initialized = true;
            session = this.openStorageBackedSession(metadata, activeDb);
            return session;
        }
        catch (error) {
            if (reservedFile && !initialized)
                await removeSessionFiles(path, { force: true });
            throw error;
        }
        finally {
            if (session === undefined) {
                try {
                    db?.close();
                }
                finally {
                    this.pendingIds.delete(id);
                }
            }
        }
    }
    close(context) {
        if (this.closePromise !== undefined)
            return this.closePromise;
        this.closed = true;
        this.closePromise = this.closeOpenSessions(context);
        return this.closePromise;
    }
    async createForkSnapshotFromExternalSource(source, options) {
        const path = await realpath(source.path);
        const sourceDb = await this.databaseFactory.openReadOnly(path);
        try {
            configureReadOnlyConnection(sourceDb);
            return createSqliteForkSnapshot(sourceDb, { ...source, path }, options);
        }
        finally {
            sourceDb.close();
        }
    }
    async closeOpenSessions(context) {
        const results = await Promise.allSettled([...this.openSessions].map((session) => session.close(context)));
        const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
        if (errors.length === 1)
            throw errors[0];
        if (errors.length > 1)
            throw new AggregateError(errors, "Failed to close SQLite Sessions");
    }
    openStorageBackedSession(metadata, db) {
        const key = storageIdentity(metadata.path, metadata.id);
        const storage = new SqliteStorage(db, { sessionId: metadata.id, now: this.now });
        this.openStorages.set(key, storage);
        const session = new StorageBackedSession(metadata, storage);
        const openSession = new SqliteOpenSession(session, {
            onClose: () => {
                try {
                    db.close();
                }
                finally {
                    if (this.openStorages.get(key) === storage)
                        this.openStorages.delete(key);
                    this.openSessions.delete(openSession);
                    this.pendingIds.delete(metadata.id);
                }
            },
        });
        this.openSessions.add(openSession);
        return openSession;
    }
    async repositoryPathForMetadata(metadata) {
        const [expected, actual] = await Promise.all([
            realpath(this.pathForSession(metadata.id)),
            realpath(metadata.path),
        ]);
        if (expected !== actual) {
            throw new Error(`SQLite session metadata path is outside this repository: ${metadata.path}`);
        }
        return actual;
    }
    reserveId(id) {
        if (this.pendingIds.has(id))
            throw new Error(`Session is already open: ${id}`);
        this.pendingIds.add(id);
    }
    pathForSession(id) {
        return this.databasePath ?? sessionPath(this.directory, id);
    }
    usesSharedDatabase() {
        return this.databasePath !== undefined;
    }
    assertOpen() {
        if (this.closed)
            throw new Error("SqliteSessionRepo is closed");
    }
}
//# sourceMappingURL=repo.js.map