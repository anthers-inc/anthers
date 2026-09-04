// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every table in the schema carries a `node` / `org` / `both` role tag.
 *
 * The tags are the map any future split of Anthers into creator nodes and organization
 * services would be drawn from: which rows would follow a creator to a machine they run,
 * which stay with the organization, and which are genuinely split down the middle. The
 * legend is at the top of `auth.ts`, and the reasoning for each table sits beside it.
 *
 * 🚨 **This exists because the classification was a one-time pass with nothing behind it,
 * and it decayed exactly the way an unguarded pass does.** All 42 tables were tagged on
 * 2026-08-20. By 2026-09-01 the schema held 51 and seven of the new ones carried no tag —
 * `share_links`, `parental_controls`, and five of the seven in `moderation.ts`, whose file
 * header still said "both tables" from when there were two. An eighth,
 * `atproto_oauth_state`, had a tag written *below* its definition, where it had stopped
 * describing that table and started reading as the header for `pending_signups`.
 *
 * ⭐ **The generalization, which is this project's most-repeated lesson in a new place:** a
 * claim about the whole schema needs something keeping it true, or it decays into a claim
 * about the day somebody made it. Nothing about the annotation pass was wrong; tables
 * arrived afterwards, which is what tables do. The published wiki said "every database
 * table is already labeled" on the strength of that pass and was wrong by eight when this
 * test was written.
 *
 * ⚠️ **This checks that a decision was recorded, never that it was the right one.** A wrong
 * tag passes. What it buys is that adding a table forces somebody to answer the question at
 * the moment they have the context to answer it, which is the only moment it is cheap.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 🚨 **This test lives OUTSIDE the schema directory it reads, and must stay there.**
 * `drizzle.config.ts` points `schema` at that directory, and drizzle-kit imports every
 * `.ts` in it — so a file calling `describe` at module scope makes `drizzle-kit generate`
 * fail outright. Migrations were ungeneratable from 2026-09-01, when this test landed
 * inside the directory, until 2026-09-04, and nothing said so until somebody tried to add
 * a table. The guard below (it finds the files it is checking) is what catches this path
 * going stale.
 */
const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "schema");

/** A tag comment: `// node — …`, `// org — …`, or `// both — …`, on its own line. */
const TAG = /^\s*\/\/\s*(node|org|both)\s+[—–-]/;

/** `export const foo = pgTable(` — the only way a table is declared here. */
const TABLE = /^export const (\w+) = pgTable\(/;

/**
 * The tag block sits directly above the declaration, after any docblock. Walking upward
 * rather than matching a fixed shape is what lets a table keep a long `/** … *\/` comment
 * *and* a tag, which most of them do — and it stops at the previous declaration so a tag
 * can never be counted twice.
 */
function taggedRoleFor(lines: string[], declIndex: number): string | null {
	for (let i = declIndex - 1; i >= 0; i--) {
		const match = TAG.exec(lines[i]);
		if (match) return match[1];
		if (TABLE.test(lines[i]) || /^\);\s*$/.test(lines[i])) return null;
	}
	return null;
}

const schemaFiles = readdirSync(SCHEMA_DIR)
	.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
	.filter((f) => f !== "index.ts" && f !== "relations.ts")
	.sort();

describe("schema role classification", () => {
	it("finds the schema files it is meant to be checking", () => {
		// Guards the guard: a rename or a move that emptied this list would otherwise make
		// the test below pass by checking nothing, which is the failure mode a source scan
		// is most prone to.
		expect(schemaFiles.length).toBeGreaterThanOrEqual(7);
	});

	const untagged: string[] = [];
	let tableCount = 0;

	for (const file of schemaFiles) {
		const lines = readFileSync(join(SCHEMA_DIR, file), "utf8").split("\n");
		lines.forEach((line, index) => {
			const match = TABLE.exec(line);
			if (!match) return;
			tableCount++;
			if (!taggedRoleFor(lines, index)) untagged.push(`${file}: ${match[1]}`);
		});
	}

	it("has tables to check", () => {
		expect(tableCount).toBeGreaterThanOrEqual(51);
	});

	it("tags every table with node, org or both", () => {
		// The message carries the whole list, because the person who hits this is adding one
		// table and should not have to run the scan themselves to find out which.
		expect(untagged).toEqual([]);
	});
});
