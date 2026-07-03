// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Standalone migration runner for deployment.
 *
 * Runs once per deployment as a PRE_DEPLOY job — not at every container startup.
 *
 * Usage: bun run packages/db/src/migrate.ts
 * Requires: DATABASE_URL environment variable (Postgres connection string).
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
	console.error("DATABASE_URL is required");
	process.exit(1);
}

// max: 1 — migrations run serially on a single connection.
// onnotice off — silence "already exists, skipping" NOTICEs in deploy logs.
const client = postgres(url, { max: 1, onnotice: () => {} });

// Resolve migrations dir relative to this script so it works regardless of cwd.
const migrationsFolder = resolve(import.meta.dir, "../drizzle");

async function readJournalEntries(): Promise<{ when: number; tag: string }[]> {
	const raw = await readFile(resolve(migrationsFolder, "meta/_journal.json"), "utf8");
	return (JSON.parse(raw).entries ?? []) as { when: number; tag: string }[];
}

/** Postgres error code (drizzle wraps the driver error; check both shapes). */
function pgCode(err: unknown): string | undefined {
	const e = err as { code?: string; cause?: { code?: string } };
	return e?.code ?? e?.cause?.code;
}

/**
 * Mark migrations as applied without re-running their DDL. Used only when the
 * schema is already provisioned but this job read an empty journal (e.g. a clean
 * rebuild whose baseline was applied out of band). Idempotent.
 */
async function reconcileJournal(entries: { when: number; tag: string }[]) {
	await client`CREATE SCHEMA IF NOT EXISTS drizzle`;
	await client`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`;
	for (const entry of entries) {
		const existing = await client`SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = ${entry.when} LIMIT 1`;
		if (existing.length === 0) {
			await client`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${entry.tag}, ${entry.when})`;
		}
	}
}

try {
	const db = drizzle(client);

	// Diagnostics: which DB/user this job targets, and what it believes is applied.
	const [info] = await client`SELECT current_database() AS db, current_user AS usr`;
	const recorded = await client`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`.catch(
		() => [{ n: -1 }],
	);
	console.log(
		`migrate target: db=${info?.db} user=${info?.usr} recorded_migrations=${recorded[0]?.n} (-1 = journal table absent)`,
	);

	console.log("Running migrations...");
	try {
		await migrate(db, { migrationsFolder });
		console.log("Migrations applied successfully.");
	} catch (error) {
		const code = pgCode(error);
		const entries = await readJournalEntries();
		// 42P07 duplicate_table / 42710 duplicate_object: the schema is already
		// provisioned but this job saw an empty journal, so drizzle tried to re-create
		// it. Reconcile the journal instead of failing the deploy — but ONLY for a
		// baseline-only (single-entry) journal, so a genuine conflict in a later
		// migration still fails loudly.
		if ((code === "42P07" || code === "42710") && entries.length === 1) {
			console.warn(
				`Schema already present (pg ${code}) with a baseline-only journal; reconciling journal instead of re-creating.`,
			);
			await reconcileJournal(entries);
			console.log("Migration journal reconciled; schema already up to date.");
		} else {
			throw error;
		}
	}
} catch (error) {
	console.error("Migration failed:", error);
	process.exit(1);
} finally {
	await client.end();
}
