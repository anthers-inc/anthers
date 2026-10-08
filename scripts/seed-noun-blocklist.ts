// SPDX-License-Identifier: Apache-2.0
/**
 * Seed the Noun Project blocklist — the starter term list, run ONCE against production
 * through the prod-db door:
 *
 *     make prod-db CMD="bun run scripts/seed-noun-blocklist.ts"
 *
 * 🚨 **The terms live in the seed script because they must be reviewed IN the open, in a
 * diff, beside the reasoning that put each there** — an opaque list "in the vault
 * somewhere" is exactly the unownable mechanism the sourcing document warned about. The
 * categories and their reasons are the seed document's
 * (`Anthers-Wiki/Internal Wiki/Transient/Noun Project Blocklist Seed.md`); the script is
 * the mechanical half that makes the rows exist.
 *
 * Idempotent on (kind, value): re-running adds nothing and removes nothing. Removals are
 * admin-door actions, never here — a seed script that deletes would silently unwrap a
 * protection on a later run.
 *
 * ⚠️ **The vendor-side push is NOT this script's job.** After this lands rows locally,
 * one `POST /api/admin/noun-blocklist/sync` from an operator session (or the sync that
 * rides inline on the first admin add) carries them up. Keeping the two separated keeps
 * this script free of vendor credentials, which a prod-db context has no business
 * holding.
 */

import { db } from "@anthers/db/client";
import { adminAccounts, nounBlocklist } from "@anthers/db/schema";
import { eq } from "drizzle-orm";

const TERMS: { value: string; reason: string }[] = [
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

// The admin operator the seed rows name as their adder: the first super admin. The
// Badge Maker's blocklist rows are org safety decisions, and a real admin account id is
// the honest attribution — a seed that invented a row would defeat the "who added this"
// question the column exists to answer. Fails helpfully rather than inventing.
const adminAccountColumns = {
	id: adminAccounts.id,
} as const;
const [admin] = await db
	.select(adminAccountColumns)
	.from(adminAccounts)
	.where(eq(adminAccounts.isSuperAdmin, true))
	.orderBy(adminAccounts.id)
	.limit(1);
if (!admin) {
	console.error(
		"seed-noun-blocklist: no super admin account in this database — create one first " +
			"(the admin-account script), because every entry's addedBy names a real operator.",
	);
	process.exit(2);
}

let added = 0;
for (const { value, reason } of TERMS) {
	const result = await db
		.insert(nounBlocklist)
		.values({ kind: "term", value, reason, addedBy: admin.id })
		.onConflictDoNothing()
		.returning({ id: nounBlocklist.id });
	added += result.length;
}
console.log(
	`seed-noun-blocklist: ${added} of ${TERMS.length} term(s) added (${TERMS.length - added} already present).`,
);
process.exit(0);
