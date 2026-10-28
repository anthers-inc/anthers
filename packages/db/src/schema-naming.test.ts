// SPDX-License-Identifier: Apache-2.0
/**
 * Every table is named as a root or as a member of an approved family.
 *
 * The aim is that `\dt` reads as categories when sorted: a person scanning the table list
 * sees the Work family together, the money tables together, the safety tables together. The
 * scheme that gets there is **family prefixes over root plurals** — a table is either a root
 * (a bare plural noun that names a thing: `works`, `posts`, `purchases`) or a member of a
 * family (`<prefix><thing>`), where the prefix is the singular of the parent entity
 * (`work_`, `post_`, `badge_`) or the singular of the operational domain (`moderation_`,
 * `stripe_`, `pool_`).
 *
 * Two consequences are deliberate. **A family's root sorts after its members**, because
 * `work_pages` precedes `works` in ASCII; the block still reads together, and
 * `works_pages` would read worse than the small ordering oddity costs. And **a member never
 * repeats its parent's plural**, so there is no `work_works` and no `badge_badges`.
 *
 * 🚨 **This exists because the naming pass was a one-time decision with nothing behind it,
 * which is the same decay the role tags suffered.** Sixteen tables were renamed on
 * 2026-10-28 to reach this shape, and the next table added decides by itself whether the
 * shape survives. A rule that lives only in a plan document is a rule about the day somebody
 * wrote the plan; this test is what makes adding a table force the naming question at the
 * moment the person has the context to answer it.
 *
 * ⚠️ **It checks that a name falls in an approved shape, never that the shape is right.** A
 * table filed under a silly family passes. The lists below are the decision, and changing one
 * is a deliberate act with a reason — which is exactly why adding a name to them is how a new
 * family is introduced rather than something the test does on its own.
 *
 * 🚨 **This test lives OUTSIDE `src/schema/`, and must stay there.** `drizzle.config.ts`
 * points drizzle-kit at that directory and it imports every `.ts` in it, so a file calling
 * `describe` at module scope makes `db:generate` fail outright. `schema-role-tags.test.ts` sat
 * inside it for three days in September 2026 and no migration could be generated.
 */
import { describe, expect, it } from "bun:test";
import * as schema from "@anthers/db/schema";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

/**
 * Tables that name a thing outright rather than belonging to a family.
 *
 * A root is a plural noun: `works` holds Works. `shipments` is a root and
 * `shipment_complaints` its member.
 */
const ROOTS: ReadonlySet<string> = new Set([
	"basket_items",
	"card_impressions",
	"charitable_ledger",
	"comments",
	"desktop_auth_requests",
	"disputes",
	"error_events",
	"follows",
	"handle_history",
	"inline_images",
	"issue_reports",
	"notifications",
	"outbound_emails",
	"parental_controls",
	"pending_signups",
	"rate_limits",
	"resource_snapshots",
	"reviews",
	"rights_requests",
	"share_links",
	"stickers",
	"votes",
	"works",
	"posts",
	"projects",
	"badges",
	"purchases",
	"invoices",
	"shipments",
	"users",
]);

/**
 * The families a table may belong to, each with the root it is named for where there is one.
 *
 * An entry with a `root` is a **parent entity** family: the prefix is the singular of a table
 * in `ROOTS`, which is what makes the "a member never repeats its parent's plural" rule
 * checkable. An entry without one is an **operational domain** family — `media_`, `status_`,
 * `traffic_` — whose tables group by the job they do rather than by a row they point at.
 *
 * `creator_` is deliberately here rather than renamed to `payout_`: the prefix already groups
 * those five tables correctly, and renaming a working family for precision is churn without a
 * reader's benefit.
 */
const FAMILIES: Readonly<Record<string, { root?: string; why: string }>> = {
	abuse_: { why: "Illegal-content reporting, a statutory surface with its own clocks" },
	admin_: { why: "Operator accounts and their sessions, kept apart from users on purpose" },
	atproto_: { why: "Rows that hold an AT Protocol identity, token set or handshake" },
	attention_: { why: "Time spent, raw and rolled up" },
	badge_: { root: "badges", why: "Art attribution and charges hanging off a rung" },
	billing_: { why: "Price reductions and the money's non-Stripe half" },
	card_impressions_: { why: "Discovery cards shown, raw and rolled up" },
	creator_: { why: "What settlement owes creators and how it moved" },
	dmca_: { why: "Statutory copyright notices" },
	financial_plan_: { why: "The plan tool's own document and its phases" },
	hosted_: { why: "Identities Anthers issues and the session it writes through" },
	invoice_: { root: "invoices", why: "The per-destination split of one charge" },
	legal_: { why: "Holds that suspend automated destruction" },
	media_: { why: "Scans, quarantine and uploads: the media pipeline's own records" },
	moderation_: { why: "Reports and the operator actions taken on them" },
	noun_: { why: "The icon vendor's spend and blocklist" },
	pool_: { why: "Time Pool distributions and the fund that publishes them" },
	post_: { root: "posts", why: "A Post's edits" },
	project_: { root: "projects", why: "What belongs to a Project and in what order" },
	purchase_: { root: "purchases", why: "The receipt worklist beside a purchase" },
	settlement_: { why: "The closed months settlement reads" },
	shipment_: { root: "shipments", why: "A buyer's complaint against one shipment" },
	signup_: { why: "An unfinished signup and the codes and puzzles that get there" },
	space_: { why: "The per-account space, its backups and its outbox" },
	status_: { why: "Public availability: history, incidents and their updates" },
	stripe_: { why: "The two sides of the Stripe relationship, payer and payee" },
	traffic_: { why: "Page views, raw and rolled up" },
	user_: { root: "users", why: "One person's own rows: sessions, Library, settings" },
	work_: { root: "works", why: "Everything one Work hangs off" },
};

/** Every table the schema declares, as its SQL name. */
function tableNames(): string[] {
	const names: string[] = [];
	for (const value of Object.values(schema)) {
		if (is(value, PgTable)) names.push(getTableName(value));
	}
	return names.sort();
}

const TABLES = tableNames();

/** The complaint for a name, or null when it fits the scheme. */
function namingFault(name: string): string | null {
	if (ROOTS.has(name)) return null;
	for (const [prefix, family] of Object.entries(FAMILIES)) {
		if (!name.startsWith(prefix) || name === prefix) continue;
		if (family.root && name === `${prefix}${family.root}`) {
			return `${name} repeats its parent's plural; write ${prefix}<thing> instead`;
		}
		return null;
	}
	return `${name} is neither a root nor a member of an approved family`;
}

describe("schema naming", () => {
	it("finds the tables it is meant to be checking", () => {
		// Guards the guard: a change that emptied this list would make the assertions below
		// pass by checking nothing, which is what a source scan is most prone to.
		expect(TABLES.length).toBeGreaterThanOrEqual(100);
	});

	it("names every table as a root or an approved family member", () => {
		const faults = TABLES.map((name) => namingFault(name)).filter((f) => f !== null);
		expect(
			faults,
			"Add the table to ROOTS if it names a thing outright, or give it an approved " +
				"family prefix (and add that prefix to FAMILIES with its reason). The rule and " +
				"the full list live in this file's docblock.",
		).toEqual([]);
	});

	it("rejects the shapes the scheme forbids, so a pass above means something", () => {
		expect(namingFault("work_works")).toContain("repeats its parent's plural");
		expect(namingFault("badge_badges")).toContain("repeats its parent's plural");
		expect(namingFault("random_table")).toContain("neither a root nor a member");
		expect(namingFault("user_sessions")).toBeNull();
		expect(namingFault("works")).toBeNull();
	});

	it("keeps the family's root after its members in sort order, not before", () => {
		// Not a property to enforce, but the reason the scheme is shaped this way: a root like
		// `works` follows `work_*`. Recorded as an assertion so a future rename that "fixes"
		// the ordering also has to revisit the reasoning above.
		expect("work_pages" < "works").toBe(true);
	});

	it("carries no root or family that no table uses", () => {
		// A list that only grows is a list nobody prunes: a deleted table leaves its root
		// behind, and the next table then has two plausible homes. Every entry has to be
		// earning its place on a real table.
		const unusedRoots = [...ROOTS].filter((root) => !TABLES.includes(root));
		const unusedFamilies = Object.keys(FAMILIES).filter(
			(prefix) => !TABLES.some((name) => name.startsWith(prefix) && name !== prefix),
		);
		expect({ unusedRoots, unusedFamilies }).toEqual({ unusedRoots: [], unusedFamilies: [] });
	});
});
