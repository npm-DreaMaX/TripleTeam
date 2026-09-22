import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export async function applyInitialSchema(db) {
    const migration = await readFile(fileURLToPath(new URL("./migrations/001_initial.sql", import.meta.url)), "utf8");
    db.exec(migration);
}
//# sourceMappingURL=migrations.js.map