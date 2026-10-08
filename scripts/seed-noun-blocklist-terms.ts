// SPDX-License-Identifier: Apache-2.0
/**
 * The Noun Project blocklist's starter term list — one list, two readers:
 *
 * - `scripts/seed-noun-blocklist.ts` writes it into production's `noun_blocklist`
 *   (the local control the search routes read),
 * - `scripts/noun-blocklist-vendor-sync.ts` pushes it up to the vendor's key-level
 *   blocklist (the same terms on their side).
 *
 * The terms and their reasons are the seed document's
 * (`Anthers-Wiki/Internal Wiki/Transient/Noun Project Blocklist Seed.md`); this file is
 * the machine-readable half, and a term added here is added to BOTH by the two readers.
 * Removals never happen here in bulk — remove an entry in production through the admin
 * door and re-run the sync, which reconciles by pushing the missing and never
 * overwriting what is already there.
 */

export const TERMS: { value: string; reason: string }[] = [
	// ── Child-safety absolutes ────────────────────────────────────────────
	// The platform's most serious boundary; errs toward over-refusal, because a refused
	// query costs a creator a search and the alternative costs a child.
	{ value: "loli", reason: "child-safety absolute" },
	{ value: "shota", reason: "child-safety absolute" },
	{ value: "lolicon", reason: "child-safety absolute" },
	{ value: "shotacon", reason: "child-safety absolute" },
	{ value: "cp", reason: "child-safety absolute" },
	{ value: "child porn", reason: "child-safety absolute" },
	{ value: "child nude", reason: "child-safety absolute" },
	{ value: "nude child", reason: "child-safety absolute" },
	{ value: "naked child", reason: "child-safety absolute" },
	{ value: "naked kid", reason: "child-safety absolute" },
	{ value: "nude kid", reason: "child-safety absolute" },
	{ value: "young girl nude", reason: "child-safety absolute" },
	{ value: "young boy nude", reason: "child-safety absolute" },
	{ value: "toddler nude", reason: "child-safety absolute" },
	{ value: "kids nude", reason: "child-safety absolute" },
	{ value: "child erotica", reason: "child-safety absolute" },
	{ value: "jailbait", reason: "child-safety absolute" },
	{ value: "preteen nude", reason: "child-safety absolute" },
	{ value: "underage nude", reason: "child-safety absolute" },
	{ value: "ptsc", reason: "child-safety absolute (known shorthand)" },
	{ value: "ygl", reason: "child-safety absolute (known shorthand)" },

	// ── Hate symbols ─────────────────────────────────────────────────────
	// A Badge is a public identity object — a hate symbol on one is the platform wearing
	// it. Refused as queries rather than filtered as results.
	{ value: "swastika", reason: "hate symbol" },
	{ value: "nazi", reason: "hate symbol" },
	{ value: "third reich", reason: "hate symbol" },
	{ value: "ss rune", reason: "hate symbol" },
	{ value: "schutzstaffel", reason: "hate symbol" },
	{ value: "iron cross nazi", reason: "hate symbol" },
	{
		value: "celtic cross",
		reason: "hate-symbol emblem (also a heritage symbol — judgment call, revisitable)",
	},
	{ value: "ku klux klan", reason: "hate symbol" },
	{ value: "kkk", reason: "hate symbol" },
	{ value: "blood and soil", reason: "hate symbol" },
	{ value: "1488", reason: "hate-symbol numeral" },
	{ value: "white power", reason: "hate slogan" },
	{ value: "burning cross", reason: "hate symbol" },

	// ── Slurs that double as icon-search terms ───────────────────────────
	{ value: "pickaninny", reason: "racial slur" },
	{ value: "golliwog", reason: "racial-slur caricature" },
	{ value: "sambo caricature", reason: "racial-slur caricature" },
	{ value: "tranny", reason: "transphobic slur" },
	{ value: "faggot", reason: "homophobic slur" },

	// ── Sexually explicit ────────────────────────────────────────────────
	// The Content Standards boundary, applied to the picker surface. Explicit acts and
	// explicit anatomy — not the merely suggestive.
	{ value: "sex", reason: "sexually explicit" },
	{ value: "porn", reason: "sexually explicit" },
	{ value: "pornography", reason: "sexually explicit" },
	{ value: "xxx", reason: "sexually explicit" },
	{ value: "hardcore sex", reason: "sexually explicit" },
	{ value: "penis", reason: "explicit anatomy" },
	{ value: "vagina", reason: "explicit anatomy" },
	{ value: "vulva", reason: "explicit anatomy" },
	{ value: "erotic", reason: "sexually explicit" },
	{ value: "nude woman", reason: "explicit anatomy (figure-drawing judgment call, revisitable)" },
	{ value: "nude man", reason: "explicit anatomy (figure-drawing judgment call, revisitable)" },
	{ value: "genitalia", reason: "explicit anatomy" },
	{ value: "fellatio", reason: "explicit act" },
	{ value: "cunnilingus", reason: "explicit act" },
	{ value: "dildo", reason: "explicit object" },
	{ value: "orgy", reason: "explicit act" },
	{ value: "bdsm", reason: "explicit act" },
	{ value: "fetish", reason: "explicit act" },
	{ value: "striptease", reason: "sexually explicit" },
	{ value: "masturbation", reason: "explicit act" },

	// ── Shock and gore ───────────────────────────────────────────────────
	{ value: "gore", reason: "graphic violence" },
	{ value: "dismembered", reason: "graphic violence" },
	{ value: "beheading", reason: "graphic violence" },
	{ value: "mutilated", reason: "graphic violence" },
	{ value: "lynching", reason: "graphic violence" },
	{ value: "snuff", reason: "graphic violence" },
];
