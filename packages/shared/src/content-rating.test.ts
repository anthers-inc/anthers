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
	ACCEPTED_MATURITY_RATINGS,
	CONTENT_NOTES,
	contentNoteLabel,
	isAtLeastAsCautious,
	isContentNote,
	isMaturityRating,
	isRatingAccepted,
	MATURITY_CHOICES,
	MATURITY_RATINGS,
	type MaturityRating,
	maturityLabel,
	normalizeContentNotes,
	releaseRatingRefusal,
	requiresAdultVerification,
	rungBelow,
} from "./content-rating.js";

describe("the rating vocabulary", () => {
	it("has exactly four values, and `unrated` is one of them", () => {
		// `unrated` being a value rather than a null is the decision this pins: an
		// unanswered question and an answer of "General" are different facts, and the
		// report reason for unlabeled mature work depends on being able to tell them apart.
		expect([...MATURITY_RATINGS]).toEqual(["unrated", "general", "mature", "adult"]);
		expect(isMaturityRating("unrated")).toBe(true);
		// 🚨 The rung is `adult`, never `adults-only` — the second collides with the ESRB's
		// existing AO rating, which is a different scale saying a different thing.
		expect(isMaturityRating("adult")).toBe(true);
		expect(isMaturityRating("adults-only")).toBe(false);
	});

	it("has no rung above Adult, and must never grow one", () => {
		// 🚨 The value assertion in this file. Work made for the purpose of sexual
		// gratification is not published on Anthers at all, so there is no rung for it: a
		// creator has no way to declare it, because nobody needs a way to say their work is
		// something that cannot be here whatever it is called. The boundary is enforced
		// through the `pornography` report reason instead. A value added here would turn a
		// content rule into a rung somebody could sit at.
		const values = MATURITY_RATINGS.join(" ");
		expect(values).not.toContain("explicit");
		expect(values).not.toContain("porn");
		expect(values).not.toContain("xxx");
	});

	it("never offers `unrated` as something to pick", () => {
		// A picker that offered it would be a way to un-release a Work by a side door: the
		// release gate refuses an unrated Work, so one already out would land in a state no
		// path a creator can take could have produced.
		expect(MATURITY_CHOICES.map((c) => c.value)).toEqual(["general", "mature", "adult"]);
	});

	it("labels every value, including the one nobody picks", () => {
		expect(maturityLabel("unrated")).toBe("Unrated");
		expect(maturityLabel("general")).toBe("General");
		expect(maturityLabel("mature")).toBe("Mature");
		expect(maturityLabel("adult")).toBe("Adult");
		// Forward compatibility: a value a later build adds must not render as blank.
		expect(maturityLabel("something-new")).toBe("something-new");
	});

	it("tells a creator the Adult rung costs them nothing, in the hint they read while choosing", () => {
		// 🚨 The rating was paid-only until 2026-08-28, and a creator carrying that
		// assumption would under-declare to avoid a price that no longer exists — the exact
		// pressure the wiki's *Rating Standard* is built to remove. So the hint has to say what the rung does
		// NOT do, and this asserts it still does.
		const adult = MATURITY_CHOICES.find((c) => c.value === "adult");
		expect(adult?.hint).toContain("verified");
		expect(adult?.hint).toContain("Public Access");
		expect(adult?.hint).toContain("still earns from the Time Pool");
		// And never the retired claim.
		expect(adult?.hint).not.toContain("must be sold");
		expect(adult?.hint).not.toContain("never Public Access");
	});
});

describe("requiresAdultVerification — the gate that has to fail closed", () => {
	it("says no for the rungs that genuinely need nothing", () => {
		expect(requiresAdultVerification("unrated")).toBe(false);
		expect(requiresAdultVerification("general")).toBe(false);
		// 🚨 Mature especially. A mature rating is a warning and a filter input carrying no
		// access consequence, and a gate that read it would silently put the work the wiki's *Rating Standard*
		// draws its rows to protect behind an age check.
		expect(requiresAdultVerification("mature")).toBe(false);
	});

	it("says yes for Adult", () => {
		expect(requiresAdultVerification("adult")).toBe(true);
	});

	it("🚨 says yes for anything it does not recognize, including null", () => {
		// **The whole reason this is a function rather than `=== "adult"` at each call
		// site.** The two ways it can be wrong are not symmetric: refusing an adult
		// something they should have is a complaint, showing a minor something they should
		// not is the failure the rung exists to prevent. So a value from a newer deployment
		// mid-rollout, a corrupted row, or a rung added above `adult` later is gated rather
		// than waved through — *"I'd rather have someone not see Adult content when they
		// should than see Adult content when they shouldn't"* (Parker, 2026-08-28).
		expect(requiresAdultVerification("a-rung-from-the-future")).toBe(true);
		expect(requiresAdultVerification("")).toBe(true);
		expect(requiresAdultVerification(null)).toBe(true);
		expect(requiresAdultVerification(undefined)).toBe(true);
		// Case matters, because the stored value is a code rather than prose.
		expect(requiresAdultVerification("Mature")).toBe(true);
	});

	it("classifies every rung the scale defines", () => {
		// Ties the predicate to the vocabulary, so a value added to `MATURITY_RATINGS`
		// without a decision here shows up as `adult`-side rather than as an oversight.
		for (const rating of MATURITY_RATINGS) {
			expect(requiresAdultVerification(rating), rating).toBe(rating === "adult");
		}
	});
});

describe("which rungs Anthers accepts", () => {
	it("accepts every rung on the scale", () => {
		// ⚠️ This asserts the switch's CURRENT position, and it is meant to fail when the
		// position changes — that is what makes opening or closing a rung a deliberate act
		// with a reader rather than a constant somebody edited in passing. It failed when
		// Adult was added, which is the mechanism working.
		//
		// ⭐ Adult went on this list only once every fence it needs was real: the payment
		// requirement, the exclusion from Public Access and so from the Time Pool, the
		// invisibility to anyone who has not opted in, the adulthood verification, and the
		// reader's own controls. **If a rung is ever added here again, that is the bar.**
		expect([...ACCEPTED_MATURITY_RATINGS]).toEqual(["general", "mature", "adult"]);
		for (const choice of MATURITY_CHOICES) expect(isRatingAccepted(choice.value)).toBe(true);
		// `unrated` is not a rung and so is not accepted; the release gate answers it with
		// its own message first.
		expect(isRatingAccepted("unrated")).toBe(false);
	});

	it("refuses release at a rung that is not accepted", () => {
		// 🚨 Tested against an explicit set, because **every rung is open today and this is
		// the only place the closed branch can be exercised at all.** The mechanism has to
		// keep working: the wiki's *Rating Standard* is explicit that a rung can close again when the queue outruns
		// whoever is reading it, and that turning one off is the correct response rather
		// than a failure. The day that happens, this proves the refusal already worked
		// rather than being tried for the first time under pressure.
		const openOnlyToGeneral: MaturityRating[] = ["general"];
		expect(releaseRatingRefusal("mature", openOnlyToGeneral)).toBe("closed");
		expect(releaseRatingRefusal("adult", openOnlyToGeneral)).toBe("closed");
		expect(releaseRatingRefusal("general", openOnlyToGeneral)).toBe(null);
		expect(releaseRatingRefusal("adult", [])).toBe("closed");
	});

	it("answers an unrated Work `undeclared` even when nothing is accepted", () => {
		// 🚨 The ordering, and it is load-bearing. `unrated` is not on the accepted list
		// either, so a gate that asked about acceptance first would tell a creator who has
		// simply not answered yet that Anthers is not taking their kind of work — which is
		// both false and unfixable, where the real problem is one click.
		expect(releaseRatingRefusal("unrated", [])).toBe("undeclared");
		expect(releaseRatingRefusal("unrated")).toBe("undeclared");
	});

	it("lets every rung release, against the live switch", () => {
		for (const choice of MATURITY_CHOICES) expect(releaseRatingRefusal(choice.value)).toBe(null);
	});
});

describe("rungBelow — what an appeal against a correction asks for", () => {
	it("walks one rung down the scale", () => {
		expect(rungBelow("adult")).toBe("mature");
		expect(rungBelow("mature")).toBe("general");
	});

	it("has nothing below General", () => {
		// The useful half: a creator whose rating was corrected DOWN has nothing to appeal,
		// because raising it back is theirs to do without asking. Returning `mature` here
		// would offer them a queue for something that is already one click away.
		expect(rungBelow("general")).toBe(null);
	});

	it("never offers `unrated` as a destination", () => {
		// Appealing back to "nobody has said" would un-release a Work by a side door, the
		// same reason the picker does not offer it.
		expect(rungBelow("general")).not.toBe("unrated");
		for (const value of MATURITY_RATINGS) expect(rungBelow(value)).not.toBe("unrated");
	});

	it("asks for something strictly less cautious than what it is appealing", () => {
		// Ties the two orderings together: whatever `rungBelow` returns must be a value
		// `isAtLeastAsCautious` would refuse a locked creator, or the appeal would be asking
		// for something they could simply have set.
		for (const value of MATURITY_RATINGS) {
			const below = rungBelow(value);
			if (below) expect(isAtLeastAsCautious(below, value)).toBe(false);
		}
	});
});

describe("isAtLeastAsCautious — what a creator may change after a correction", () => {
	// ⭐ The whole reason this is an order rather than a pair of `if`s: `adult` was added
	// above the existing values on 2026-08-28, and the rule that a creator may raise but not
	// lower a correction had to survive it untouched. This array is what proves it did —
	// every pair is asserted below, so a value inserted anywhere in `CAUTION` that inverted
	// the rule would fail here rather than in production, on somebody's work.
	const ORDER: MaturityRating[] = ["unrated", "general", "mature", "adult"];

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

	it("lets a creator raise their own work all the way to Adult", () => {
		// The rung an operator may not move somebody else's Work to is one a creator may
		// always declare about their own. Raising your own rating costs nobody else
		// anything, which is why the second-decision-maker rule sits on corrections alone.
		expect(isAtLeastAsCautious("adult", "mature")).toBe(true);
		expect(isAtLeastAsCautious("adult", "general")).toBe(true);
	});

	it("refuses to lower an operator's Mature to General", () => {
		expect(isAtLeastAsCautious("general", "mature")).toBe(false);
	});

	it("refuses to lower an operator's Adult to anything", () => {
		expect(isAtLeastAsCautious("mature", "adult")).toBe(false);
		expect(isAtLeastAsCautious("general", "adult")).toBe(false);
	});

	it("treats no change as allowed", () => {
		// Load-bearing: the Work editor sends the whole form on every save, so a PATCH that
		// merely includes the current rating must not read as an attempt to change it.
		for (const value of ORDER) expect(isAtLeastAsCautious(value, value)).toBe(true);
	});

	it("refuses a return to unrated from anywhere", () => {
		expect(isAtLeastAsCautious("unrated", "general")).toBe(false);
		expect(isAtLeastAsCautious("unrated", "mature")).toBe(false);
		expect(isAtLeastAsCautious("unrated", "adult")).toBe(false);
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
		// which asserts precisely the premise the wiki's *Rating Standard* exists to refuse. A content note is a
		// warning about what is in a work; queer people existing in one is not a warning.
		const values = CONTENT_NOTES.map((n) => n.value).join(" ");
		expect(values).not.toContain("queer");
		expect(values).not.toContain("lgbt");
		expect(values).not.toContain("trans");
	});
});
