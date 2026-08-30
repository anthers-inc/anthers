// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every migration in the journal must have a snapshot beside it.
 *
 * 🚨 The failure this catches is silent and compounding. drizzle-kit takes each new diff
 * against the LATEST snapshot, so a hand-written migration that skips one does not merely
 * omit a file — it makes drizzle's picture of the database permanently wrong, and every
 * subsequent generate diffs against that stale picture. It surfaces as a rename prompt that
 * reads like an ordinary question, and answering it produces a migration re-doing applied
 * work. `0041` and `0042` did this and it went unnoticed for weeks, through a release.
 *
 * Nothing else can see it: typecheck is happy, the tests pass, and the database is correct.
 * The only artifact that disagrees is a JSON file nobody reads.
 *
 * Fixing a violation: run `bun run db:generate` (which drives the prompts — see
 * `scripts/drizzle-generate.ts`), keep the snapshot it writes, and replace its SQL with
 * your hand-written statements, or with a comment if the changes are already applied.
 * `--custom` will NOT do: it copies the previous snapshot forward unchanged.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE_DIR = process.env.DRIZZLE_DIR ?? "packages/db/drizzle";
const journalPath = join(DRIZZLE_DIR, "meta", "_journal.json");

if (!existsSync(journalPath)) {
	console.error(`drizzle-snapshots: no journal at ${journalPath}`);
	process.exit(2);
}

const journal = (await Bun.file(journalPath).json()) as {
	entries: { idx: number; tag: string }[];
};

const snapshotFor = (idx: number) =>
	join(DRIZZLE_DIR, "meta", `${String(idx).padStart(4, "0")}_snapshot.json`);

const entries = journal.entries;
if (entries.length === 0) {
	console.log("drizzle-snapshots: no migrations yet ✓");
	process.exit(0);
}

// ⚠️ The invariant is about the LATEST entry, not every entry. drizzle-kit takes each new
// diff against the most recent snapshot only, so a gap in the middle of the history is
// untidy and harmless, while a gap at the end is the failure described above. Demanding
// one per entry would also be unfixable in retrospect: a historical snapshot has to
// describe an intermediate schema nobody can reconstruct, so the check would be
// permanently red with no honest way to clear it.
const latest = entries[entries.length - 1];
if (!existsSync(snapshotFor(latest.idx))) {
	console.error(
		"drizzle-snapshots: the newest migration has no snapshot, so drizzle's view of the\n" +
			"schema is stale and the next `db:generate` will diff against the wrong baseline.\n" +
			"See the header of scripts/drizzle-snapshots.ts for the fix.\n",
	);
	console.error(`  ✗ ${latest.tag} → ${String(latest.idx).padStart(4, "0")}_snapshot.json`);
	process.exit(1);
}

// Historical gaps are reported without failing, so the untidiness stays visible and the
// next person knows the history is not a complete record.
const gaps = entries.filter((e) => !existsSync(snapshotFor(e.idx)));
if (gaps.length > 0) {
	console.log(
		`drizzle-snapshots: ${entries.length} migrations, newest snapshotted ✓ ` +
			`(${gaps.length} historical gap(s): ${gaps.map((g) => g.tag).join(", ")})`,
	);
} else {
	console.log(`drizzle-snapshots: ${entries.length} migrations, all snapshotted ✓`);
}
