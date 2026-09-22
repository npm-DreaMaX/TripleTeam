import type { UsageRow, UsageScan } from "@earendil-works/pi-agent-core";
import type { SqliteDatabase } from "../types.ts";
export interface UsageLedgerRow {
    id: string;
    seq: number;
    entry_id: string | null;
    adjustment: number;
    usage: string;
    details: string | null;
}
export declare class UsageLedgerRowWriter {
    private readonly insertStatement;
    private readonly sessionId;
    constructor(db: SqliteDatabase, sessionId: string);
    insert(row: UsageRow): void;
}
export declare function insertUsageLedgerRow(db: SqliteDatabase, sessionId: string, row: UsageRow): void;
export declare function decodeUsageLedgerRow(row: UsageLedgerRow): UsageRow;
export declare function scanUsageLedgerRows(db: SqliteDatabase, sessionId: string, query: UsageScan): UsageLedgerRow[];
//# sourceMappingURL=usage-ledger.d.ts.map