// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The roadmap's rules, made enforceable. Three of them, and each exists because breaking
// it produces something that still looks right.
//
// 🚨 **The dating rule reads as an inconsistency to somebody tidying up** — three buckets
// and only one of them carries dates — and the fix a tidy-up reaches for is to date the
// other two, which puts a promise on the public surface that Anthers does not hold
// internally.
//
// 🚨 **The length rule looks like a style preference and is the honesty mechanism.** The
// first draft of `roadmap.ts` ran a persuasive paragraph per goal, and at that length a
// description of something unbuilt is indistinguishable from a description of something
// that works. Concision plus the status pill on the card is what carries the tense now, so
// the cap is load-bearing: relax it and the page quietly stops being honest before it
// stops being readable.
//
// 🚨 **A documentation reference points at a page that has to exist.** These render as
// inert chips today because the wiki is not served, which makes them the easiest thing on
// the page to get wrong — nothing navigates, so nothing 404s, so a typo survives forever
// and surfaces on the day the wiki ships. Checking them against the real vault is the only
// thing standing between that and a page full of dead links at launch.

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	allItems,
	BUCKETS,
	countIn,
	docHref,
	MAX_BLURB,
	MAX_NOTE,
	ROADMAP,
	type RoadmapItem,
} from "./roadmap";

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
		// Reading every field rather than only `quarter` is deliberate — the tempting way to
		// date a planned goal is to write "by Q2 2027" into its prose, which no field-shaped
		// check would catch.
		for (const { where, item } of located()) {
			if (item.bucket === "launched") continue;
			const prose = `${item.title} ${item.blurb} ${item.note ?? ""}`;
			expect(`${where}: ${(item as { quarter?: string }).quarter ?? "undated"}`).toBe(
				`${where}: undated`,
			);
			expect(`${where}: ${/\bQ[1-4] 20\d\d\b/.test(prose) ? "dated in prose" : "undated"}`).toBe(
				`${where}: undated`,
			);
		}
	});
});

describe("the roadmap says it in one short sentence", () => {
	it(`🚨 keeps every blurb under ${MAX_BLURB} characters`, () => {
		for (const { where, item } of located()) {
			expect(`${where}: ${item.blurb.length} chars`).toBe(
				`${where}: ${Math.min(item.blurb.length, MAX_BLURB)} chars`,
			);
		}
	});

	it(`keeps every note under ${MAX_NOTE} characters — it corrects an impression, it does not add a second description`, () => {
		for (const { where, item } of located()) {
			if (!item.note) continue;
			expect(`${where}: ${item.note.length} chars`).toBe(
				`${where}: ${Math.min(item.note.length, MAX_NOTE)} chars`,
			);
		}
	});

	it("⚠️ never lets a note restate what the status pill already says", () => {
		// The note is for a partial state that would otherwise mislead — something that
		// exists but does not do what its name implies, or something blocked rather than
		// merely unscheduled. "Not started" on a planned goal is the pill's job, and a note
		// that repeats it is the drift back toward the paragraph-per-goal page this replaced.
		for (const { where, item } of located()) {
			if (!item.note) continue;
			expect(
				`${where}: ${/^not (?:started|built)\.?$/i.test(item.note.trim()) ? "restates the pill" : "adds something"}`,
			).toBe(`${where}: adds something`);
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
		// collapses to one subgroup has stopped being a group and become a long list.
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

const ORG = join(import.meta.dir, "../../../../..");

/**
 * Whether this checkout sits inside the Anthers organization, which decides whether a
 * missing wiki is a skip or a failure. Mirrors `insideOrganization()` in
 * `scripts/econ-figures.ts`.
 *
 * 🚨 **This asked whether `Anthers-Wiki-Private` existed until 2026-09-03, which was the
 * wrong question and was about to answer itself wrongly.** That vault was being dissolved
 * into `Anthers-Wiki`, so deleting the last of it would have flipped this to `false` and
 * quietly switched every documentation check below into skip mode — on the one machine
 * that actually has a wiki to check against. The question is whether we are in the
 * organization, and the answer is any sibling named for it.
 */
function insideOrganization(): boolean {
	try {
		return readdirSync(ORG, { withFileTypes: true }).some(
			(e) => e.isDirectory() && e.name.startsWith("Anthers-"),
		);
	} catch {
		return false;
	}
}

/**
 * Every `NN.NN` page in the public wiki, as `id → title`.
 *
 * ⚠️ **Absent is a skip; absent where it should exist is a FAILURE.** The wiki is a local
 * Obsidian vault that only Parker has, so CI has none and must run clean without it — but
 * a checkout sitting inside the Anthers organization is expected to have a sibling wiki,
 * and a missing one there means a moved directory rather than a machine without a vault.
 * `econ-figures.ts` draws exactly this distinction and for exactly this reason.
 *
 * 🚨 **This function's first draft was off by one directory and the skip swallowed it** —
 * ten green tests, 349 assertions, and not one documentation reference actually checked.
 * That is the whole argument for the distinction: a silent skip and a broken path look
 * identical from the outside, and the broken one is the state you least want to be in.
 */
function wikiPages(): Map<string, string> | { error: string } {
	const root = process.env.ANTHERS_WIKI ?? join(ORG, "Anthers-Wiki");
	if (!existsSync(root)) {
		return insideOrganization()
			? {
					error:
						`no public wiki at ${root}, but this checkout sits inside the Anthers ` +
						`organization, where one is expected (moved, or renamed? set ANTHERS_WIKI)`,
				}
			: { error: "skip" };
	}

	const pages = new Map<string, string>();
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			// `Internal Wiki` is Parker's opt-out folder: pages there are deliberately not
			// published, so a roadmap card must never point at one. Skipping it here is what
			// turns such a reference into a failure rather than a silently dead chip.
			if (entry.startsWith(".") || entry === "Internal Wiki") continue;
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) {
				walk(path);
				continue;
			}
			const match = entry.match(/^(\d\d\.\d\d) (.+)\.md$/);
			if (match) pages.set(match[1], match[2]);
		}
	};
	walk(root);
	return pages.size > 0
		? pages
		: { error: `${root} exists but holds no NN.NN pages — is that really the wiki?` };
}

describe("every documentation reference points at a page that exists", () => {
	const pages = wikiPages();

	it("finds the public wiki, or is on a machine that legitimately has none", () => {
		// Asserted rather than assumed. Without this, a wrong path degrades into "nothing to
		// check" and every test below passes by doing nothing.
		if ("error" in pages) expect(pages.error).toBe("skip");
		else expect(pages.size).toBeGreaterThan(0);
	});

	it("resolves each one against the public wiki, by id and by title", () => {
		if ("error" in pages) {
			console.log("  (no public wiki on this machine — documentation references unchecked)");
			return;
		}
		for (const { where, item } of located()) {
			if (!item.doc) continue;
			const actual = pages.get(item.doc.id);
			expect(`${where} → ${item.doc.id} ${item.doc.title}`).toBe(
				`${where} → ${item.doc.id} ${actual ?? "«no such page»"}`,
			);
		}
	});

	it("⏳ renders every reference as inert while the wiki is unserved", () => {
		// The tripwire. `docHref` returns null for everything today, and flipping it to
		// return a path is what turns these chips into links — so this test is the thing
		// that makes somebody doing that read the note beside it. When the wiki ships,
		// replace this with a check that each returned path is a route that resolves;
		// deleting it outright leaves the buttons unguarded in both directions.
		for (const { item } of located()) {
			if (!item.doc) continue;
			expect(docHref(item.doc)).toBeNull();
		}
	});
});
