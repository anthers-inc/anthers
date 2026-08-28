// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The parental-controls policy — exhaustively, without a database or a browser, which is the
 * point of it being pure.
 *
 * 🚨 **The list shape is the thing most worth pinning.** One `{ defaultAllow, rules }` serves
 * both an allowlist and a blocklist, so a guardian never has to understand a mode — and the
 * failure that would follow from getting it wrong is silent and asymmetric: an allowlist that
 * fell open shows a child everything, while a blocklist that fell shut merely annoys an adult.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	censorText,
	dailyCapFor,
	LANGUAGE_SUBSTITUTIONS,
	NO_PARENTAL_CONTROLS,
	PARENTAL_MEDIA_TYPES,
	type ParentalPolicy,
	parentalRefusal,
	spentWindow,
} from "./parental-controls";

function policy(over: Partial<ParentalPolicy> = {}): ParentalPolicy {
	return { ...NO_PARENTAL_CONTROLS, enabled: true, ...over };
}

const VIDEO_BY_7 = { creatorId: 7, workType: "video" };

describe("no controls", () => {
	test("refuses nothing and caps nothing", () => {
		expect(parentalRefusal(NO_PARENTAL_CONTROLS, VIDEO_BY_7)).toBeNull();
		expect(dailyCapFor(NO_PARENTAL_CONTROLS, VIDEO_BY_7)).toBeNull();
	});

	test("🚨 a policy that exists but permits everything is still not 'no controls'", () => {
		// The two states differ in what can be *done to them*: an account with a pin can be
		// locked out of its own maturity settings, and one without cannot. Collapsing them
		// would make "there is a pin" unrepresentable.
		expect(NO_PARENTAL_CONTROLS.enabled).toBe(false);
		expect(policy().enabled).toBe(true);
		expect(parentalRefusal(policy(), VIDEO_BY_7)).toBeNull();
	});
});

describe("one list shape, two meanings", () => {
	test("defaultAllow: true with allow: false entries is a BLOCKlist", () => {
		const p = policy({
			creators: { defaultAllow: true, rules: [{ key: "7", allow: false, dailySeconds: null }] },
		});
		expect(parentalRefusal(p, VIDEO_BY_7)).toBe("blocked_creator");
		expect(parentalRefusal(p, { creatorId: 8, workType: "video" })).toBeNull();
	});

	test("defaultAllow: false with allow: true entries is an ALLOWlist", () => {
		const p = policy({
			creators: { defaultAllow: false, rules: [{ key: "7", allow: true, dailySeconds: null }] },
		});
		expect(parentalRefusal(p, VIDEO_BY_7)).toBeNull();
		expect(parentalRefusal(p, { creatorId: 8, workType: "video" })).toBe("blocked_creator");
	});

	test("🚨 an empty allowlist permits nothing, rather than everything", () => {
		// The direction this must never fail in. A list with no entries has to mean what it
		// says — "only these", of which there are none — and not fall back to permissive
		// because there was nothing to compare against.
		const p = policy({ creators: { defaultAllow: false, rules: [] } });
		expect(parentalRefusal(p, VIDEO_BY_7)).toBe("blocked_creator");
	});

	test("a Work whose creator deleted their account takes the default", () => {
		// Not quietly exempted from a list it cannot be named in — a withdrawn Work under an
		// allowlist is out of reach, which is the cautious reading.
		const allow = policy({ creators: { defaultAllow: false, rules: [] } });
		expect(parentalRefusal(allow, { creatorId: null, workType: "text" })).toBe("blocked_creator");
		const block = policy({ creators: { defaultAllow: true, rules: [] } });
		expect(parentalRefusal(block, { creatorId: null, workType: "text" })).toBeNull();
	});

	test("media types use the same shape", () => {
		const readingOnly = policy({
			types: {
				defaultAllow: false,
				rules: [
					{ key: "text", allow: true, dailySeconds: null },
					{ key: "ebook", allow: true, dailySeconds: null },
				],
			},
		});
		expect(parentalRefusal(readingOnly, { creatorId: 7, workType: "text" })).toBeNull();
		expect(parentalRefusal(readingOnly, { creatorId: 7, workType: "ebook" })).toBeNull();
		expect(parentalRefusal(readingOnly, VIDEO_BY_7)).toBe("blocked_type");
	});

	test("reports WHICH rule stopped it, creator before type", () => {
		// A guardian who has blocked a creator and blocked games needs to know which one bit,
		// or the panel becomes a thing you fight instead of a thing you configure.
		const p = policy({
			creators: { defaultAllow: true, rules: [{ key: "7", allow: false, dailySeconds: null }] },
			types: { defaultAllow: true, rules: [{ key: "video", allow: false, dailySeconds: null }] },
		});
		expect(parentalRefusal(p, VIDEO_BY_7)).toBe("blocked_creator");
	});
});

describe("daily caps", () => {
	test("the tightest cap wins, and the whole-app limit competes", () => {
		// "Two hours a day, of which one may be games" needs no special case: both are
		// candidates and the smaller is the answer.
		const p = policy({
			limits: { daily: 7200, weekly: null, monthly: null },
			types: { defaultAllow: true, rules: [{ key: "game", allow: true, dailySeconds: 3600 }] },
		});
		expect(dailyCapFor(p, { creatorId: 1, workType: "game" })).toBe(3600);
		expect(dailyCapFor(p, { creatorId: 1, workType: "text" })).toBe(7200);
	});

	test("a per-type cap above the whole-app one simply does not tighten anything", () => {
		const p = policy({
			limits: { daily: 3600, weekly: null, monthly: null },
			types: { defaultAllow: true, rules: [{ key: "game", allow: true, dailySeconds: 7200 }] },
		});
		expect(dailyCapFor(p, { creatorId: 1, workType: "game" })).toBe(3600);
	});

	test("a cap on a blocked key says nothing, because it is unreachable anyway", () => {
		const p = policy({
			types: { defaultAllow: true, rules: [{ key: "game", allow: false, dailySeconds: 60 }] },
		});
		expect(parentalRefusal(p, { creatorId: 1, workType: "game" })).toBe("blocked_type");
	});
});

describe("which window is spent", () => {
	const consumed = (over: Partial<Record<string, number>> = {}) => ({
		day: 0,
		week: 0,
		month: 0,
		scopedDay: 0,
		...over,
	});

	test("reports the NARROWEST spent window", () => {
		// The one whose reset is soonest, and therefore the one worth telling somebody about.
		// "You have more tomorrow" is useful where "you have more next month" is not.
		const p = policy({ limits: { daily: 3600, weekly: 7200, monthly: 10_800 } });
		expect(spentWindow(p, consumed({ day: 3600, week: 7200, month: 10_800 }), null)).toBe("day");
		expect(spentWindow(p, consumed({ day: 0, week: 7200, month: 10_800 }), null)).toBe("week");
		expect(spentWindow(p, consumed({ day: 0, week: 0, month: 10_800 }), null)).toBe("month");
	});

	test("a scoped cap reports as the day, because that is what it is", () => {
		const p = policy({ limits: { daily: null, weekly: null, monthly: null } });
		expect(spentWindow(p, consumed({ scopedDay: 3600 }), 3600)).toBe("day");
		expect(spentWindow(p, consumed({ scopedDay: 3599 }), 3600)).toBeNull();
	});

	test("exactly spent is spent", () => {
		const p = policy({ limits: { daily: 3600, weekly: null, monthly: null } });
		expect(spentWindow(p, consumed({ day: 3600 }), null)).toBe("day");
		expect(spentWindow(p, consumed({ day: 3599 }), null)).toBeNull();
	});

	test("nothing is spent when the controls are off", () => {
		expect(spentWindow(NO_PARENTAL_CONTROLS, consumed({ day: 99_999 }), 1)).toBeNull();
	});
});

describe("the language filter", () => {
	test("substitutes listed words and preserves case", () => {
		expect(censorText("what the fuck")).toBe("what the fork");
		expect(censorText("What the Fuck")).toBe("What the Fork");
		expect(censorText("WHAT THE FUCK")).toBe("WHAT THE FORK");
	});

	test("prefers the longest match, so a compound is not half-replaced", () => {
		expect(censorText("motherfucker")).toBe("motherforker");
	});

	test("only whole words", () => {
		// A filter that matched inside words would rewrite "assassin" and "class" — the kind of
		// mangling that makes a household turn the feature off.
		expect(censorText("assassin")).toBe("assassin");
		expect(censorText("classic bass")).toBe("classic bass");
		expect(censorText("Scunthorpe")).toBe("Scunthorpe");
	});

	test("⚠️ leaves unlisted inflections alone rather than guessing", () => {
		// Exact words, deliberately: a stem rule gives "shitty" → "shirtty", and a predictable
		// filter that misses a word beats a clever one that mangles a sentence. This is a
		// courtesy to a household, not a claim about content.
		expect(censorText("fuckwit")).toBe("fuckwit");
		expect(LANGUAGE_SUBSTITUTIONS.fuckwit).toBeUndefined();
	});

	test("is a no-op on text with nothing to change", () => {
		expect(censorText("")).toBe("");
		expect(censorText("a perfectly ordinary sentence")).toBe("a perfectly ordinary sentence");
	});
});

describe("the media list", () => {
	test("🚨 covers every medium the platform has a consumption mode for", () => {
		/*
		 * A medium missing from `PARENTAL_MEDIA_TYPES` is one a guardian has **no way to
		 * block**, and nothing would say so — the panel would simply not offer it. That is the
		 * same silent-inertness trap `CONSUMPTION` documents for the Time Pool, so it is
		 * checked the same way: against the source rather than against a copy of it.
		 */
		const source = readFileSync(new URL("./attention.ts", import.meta.url), "utf8");
		const block = source.slice(
			source.indexOf("const CONSUMPTION"),
			source.indexOf("};", source.indexOf("const CONSUMPTION")),
		);
		const entries = [...block.matchAll(/^\t(\w+): "(\w+)"/gm)].map((m) => [m[1]!, m[2]!]);
		expect(entries.length).toBeGreaterThan(5);

		const offered = new Set(PARENTAL_MEDIA_TYPES.map((t) => t.value));
		for (const [medium, mode] of entries) {
			// ⚠️ `physical` and `service` carry mode "none" — a shipped object and a commissioned
			// piece of work are consumed off the platform entirely, so there is no reaching for a
			// guardian to restrict and no seconds to cap. Blocking one would be blocking a
			// *purchase*, which is a different thing this panel does not claim to do.
			if (mode === "none") {
				expect(offered.has(medium)).toBe(false);
				continue;
			}
			expect(offered.has(medium), medium).toBe(true);
		}
	});
});
