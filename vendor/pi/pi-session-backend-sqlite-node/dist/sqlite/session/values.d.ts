import { type ListElement, type ListReadOptions, type StoredValue, type Value, type ValueList } from "@earendil-works/pi-agent-core";
import { type SqlQuery } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";
export interface ScalarValueRow {
    namespace: string;
    key: string;
    seq: number;
    value: string;
}
export interface ListValueRow {
    seq: number;
    value: string;
}
export declare function setScalarValueRow(db: SqliteDatabase, sessionId: string, namespace: string, key: string, seq: number, storedValue: unknown): void;
export declare function deleteScalarValueRow(db: SqliteDatabase, sessionId: string, namespace: string, key: string): void;
export declare function appendListValueRow(db: SqliteDatabase, sessionId: string, namespace: string, key: string, seq: number, element: unknown): void;
export declare function deleteListValueRows(db: SqliteDatabase, sessionId: string, namespace: string, key: string): void;
export declare function readScalarValueRow<T>(db: SqliteDatabase, sessionId: string, address: Value<T>): StoredValue<T> | undefined;
export declare function readAllScalarValueRows(db: SqliteDatabase, sessionId: string): StoredValue<unknown>[];
export declare function scanScalarValueRows<T>(db: SqliteDatabase, sessionId: string, prefix: Value<T>): StoredValue<T>[];
export declare function listValueReadQuery<T>(sessionId: string, address: ValueList<T>, options?: ListReadOptions): SqlQuery;
export declare function readListValueRows<T>(db: SqliteDatabase, sessionId: string, address: ValueList<T>, options?: ListReadOptions): ListElement<T>[];
//# sourceMappingURL=values.d.ts.map