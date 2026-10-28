// SPDX-License-Identifier: Apache-2.0
/**
 * Which migration the schema is at, from the two sides that can answer it: the journal this
 * build ships, and the row the deploy's migrate job wrote into the database.
 *
 * 🚨 **A deploy's old build serves against the new schema for as long as the rollout takes.**
 * App Platform runs `packages/db/src/migrate.ts` as a `PRE_DEPLOY` job and keeps the current
 * deployment serving until the new components are healthy, so a rename or a column drop lands
 * under code that still asks for the old names. On 2026-10-28 that window caught three cron
 * sweeps (`access-receipts`, `escalate-reports`, `release-scheduled`), which failed on columns
 * the migration had already moved. A worker that can tell it is the outgoing build can stand
 * down instead of running jobs it cannot run.
 *
 * **The comparison is between journal heads, not versions.** Drizzle writes each migration's
 * journal `when` into `drizzle.__drizzle_migrations.created_at`, so the database's newest row
 * and this build's newest journal entry are the same kind of number. A database head above the
 * build's means the database has a migration this build does not ship, and nothing in that
 * build's handlers can be trusted against it.
 *
 * ⚠️ **Both reads fail open.** A missing journal file, an unreachable database or a database
 * that has never been migrated all answer `unknown`, and `unknown` must serve: a guard that
 * stopped a worker because it could not read a file would take the queues down on the day the
 * file moves. Only a database that is demonstrably ahead stands a build down.
 */
import { readFileSync } from "node:fs";

/** The journal the `migrate` job reads, resolved from this module so cwd never matters. */
const JOURNAL = new URL("../drizzle/meta/_journal.json", import.meta.url);

/**
 * What this build ships, as the newest `when` in its journal. `null` when the journal cannot be
 * read or carries no entries, which is a broken checkout rather than a schema state.
 */
export function readBuildSchemaHead(): number | null {
	try {
		const journal = JSON.parse(readFileSync(JOURNAL, "utf8")) as {
			entries?: Array<{ when?: unknown }>;
		};
		const head = journal.entries?.at(-1)?.when;
		return typeof head === "number" && Number.isFinite(head) ? head : null;
	} catch {
		return null;
	}
}

/**
 * What the database has applied, as the newest `created_at` in Drizzle's own table. `null` when
 * the table is absent (a database that has never been migrated) or the read fails for any
 * other reason — both are states in which this build is not demonstrably out of date.
 *
 * ⚠️ **The client is imported here rather than at the top**, so a process that only wants the
 * build's head (a test, a script) never opens a pool to answer a question about a file.
 */
export async function readDatabaseSchemaHead(): Promise<number | null> {
	try {
		const { client } = await import("./client.js");
		const rows = await client<{ head: string | null }[]>`
			SELECT max(created_at)::text AS head FROM drizzle.__drizzle_migrations
		`;
		const head = rows[0]?.head;
		return head === null || head === undefined ? null : Number(head);
	} catch {
		return null;
	}
}

/** `build-behind` is the one state in which a process must not run its own handlers. */
export type SchemaStanding = "current" | "build-behind" | "unknown";

/** The comparison, pure so the decision can be tested without a database. */
export function schemaStanding(
	buildHead: number | null,
	databaseHead: number | null,
): SchemaStanding {
	if (buildHead === null || databaseHead === null) return "unknown";
	return databaseHead > buildHead ? "build-behind" : "current";
}

/** Read both heads and decide. Never throws; a failed read is `unknown`. */
export async function readSchemaStanding(): Promise<SchemaStanding> {
	return schemaStanding(readBuildSchemaHead(), await readDatabaseSchemaHead());
}
