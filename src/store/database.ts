import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createNodeSqliteFactory, type SqliteDatabase } from "@earendil-works/pi-session-backend-sqlite-node";
import { MIGRATIONS } from "./schema.ts";

export interface ControlDatabase {
	readonly sql: SqliteDatabase;
	readonly path: string;
	close(): void;
}

function currentSchemaVersion(db: SqliteDatabase): number {
	const row = db.prepare("PRAGMA user_version").get<{ user_version: number }>();
	return row?.user_version ?? 0;
}

function migrate(db: SqliteDatabase): void {
	const current = currentSchemaVersion(db);
	for (const migration of MIGRATIONS) {
		if (migration.version <= current) continue;
		const alreadyApplied = migration.alreadyAppliedSql
			? db.prepare(migration.alreadyAppliedSql).get<{ applied: number }>()?.applied === 1
			: false;
		if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
		try {
			db.transaction(() => {
				if (!alreadyApplied) db.exec(migration.sql);
				db.exec("PRAGMA user_version = " + migration.version);
			});
		} finally {
			if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
		}
		const violations = db.prepare("PRAGMA foreign_key_check").all<Record<string, unknown>>();
		if (violations.length > 0) {
			throw new Error(`Migration ${migration.version} (${migration.name}) left foreign-key violations`);
		}
	}
}

export async function openControlDatabase(path: string): Promise<ControlDatabase> {
	if (path !== ":memory:") {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await chmod(dirname(path), 0o700);
	}
	const sql = await createNodeSqliteFactory().open(path);
	sql.exec("PRAGMA foreign_keys = ON");
	sql.exec("PRAGMA journal_mode = WAL");
	sql.exec("PRAGMA synchronous = NORMAL");
	sql.exec("PRAGMA busy_timeout = 5000");
	migrate(sql);
	if (path !== ":memory:") {
		for (const candidate of [path, path + "-wal", path + "-shm"]) {
			try {
				await chmod(candidate, 0o600);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}
	return {
		sql,
		path,
		close: () => sql.close(),
	};
}
