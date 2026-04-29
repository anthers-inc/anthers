/**
 * Standalone migration runner for deployment.
 *
 * Runs once per deployment as a PRE_DEPLOY job — not at every container startup.
 *
 * Usage: bun run packages/db/src/migrate.ts
 * Requires: DATABASE_URL environment variable (file: URL or bare path).
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

const raw = process.env.DATABASE_URL;
if (!raw) {
	console.error("DATABASE_URL is required");
	process.exit(1);
}
// bun:sqlite takes a bare path; strip the file: scheme if present.
const url = raw.replace(/^file:/, "");

const sqlite = new Database(url, { create: true });
sqlite.exec("PRAGMA foreign_keys = ON;");
sqlite.exec("PRAGMA busy_timeout = 5000;");
sqlite.exec("PRAGMA journal_mode = WAL;");

// Resolve migrations dir relative to this script so it works regardless of cwd.
const migrationsFolder = resolve(import.meta.dir, "../drizzle");

try {
	const db = drizzle(sqlite);
	console.log("Running migrations...");
	await migrate(db, { migrationsFolder });
	console.log("Migrations applied successfully.");
} catch (error) {
	console.error("Migration failed:", error);
	process.exit(1);
} finally {
	sqlite.close();
}
