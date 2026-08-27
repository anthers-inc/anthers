// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The pure half of the content-rating vocabulary.
 *
 * ⭐ **`isAtLeastAsCautious` is the one worth testing hardest**, because it is not a
 * convenience — it is the whole of the rule that decides when a creator may change a rating
 * an operator set. Written as an order rather than as a pair of `if`s so that inserting a
 * fourth value between the existing ones cannot silently invert it, and asserted here across
 * every pair so that a reordering of `CAUTION` fails loudly.
 */
import { describe, expect, it } from "bun:test";
import {
	CONTENT_NOTES,
	contentNoteLabel,
	isAtLeastAsCautious,
	isContentNote,
	isMaturityRating,
	MATURITY_CHOICES,
	MATURITY_RATINGS,
	type MaturityRating,
	maturityLabel,
	normalizeContentNotes,
} from "./content-rating.js";

describe("the rating vocabulary", () => {
	it("has exactly three values, and `unrated` is one of them", () => {
		// `unrated` being a value rather than a null is the decision this pins: an
		// unanswered question and an answer of "General" are different facts, and the
		// report reason for unlabeled mature work depends on being able to tell them apart.
		expect([...MATURITY_RATINGS]).toEqual(["unrated", "general", "mature"]);
		expect(isMaturityRating("unrated")).toBe(true);
		expect(isMaturityRating("adults-only")).toBe(false);
	});

	it("never offers `unrated` as something to pick", () => {
		// A picker that offered it would be a way to un-release a Work by a side door: the
		// release gate refuses an unrated Work, so one already out would land in a state no
		// path a creator can take could have produced.
		expect(MATURITY_CHOICES.map((c) => c.value)).toEqual(["general", "mature"]);
	});

	it("labels every value, including the one nobody picks", () => {
		expect(maturityLabel("unrated")).toBe("Unrated");
		expect(maturityLabel("general")).toBe("General");
		expect(maturityLabel("mature")).toBe("Mature");
		// Forward compatibility: a value a later build adds must not render as blank.
		expect(maturityLabel("something-new")).toBe("something-new");
	});
});

describe("isAtLeastAsCautious — what a creator may change after a correction", () => {
	const ORDER: MaturityRating[] = ["unrated", "general", "mature"];

	it("orders the three values, in both directions", () => {
		for (let i = 0; i < ORDER.length; i++) {
			for (let j = 0; j < ORDER.length; j++) {
				const next = ORDER[i]!;
				const current = ORDER[j]!;
				expect(
					isAtLeastAsCautious(next, current),
					`${next} vs ${current}`,
					// Reads directly off the array order, so a reordering of the internal
					// table fails here rather than quietly letting a creator undo a
					// correction.
				).toBe(i >= j);
			}
		}
	});

	it("lets a creator raise an operator's General to Mature", () => {
		// Being more cautious about your own work is your business — the harm this rule
		// guards against is only ever in the other direction.
		expect(isAtLeastAsCautious("mature", "general")).toBe(true);
	});

	it("refuses to lower an operator's Mature to General", () => {
		expect(isAtLeastAsCautious("general", "mature")).toBe(false);
	});

	it("treats no change as allowed", () => {
		// Load-bearing: the Work editor sends the whole form on every save, so a PATCH that
		// merely includes the current rating must not read as an attempt to change it.
		for (const value of ORDER) expect(isAtLeastAsCautious(value, value)).toBe(true);
	});

	it("refuses a return to unrated from anywhere", () => {
		expect(isAtLeastAsCautious("unrated", "general")).toBe(false);
		expect(isAtLeastAsCautious("unrated", "mature")).toBe(false);
	});
});

describe("content notes", () => {
	it("recognizes its own values and nothing else", () => {
		expect(isContentNote("violence")).toBe(true);
		expect(isContentNote("Violence")).toBe(false);
		expect(isContentNote("queer-lives")).toBe(false);
	});

	it("labels every value it defines", () => {
		for (const note of CONTENT_NOTES) expect(contentNoteLabel(note.value)).toBe(note.label);
		expect(contentNoteLabel("something-new")).toBe("something-new");
	});

	it("drops what it cannot label", () => {
		// A note nothing can render is a note nobody can read, so it is dropped rather than
		// stored and shown as a raw code beside real ones.
		expect(normalizeContentNotes(["violence", "made-up", "horror"])).toEqual([
			"violence",
			"horror",
		]);
	});

	it("returns them in one canonical order whatever order they arrive in", () => {
		// The notes render as a list a reader scans, and a set that reorders itself between
		// saves reads as a change that was not made.
		const forward = normalizeContentNotes(["violence", "language"]);
		const backward = normalizeContentNotes(["language", "violence"]);
		expect(forward).toEqual(backward);
		expect(forward).toEqual(["violence", "language"]);
	});

	it("de-duplicates", () => {
		expect(normalizeContentNotes(["violence", "violence"])).toEqual(["violence"]);
	});

	it("does not list queer lives, and must never learn to", () => {
		// 🚨 The one assertion here that is about values rather than mechanics. An early
		// draft of Anthers' report copy listed "queer lives" as an example of mature work,
		// which asserts precisely the premise 40.09 exists to refuse. A content note is a
		// warning about what is in a work; queer people existing in one is not a warning.
		const values = CONTENT_NOTES.map((n) => n.value).join(" ");
		expect(values).not.toContain("queer");
		expect(values).not.toContain("lgbt");
		expect(values).not.toContain("trans");
	});
});
