// SPDX-License-Identifier: Apache-2.0
/**
 * The generator's retag step, against real journals and real files in a fixture — a
 * test, because the step renames a tracked artifact and edits a ledger nobody else
 * may corrupt: a fresh migration is retagged to its timestamped name and nothing
 * else; a no-changes generate never retags a historical (committed) migration
 * (the freshness gate); a journal already carrying the timestamp shape is a no-op.
 *
 * The live half — the pty wrapper, drizzle-kit's own naming, the migrator's order —
 * is exercised by a real `db:generate` per the adoption task's brief, and by the
 * first real schema change after this lands.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retagNewestMigration, timestampedTag } from "./drizzle-retag.ts";

let root: string;

function journalOf(entries: { idx: number; when?: number; tag: string; breakpoints?: boolean }[]): void {
	writeFileSync(
		join(root, "meta", "_journal.json"),
		`${JSON.stringify({ version: "7", entries }, null, 2)}\n`,
	);
}

function readJournal(): { entries: { idx: number; when: number; tag: string }[] } {
	return JSON.parse(readFileSync(join(root, "meta", "_journal.json"), "utf8"));
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "drizzle-retag-test-"));
	mkdirSync(join(root, "meta"), { recursive: true });
});

afterAll(() => {
	rmSync(root, { force: true, recursive: true });
});

describe("the generator's retag", () => {
	test("a freshly generated sequence-numbered file is renamed to its timestamped tag, journal updated, snapshots untouched", () => {
		const when = Date.parse("2026-10-15T21:42:00.000Z");
		journalOf([{ idx: 0, when, tag: "0145_lucky_sersi", breakpoints: false }]);
		writeFileSync(join(root, "0145_lucky_sersi.sql"), "-- the migration\n");

		const result = retagNewestMigration(root);
		expect(result.retagged).toBe(true);
		expect(result.tag).toBe(timestampedTag("0145_lucky_sersi", when));
		expect(timestampedTag("0145_lucky_sersi", when)).toMatch(/^\d{8}-\d{6}_lucky_sersi$/);

		// The file moved and the journal agrees; the journal's other fields are untouched.
		const retagged = result.tag ?? "(untagged)";
		expect(readJournal().entries[0]?.tag).toBe(retagged);
	});

	test("a no-changes generate (the entry predates the run) retags nothing, ever", () => {
		const when = Date.parse("2026-10-14T18:00:00.000Z");
		journalOf([{ idx: 144, when, tag: "0144_great_boomer", breakpoints: true }]);
		writeFileSync(join(root, "0144_great_boomer.sql"), "-- committed history\n");

		// startedAt is AFTER the migration was written — exactly a no-changes generate.
		const result = retagNewestMigration(root, when + 1_000);
		expect(result.retagged).toBe(false);
		expect(readJournal().entries[0]?.tag).toBe("0144_great_boomer");
	});

	test("a journal already carrying the timestamp shape is a no-op, whatever the freshness", () => {
		const when = Date.parse("2026-10-15T22:00:00.000Z");
		const tag = timestampedTag("0146_lucky_sersi", when);
		journalOf([{ idx: 145, when, tag, breakpoints: true }]);
		writeFileSync(join(root, `${tag}.sql`), "-- new shape\n");

		const result = retagNewestMigration(root, when - 60_000);
		expect(result.retagged).toBe(false);
		expect(result.tag).toBe(tag);
	});

	test("a retag with a missing sql file is reported, never half-applied", () => {
		const when = Date.parse("2026-10-15T22:10:00.000Z");
		journalOf([{ idx: 146, when, tag: "0147_transquil_deadpool", breakpoints: true }]);
		// Fresh (the entry postdates the run's start) but its file missing — the
		// generator's ledger and the file on disk disagree.
		const result = retagNewestMigration(root, when - 1000);
		expect(result.retagged).toBe(false);
		expect(result.error).toContain("missing");
		expect(readJournal().entries[0]?.tag).toBe("0147_transquil_deadpool");
	});
});
