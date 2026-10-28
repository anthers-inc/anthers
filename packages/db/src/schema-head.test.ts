// SPDX-License-Identifier: Apache-2.0
/**
 * The comparison that decides whether a build may run its handlers.
 *
 * 🚨 **The failure direction is the point.** A guard that stands a worker down on a bad read
 * takes the queues down on the day a file moves; one that serves a build which is genuinely
 * behind runs jobs against columns that are gone. So only `database > build` stands down, and
 * every unreadable side answers `unknown`, which serves.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { readBuildSchemaHead, schemaStanding } from "./schema-head";

describe("schema standing", () => {
	it("serves when the database is at this build's head", () => {
		expect(schemaStanding(1793187084132, 1793187084132)).toBe("current");
	});

	it("stands down only when the database is ahead", () => {
		expect(schemaStanding(1793187084132, 1793187084133)).toBe("build-behind");
	});

	it("serves when this build is ahead of the database", () => {
		// A migration that has not run yet is the deploy's own ordering problem, and not a reason
		// for a worker to refuse work it can do.
		expect(schemaStanding(1793187084133, 1793187084132)).toBe("current");
	});

	it("answers unknown, never a stand-down, when either side is unreadable", () => {
		expect(schemaStanding(null, 1)).toBe("unknown");
		expect(schemaStanding(1, null)).toBe("unknown");
		expect(schemaStanding(null, null)).toBe("unknown");
	});

	it("reads this build's head from the journal the migrate job reads", () => {
		const journal = JSON.parse(
			readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
		) as { entries: Array<{ when: number }> };
		// The head is the last entry's `when`, the same number Drizzle stamps into
		// `drizzle.__drizzle_migrations.created_at`. Assert the shape rather than a moving value.
		expect(readBuildSchemaHead()).toBe(journal.entries.at(-1)?.when ?? null);
		expect(journal.entries.length).toBeGreaterThan(0);
	});
});
