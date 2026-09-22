import { branchTip, prepareStorageCommit } from "@earendil-works/pi-agent-core";
import { appendEntryToBranchIndex, scanBranchEntries, scanBranchEntryStructures } from "./session/branch-entries.js";
import { decodeEntryRow, EntryRowWriter, readAllEntryRows, readEntryRows, scanEntryRows } from "./session/entries.js";
import { advanceNextSeq, readNextSeq } from "./session/session-sequences.js";
import { addUsageToSessionStats, incrementMessageCount, readSessionStats } from "./session/session-stats.js";
import { decodeUsageLedgerRow, scanUsageLedgerRows, UsageLedgerRowWriter } from "./session/usage-ledger.js";
import { appendListValueRow, deleteListValueRows, deleteScalarValueRow, readAllScalarValueRows, readListValueRows, readScalarValueRow, scanScalarValueRows, setScalarValueRow, } from "./session/values.js";
export class SqliteStorage {
    db;
    sessionId;
    now;
    entryWriter;
    usageWriter;
    commitQueue = Promise.resolve();
    state = "open";
    closePromise;
    constructor(db, options) {
        this.db = db;
        this.sessionId = options.sessionId;
        this.now = options.now ?? Date.now;
        this.entryWriter = new EntryRowWriter(db, this.sessionId);
        this.usageWriter = new UsageLedgerRowWriter(db, this.sessionId);
    }
    async commit(writes, _context) {
        if (this.state !== "open")
            throw new Error("SqliteStorage is closed");
        const result = this.commitQueue.then(() => this.applyCommit(writes));
        this.commitQueue = result.then(() => undefined, () => undefined);
        return result;
    }
    getEntries(ids, _context) {
        if (this.state !== "open")
            return Promise.reject(new Error("SqliteStorage is closed"));
        const rowsById = new Map(readEntryRows(this.db, this.sessionId, ids).map((row) => [row.id, row]));
        const entries = new Map();
        for (const id of ids) {
            const row = rowsById.get(id);
            if (row !== undefined)
                entries.set(id, decodeEntryRow(row));
        }
        return Promise.resolve(entries);
    }
    getValue(address, _context) {
        if (this.state !== "open")
            return Promise.reject(new Error("SqliteStorage is closed"));
        return Promise.resolve(readScalarValueRow(this.db, this.sessionId, address));
    }
    scanValues(prefix, _context) {
        if (this.state !== "open")
            return Promise.reject(new Error("SqliteStorage is closed"));
        return Promise.resolve(scanScalarValueRows(this.db, this.sessionId, prefix));
    }
    async readList(address, options, _context) {
        if (this.state !== "open")
            throw new Error("SqliteStorage is closed");
        return readListValueRows(this.db, this.sessionId, address, options);
    }
    scanBranch(query, _context) {
        if (this.state !== "open")
            return Promise.reject(new Error("SqliteStorage is closed"));
        return Promise.resolve().then(() => scanBranchEntries(this.db, this.sessionId, query));
    }
    scanBranchStructure(query, _context) {
        if (this.state !== "open")
            return Promise.reject(new Error("SqliteStorage is closed"));
        return Promise.resolve().then(() => scanBranchEntryStructures(this.db, this.sessionId, query));
    }
    scanEntries(query, _context) {
        if (this.state !== "open")
            return Promise.reject(new Error("SqliteStorage is closed"));
        return Promise.resolve(scanEntryRows(this.db, this.sessionId, query).map(decodeEntryRow));
    }
    scanUsage(query, _context) {
        if (this.state !== "open")
            return Promise.reject(new Error("SqliteStorage is closed"));
        return Promise.resolve(scanUsageLedgerRows(this.db, this.sessionId, query).map(decodeUsageLedgerRow));
    }
    getStats(_context) {
        if (this.state !== "open")
            return Promise.reject(new Error("SqliteStorage is closed"));
        return Promise.resolve(readSessionStats(this.db, this.sessionId));
    }
    snapshot(options, _context) {
        if (this.state !== "open")
            return Promise.reject(new Error("SqliteStorage is closed"));
        const result = this.commitQueue.then(() => this.readSnapshot(options));
        this.commitQueue = result.then(() => undefined, () => undefined);
        return result;
    }
    readSnapshot(options) {
        const scalarValues = readAllScalarValueRows(this.db, this.sessionId);
        return {
            entries: this.readSnapshotEntries(options, scalarValues),
            scalarValues,
            entriesComplete: options.scope === "tree",
        };
    }
    readSnapshotEntries(options, scalarValues) {
        if (options.scope === "tree")
            return readAllEntryRows(this.db, this.sessionId).map(decodeEntryRow);
        const sourceAddress = branchTip(options.branch);
        const sourceTip = scalarValues.find((stored) => stored.address.namespace === sourceAddress.namespace && stored.address.key === sourceAddress.key);
        if (sourceTip === undefined)
            throw new Error(`Unknown source branch: ${options.branch}`);
        return sourceTip.value === null
            ? []
            : scanBranchEntries(this.db, this.sessionId, { start: sourceTip.value, order: "oldestFirst" });
    }
    applyCommit(writes) {
        return this.db.transaction(() => {
            const firstSeq = readNextSeq(this.db, this.sessionId);
            const prepared = prepareStorageCommit(writes, firstSeq, this.now());
            for (const write of prepared.writes) {
                switch (write.kind) {
                    case "entry": {
                        const { kind: _kind, ...entry } = write;
                        this.entryWriter.insert(entry);
                        appendEntryToBranchIndex(this.db, this.sessionId, entry);
                        if (entry.type === "message")
                            incrementMessageCount(this.db, this.sessionId);
                        break;
                    }
                    case "usage": {
                        const { kind: _kind, ...row } = write;
                        this.usageWriter.insert(row);
                        addUsageToSessionStats(this.db, this.sessionId, row.usage);
                        break;
                    }
                    case "value":
                        if (write.op === "delete") {
                            deleteScalarValueRow(this.db, this.sessionId, write.namespace, write.key);
                        }
                        else {
                            setScalarValueRow(this.db, this.sessionId, write.namespace, write.key, write.seq, write.value);
                        }
                        break;
                    case "list":
                        if (write.op === "delete") {
                            deleteListValueRows(this.db, this.sessionId, write.namespace, write.key);
                        }
                        else {
                            appendListValueRow(this.db, this.sessionId, write.namespace, write.key, write.seq, write.value);
                        }
                        break;
                }
            }
            advanceNextSeq(this.db, this.sessionId, firstSeq + prepared.writes.length);
            return { ...prepared.result, stats: readSessionStats(this.db, this.sessionId) };
        });
    }
    close(_context) {
        if (this.closePromise !== undefined)
            return this.closePromise;
        this.state = "closing";
        this.closePromise = this.commitQueue.then(() => {
            this.state = "closed";
        });
        return this.closePromise;
    }
}
//# sourceMappingURL=storage.js.map