// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two roadmap rules that are easy to break by being helpful, made enforceable.
//
// 🚨 **Both of them will look like inconsistencies to somebody tidying up, which is
// exactly why they need a test rather than a comment.** The dating rule reads as an
// oversight — three buckets and only one of them carries dates — and the fix a tidy-up
// reaches for is to date the other two, which re-creates the promise the page exists to
// avoid making. The standing rule reads as repetition, because a well-written blurb about
// something unbuilt already *feels* complete; deleting the standing line leaves a fluent
// paragraph describing a feature that does not exist.
//
// ⚠️ The type system carries most of the weight — `RoadmapItem` is a discriminated union,
// so a quarter on a planned goal will not compile. The runtime checks below are for the
// two ways that protection goes away: somebody widens the type to one shape with optional
// fields "for convenience", or this data arrives from somewhere other than a literal. A
// test that only restates what the compiler already knows is worth little; one that
// survives the compiler being weakened is worth having.
//
// Sources: `content/roadmap.ts`'s own header carries the rules and the reasoning; the
// vault decision behind the three buckets is *Decide how the wiki and the public roadmap
// get their content* (2026-08-30).

import { describe, expect, it } from "bun:test";
import { allItems, BUCKETS, countIn, ROADMAP, type RoadmapItem } from "./roadmap";

/** Reported as `group › subgroup › id` so a failure names the entry, not an index. */
function located(): { where: string; item: RoadmapItem }[] {
	return ROADMAP.flatMap((g) =>
		g.subgroups.flatMap((s) =>
			s.items.map((item) => ({ where: `${g.label} › ${s.label} › ${item.id}`, item })),
		),
	);
}

describe("the roadmap dates what shipped and nothing else", () => {
	it("gives every launched goal a quarter, in the one shape the page can group by", () => {
		for (const { where, item } of located()) {
			if (item.bucket !== "launched") continue;
			expect(`${where}: ${item.quarter}`).toMatch(/: Q[1-4] 20\d\d$/);
		}
	});

	it("🚨 gives NO active or planned goal a date, in any field", () => {
		// The whole rule: a quarter on something shipped is retrospective fact, and a
		// quarter on something planned is a promise. Reading every field rather than only
		// `quarter` is deliberate — the tempting way to date a planned goal is to write
		// "by Q2 2027" into its prose, which no field-shaped check would catch.
		for (const { where, item } of located()) {
			if (item.bucket === "launched") continue;
			const prose = `${item.title} ${item.blurb} ${item.standing}`;
			expect(`${where}: ${(item as { quarter?: string }).quarter ?? "undated"}`).toBe(
				`${where}: undated`,
			);
			expect(`${where}: ${/\bQ[1-4] 20\d\d\b/.test(prose) ? "dated in prose" : "undated"}`).toBe(
				`${where}: undated`,
			);
		}
	});
});

describe("the roadmap says what is missing, not only what is wanted", () => {
	it("gives every unbuilt goal a standing", () => {
		for (const { where, item } of located()) {
			if (item.bucket === "launched") continue;
			expect(`${where}: ${item.standing.trim().length > 0 ? "stated" : "empty"}`).toBe(
				`${where}: stated`,
			);
		}
	});

	it("⚠️ requires that standing to actually name an absence", () => {
		// A proxy for the claim rather than the claim itself, and it is worth saying so:
		// `standing: "Coming soon"` satisfies the field and fails the reader. What this
		// catches is the drift toward describing the *effort* ("we are working toward it")
		// instead of the *gap*, which is the form the failure actually takes. If this fires
		// on a sentence you believe is honest, the question is what a reader would conclude,
		// not whether the pattern was fair.
		const NAMES_AN_ABSENCE = /\b(?:not|no|none|never|nothing|nobody|cannot|unbuilt)\b/i;
		for (const { where, item } of located()) {
			if (item.bucket === "launched") continue;
			expect(
				`${where}: ${NAMES_AN_ABSENCE.test(item.standing) ? "names a gap" : "describes effort"}`,
			).toBe(`${where}: names a gap`);
		}
	});

	it("never lets a launched goal carry one, so the field cannot become decoration", () => {
		for (const { where, item } of located()) {
			if (item.bucket !== "launched") continue;
			const standing = (item as { standing?: string }).standing;
			expect(`${where}: ${standing ?? "none"}`).toBe(`${where}: none`);
		}
	});
});

describe("the roadmap is shaped the way the page renders it", () => {
	it("holds no duplicate ids — they are the anchors a link points at", () => {
		const ids = allItems().map((i) => i.id);
		expect(ids.length).toBe(new Set(ids).size);
	});

	it("groups every goal under a subgroup, and every group under at least two of them", () => {
		// Parker's call: four major groups, each with subgroups within it. A group that
		// collapses to one subgroup has stopped being a group and become a long list, which
		// is the shape this structure was chosen over.
		for (const group of ROADMAP) {
			expect(`${group.label}: ${group.subgroups.length} subgroups`).not.toBe(
				`${group.label}: 1 subgroups`,
			);
			for (const sub of group.subgroups) {
				expect(`${group.label} › ${sub.label}: ${sub.items.length} items`).not.toBe(
					`${group.label} › ${sub.label}: 0 items`,
				);
			}
		}
	});

	it("fills all three buckets, so the page renders no empty section", () => {
		for (const bucket of BUCKETS) {
			expect(`${bucket.label}: ${countIn(bucket.id)}`).not.toBe(`${bucket.label}: 0`);
		}
	});
});
