// SPDX-License-Identifier: Apache-2.0
/**
 * The generator's retag step — its own module because `drizzle-generate.ts` is a
 * top-level pty wrapper whose import would spawn drizzle-kit (tests import this one),
 * and because its own test is the standing proof of the naming decision the two
 * modules share.
 *
 * 🚨 The naming decision in full: a generated migration carries a **timestamp prefix**
 * (`20261015-214200_lucky_sersi` — the UTC `when` its journal entry records, then
 * drizzle-kit's codename) instead of the sequence number, so two parallel schema
 * branches can never generate the same name and the merge queue never sees the
 * double-bounce collision its first weeks taught (`0139`, twice). Lexicographic order
 * equals chronological order, and every timestamped name sorts after every
 * sequence-numbered name (`0…` < `2…`), so the old and new number spaces interleave
 * correctly with no history rewrite — the transition needed none and took none.
 *
 * The retag renames the file and the journal entry and nothing else: the snapshots are
 * idx-named (`meta/NNNN_snapshot.json`) and the migrator is journal-ordered, so a tag
 * rename is invisible to both. The freshness gate (`startedAt`) stops a no-changes
 * generate from retagging the last COMMITTED migration — the retag exists for the
 * entry this run created, never for history.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The timestamped name for one generated migration: its own written-at time, UTC, then
 * drizzle's codename.
 */
export function timestampedTag(tag: string, when: number): string {
	// A tag may arrive in either shape — the sequence scheme's or an already-timestamped
	// one (the journal-order guard recomputes expected tags from every entry) — so strip
	// whichever prefix is present and keep the codename.
	const codename = tag.replace(/^\d{8}-\d{6}_/, "").replace(/^\d+_/, "");
	const stamp = new Date(when);
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${stamp.getUTCFullYear()}${pad(stamp.getUTCMonth() + 1)}${pad(stamp.getUTCDate())}` +
		`-${pad(stamp.getUTCHours())}${pad(stamp.getUTCMinutes())}${pad(stamp.getUTCSeconds())}_${codename}`
	);
}

/**
 * Rename the journal's newest entry's migration to its timestamped tag — the file, the
 * journal entry, and nothing else (the snapshots are idx-named and stay). Idempotent by
 * shape: a tag already carrying the timestamp shape is left alone, which is also what
 * makes a second generate against a retagged journal a plain no-op. Never throws for an
 * unexpected ledger: a journal whose newest file cannot be found is reported, not
 * half-renamed — the caller's output names the state either way.
 */
export function retagNewestMigration(
	drizzleDir: string,
	startedAt = Number.NEGATIVE_INFINITY,
): { retagged: boolean; tag?: string; oldTag?: string; error?: string } {
	const journalPath = join(drizzleDir, "meta", "_journal.json");
	const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
		entries: { idx: number; when: number; tag: string }[];
	};
	const entries = journal.entries;
	if (entries.length === 0) return { retagged: false };
	const last = entries[entries.length - 1];
	if (last.when <= startedAt) return { retagged: false, tag: last.tag };
	if (!/^\d+_/.test(last.tag)) return { retagged: false, tag: last.tag };
	const newTag = timestampedTag(last.tag, last.when);
	const renameFrom = last.tag;
	const oldFile = join(drizzleDir, `${last.tag}.sql`);
	if (!existsSync(oldFile)) {
		return {
			retagged: false,
			oldTag: last.tag,
			error: `the newest migration's file is missing: ${oldFile}`,
		};
	}
	renameSync(oldFile, join(drizzleDir, `${newTag}.sql`));
	last.tag = newTag;
	writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
	return { retagged: true, tag: newTag, oldTag: renameFrom };
}
