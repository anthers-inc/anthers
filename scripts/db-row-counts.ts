// SPDX-License-Identifier: Apache-2.0
/**
 * Every table's row count in the session this runs in, as JSON, biggest first.
 *
 * Written for the residue measurement that `Chase the two residue families the content
 * sweep is blind to` asks for: a test session is discarded at the end, so the only moment
 * a leak can be counted is between the last suite's `afterAll` and the session's removal.
 * Run it inside a session around a full `bun test` (`scripts/session.ts test -- …`) and
 * diff the two snapshots.
 *
 * ⚠️ **`count(*)`, never `pg_stat_user_tables.n_live_tup`.** The estimate is what the first
 * pass of this investigation used, and it reported 121 leaked moderation reports where an
 * exact count showed zero — autovacuum's own lag, read as a leak.
 *
 * Tables with no rows are omitted, which is what makes the diff readable: a leak is a table
 * appearing or growing, and a table vanishing from the snapshot is a suite that started
 * cleaning up after itself.
 *
 * Usage: `bun run scripts/db-row-counts.ts` (inside a session, so `DATABASE_URL` is set).
 */
import { db } from "@anthers/db/client";
import { sql } from "drizzle-orm";

/**
 * The rows of a raw query, whichever driver shape this repository is on today.
 *
 * `postgres-js` hands back the row list itself; `node-postgres` hands back `{ rows }`. Both
 * have been true here, so the helper is cheaper than remembering which.
 */
function rowsOf(result: unknown): Record<string, unknown>[] {
	if (Array.isArray(result)) return result as Record<string, unknown>[];
	return (result as { rows?: Record<string, unknown>[] }).rows ?? [];
}

if (!process.env.DATABASE_URL) {
	console.error("db-row-counts: DATABASE_URL is unset — run this inside a session");
	process.exit(1);
}

const tables = rowsOf(
	await db.execute(sql`
		select table_name
		from information_schema.tables
		where table_schema = 'public' and table_type = 'BASE TABLE'
		order by table_name
	`),
).map((row) => String(row.table_name));

const counts: Record<string, number> = {};
for (const table of tables) {
	const [row] = rowsOf(
		await db.execute(sql`select count(*)::int as count from ${sql.identifier(table)}`),
	);
	const count = Number(row?.count ?? 0);
	if (count > 0) counts[table] = count;
}

const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
console.log(JSON.stringify(Object.fromEntries(sorted), null, "\t"));
// The client keeps the event loop alive, and a session wrapper waits for the command to
// exit — so this has to be explicit or the run hangs until its outer timeout.
process.exit(0);
