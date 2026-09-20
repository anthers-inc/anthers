// SPDX-License-Identifier: Apache-2.0
/**
 * The migration journal's timestamps must rise with its index.
 *
 * 🚨 **A renumbered migration is skipped by production silently and permanently.** Drizzle's
 * migrator reads only the newest applied migration's timestamp and applies a file only when the
 * `when` in its journal entry is newer than that one. So when two branches each generate a
 * migration and the one merging second renumbers its file to follow the other, that file's
 * `when` is now *older* than the one production already applied — and production never runs it,
 * while every local session passes because each migrates an empty database in journal order.
 * Nothing anywhere reports the gap.
 *
 * This is the one failure mode of parallel sessions that reaches production: two worktrees with
 * a schema change apiece merge fine, and the second one's table simply never exists in
 * production. The rule that prevents it is in the worktrees plan — the branch merging second
 * deletes its migration and regenerates it against the merged schema, never renumbering — and
 * this test is what catches the lapse when the rule isn't followed, because a journal that was
 * renumbered by hand has a `when` that no longer rises with `idx`.
 *
 * 🚨 **Do not "fix" this test by renumbering.** The right repair is to regenerate the migration
 * so its `when` reflects when it was actually written. A timestamp edited to satisfy the check
 * is the same lie production reads.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const JOURNAL = join(REPO, "packages", "db", "drizzle", "meta", "_journal.json");

interface JournalEntry {
	idx: number;
	when: number;
	tag: string;
	breakpoints: boolean;
}

describe("the migration journal", () => {
	it("has a `when` that rises with `idx`, so nothing was renumbered after generate", async () => {
		const journal = (await Bun.file(JOURNAL).json()) as { entries: JournalEntry[] };
		expect(journal.entries.length).toBeGreaterThan(0);

		const outOfOrder: string[] = [];
		for (let i = 1; i < journal.entries.length; i++) {
			const previous = journal.entries[i - 1];
			const entry = journal.entries[i];
			expect(entry.idx).toBe(i);
			if (entry.when <= previous.when) {
				outOfOrder.push(
					`${entry.tag} (idx ${entry.idx}, when ${entry.when}) is not newer than ` +
						`${previous.tag} (when ${previous.when})`,
				);
			}
		}
		expect(
			outOfOrder,
			"a journal entry older than its predecessor means a migration was renumbered " +
				"after generate, which production will never apply — regenerate it instead",
		).toEqual([]);
	});
});
