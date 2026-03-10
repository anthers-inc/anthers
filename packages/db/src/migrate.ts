/**
 * Standalone migration runner for deployment.
 *
 * Uses the `pg` driver (not Bun.sql) because drizzle-kit generates migrations
 * compatible with the node-postgres migrator. This script runs once per
 * deployment as a PRE_DEPLOY job — not at every container startup.
 *
 * Usage: bun run packages/db/src/migrate.ts
 * Requires: DATABASE_URL environment variable
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
	console.error("DATABASE_URL is required");
	process.exit(1);
}

const pool = new pg.Pool({ connectionString });

try {
	const db = drizzle(pool);
	console.log("Running migrations...");
	await migrate(db, { migrationsFolder: "./packages/db/drizzle" });
	console.log("Migrations applied successfully.");
} catch (error) {
	console.error("Migration failed:", error);
	process.exit(1);
} finally {
	await pool.end();
}
