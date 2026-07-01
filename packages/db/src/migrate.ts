// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Standalone migration runner for deployment.
 *
 * Runs once per deployment as a PRE_DEPLOY job — not at every container startup.
 *
 * Usage: bun run packages/db/src/migrate.ts
 * Requires: DATABASE_URL environment variable (Postgres connection string).
 */

import { SQL } from "bun";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";

const url = process.env.DATABASE_URL;
if (!url) {
	console.error("DATABASE_URL is required");
	process.exit(1);
}

const client = new SQL(url);

// Resolve migrations dir relative to this script so it works regardless of cwd.
const migrationsFolder = resolve(import.meta.dir, "../drizzle");

try {
	const db = drizzle({ client });
	console.log("Running migrations...");
	await migrate(db, { migrationsFolder });
	console.log("Migrations applied successfully.");
} catch (error) {
	console.error("Migration failed:", error);
	process.exit(1);
} finally {
	await client.end();
}
