// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The User Gauntlet fixture's canonical shape — pure data, no side effects.
 *
 * This module is the ONE definition of the gauntlet's creator, its nine posts and their
 * access tables. Two consumers share it deliberately:
 *
 *   - `seed-gauntlet.ts` writes these rows into the dev database;
 *   - `apps/api/src/__tests__/access-staircase.test.ts` resolves them against the real
 *     access resolver and asserts the expected staircase.
 *
 * Sharing it is the point: if the fixture and the test each described the posts themselves,
 * the test could pass green while the fixture seeded something else entirely — a fixture
 * that doesn't mean what it says. Here, the test proves *these exact rows*.
 *
 * Keep it free of imports with side effects (no `db`) so importing it never touches Postgres.
 *
 * Spec: `40-59 PhD Projects/43 Platforms/Anthers/70-79 Testing & QA/70 - User Gauntlet.md`
 */

import { BADGE_ORDER, type Badge } from "@anthers/shared/constants";
import type { AnthersAccessRow, SeedAccessRow } from "./schema/content.js";

/** The fixture's creator. The `gauntlet_` prefix marks every row this fixture owns. */
export const GAUNTLET_PREFIX = "gauntlet_";
export const GAUNTLET_CREATOR_USERNAME = `${GAUNTLET_PREFIX}creator`;
export const GAUNTLET_CREATOR_EMAIL = `${GAUNTLET_PREFIX}creator@example.test`;
/** Not security-sensitive — a local fixture account that never exists outside dev. */
export const GAUNTLET_CREATOR_PASSWORD = "gauntletpassword123";

/**
 * The harness's own viewer, for automated walks. The observational pass defaults to the
 * dev account (`DEV_ACCOUNT_USERNAME`), but the e2e spec needs an account whose password
 * it knows and whose state it may freely reset — so it owns both ends of the walk.
 * Created on demand by `seed-gauntlet.ts --ensure-viewer`; email pre-verified because
 * checkout and Seed-giving carry `requireVerified`.
 */
export const GAUNTLET_VIEWER_USERNAME = `${GAUNTLET_PREFIX}viewer`;
export const GAUNTLET_VIEWER_EMAIL = `${GAUNTLET_PREFIX}viewer@example.test`;
/** Not security-sensitive — a local fixture account that never exists outside dev. */
export const GAUNTLET_VIEWER_PASSWORD = "gauntletpassword123";

/** Post slugs share this prefix so the fixture can find and replace exactly its own rows. */
export const GAUNTLET_SLUG_PREFIX = "gauntlet-";

/**
 * The Seed ladder's rungs, in dollars. Chosen to fit Blossom's four included Seeds, so the
 * whole ladder is walkable without buying extra Seeds — one less stubbed payment path in the
 * way of a rung that isn't about payment.
 */
export const SEED_RUNGS = [1, 2, 4] as const;

/** The purchase rung's list price — what the creator receives; fees are added on top. */
export const DOWNLOAD_PRICE = "9.99";

/** publicIds are stable and sit well clear of `seed.ts`'s 100_000_00x range. */
const PUBLIC_ID_BASE = 900_000_000;

/** Every badge rung denied — the neutral Anthers table. */
function lockedAnthers(): AnthersAccessRow[] {
	return BADGE_ORDER.map((tier) => ({ tier, allow: false, price: "0" }));
}

/**
 * Allow exactly one badge rung at no cost. The resolver skips rows the viewer's rank is
 * below, which makes this cumulative: the named rung *and every rung above it*.
 */
function anthersRung(rung: Badge): AnthersAccessRow[] {
	return BADGE_ORDER.map((tier) => ({ tier, allow: tier === rung, price: "0" }));
}

/** The $0 "everyone" baseline denied, then one Seed rung allowed at `threshold` dollars. */
function seedRung(threshold: number): SeedAccessRow[] {
	return [
		{ threshold: 0, allow: false, price: "0" },
		{ threshold, allow: true, price: "0" },
	];
}

/** The neutral Seed table — the baseline row present but denied. */
const SEED_LOCKED: SeedAccessRow[] = [{ threshold: 0, allow: false, price: "0" }];

export interface GauntletPost {
	/** Stable handle used by the spec's staircase and the tests. */
	key: string;
	slug: string;
	title: string;
	body: string;
	/** Plain-English unlock condition — mirrors the spec's "Unlocks when" column. */
	unlocksWhen: string;
	publicId: number;
	contentType: string;
	streamEnabled: boolean;
	downloadEnabled: boolean;
	anthersAccess: AnthersAccessRow[];
	seedAccess: SeedAccessRow[];
}

function post(
	index: number,
	key: string,
	slug: string,
	title: string,
	unlocksWhen: string,
	body: string,
	over: Partial<GauntletPost> = {},
): GauntletPost {
	return {
		key,
		slug: `${GAUNTLET_SLUG_PREFIX}${slug}`,
		title,
		body,
		unlocksWhen,
		publicId: PUBLIC_ID_BASE + index,
		contentType: "text",
		streamEnabled: true,
		downloadEnabled: false,
		anthersAccess: lockedAnthers(),
		seedAccess: SEED_LOCKED,
		...over,
	};
}

/**
 * The nine posts, in staircase order.
 *
 * The two access tables are kept strictly ORTHOGONAL — a badge-gated post has its Seed
 * table fully locked and vice versa — because access is the OR across both. If a post were
 * reachable by either ladder, its rung would stop testing one thing and the staircase would
 * blur. G9 is reachable by neither, so purchase is the only way in.
 */
export const GAUNTLET_POSTS: GauntletPost[] = [
	post(
		1,
		"G1",
		"free-post",
		"Anyone can read this",
		"always — free to everyone",
		"The free post. It streams for anyone, signed in or not, and it is the gauntlet's comment target.",
		{ seedAccess: [{ threshold: 0, allow: true, price: "0" }] },
	),
	post(
		2,
		"G2",
		"root-gate",
		"Behind the Root gate",
		"badge ≥ Root",
		"Gated at the Root rung of the Anthers ladder. Root and every badge above it can read it.",
		{ anthersAccess: anthersRung("root") },
	),
	post(
		3,
		"G3",
		"sprout-gate",
		"Behind the Sprout gate",
		"badge ≥ Sprout",
		"Gated at the Sprout rung. Root cannot reach it; Sprout and above can.",
		{ anthersAccess: anthersRung("sprout") },
	),
	post(
		4,
		"G4",
		"petal-gate",
		"Behind the Petal gate",
		"badge ≥ Petal",
		"Gated at the Petal rung. Sprout cannot reach it; Petal and above can.",
		{ anthersAccess: anthersRung("petal") },
	),
	post(
		5,
		"G5",
		"blossom-gate",
		"Behind the Blossom gate",
		"badge = Blossom",
		"Gated at the top rung. Only a currently-held Blossom badge opens it.",
		{ anthersAccess: anthersRung("blossom") },
	),
	post(
		6,
		"G6",
		"seed-1",
		"For readers who've given $1 in Seeds",
		"≥ $1 in Seeds given to this creator",
		"The first Seed rung. No badge opens this one — only Seeds given to this creator this cycle.",
		{ seedAccess: seedRung(SEED_RUNGS[0]) },
	),
	post(
		7,
		"G7",
		"seed-2",
		"For readers who've given $2 in Seeds",
		"≥ $2 in Seeds given to this creator",
		"The second Seed rung. $1 is not enough; $2 or more opens it.",
		{ seedAccess: seedRung(SEED_RUNGS[1]) },
	),
	post(
		8,
		"G8",
		"seed-4",
		"For readers who've given $4 in Seeds",
		"≥ $4 in Seeds given to this creator",
		"The top Seed rung — exactly Blossom's four included Seeds, so it's reachable without buying extra.",
		{ seedAccess: seedRung(SEED_RUNGS[2]) },
	),
	post(
		9,
		"G9",
		"paid-download",
		"A download you buy outright",
		`purchased at $${DOWNLOAD_PRICE}`,
		"Neither ladder opens this. It is download-only and the sole way in is a direct purchase.",
		{
			contentType: "software",
			streamEnabled: false,
			downloadEnabled: true,
			seedAccess: [{ threshold: 0, allow: true, price: DOWNLOAD_PRICE }],
		},
	),
];

/** Look a gauntlet post up by its staircase key (G1…G9). */
export function gauntletPost(key: string): GauntletPost {
	const found = GAUNTLET_POSTS.find((p) => p.key === key);
	if (!found) throw new Error(`No gauntlet post "${key}"`);
	return found;
}

/**
 * The reason strings `GET /api/subscriptions/access/:postId` can answer for a gauntlet
 * post. A subset of the API's `AccessReason` — restated here (rather than imported) so
 * this module stays dependency-free of the API package; the staircase unit test bridges
 * the two, so a drift would fail there.
 */
export type GauntletReason = "free" | "entitled" | "gated" | "payment_required" | "purchased";

/** One viewer state of the staircase and the reason it expects for every post. */
export interface StaircaseState {
	/** Display name, matching the spec table's row label. */
	state: string;
	/** Whether the viewer follows the creator. MUST NOT affect any reason — that's the point. */
	following: boolean;
	/** The viewer's Anthers-Seed count; rank (badge) derives from it (`rankForSeeds`). */
	anthersSeeds: number;
	/** Dollars of Seeds given to the gauntlet creator this cycle. */
	seedDollars: number;
	/** Keys of posts the viewer has a completed purchase for. */
	purchased: string[];
	/** Expected access reason per post key (G1…G9). */
	reasons: Record<string, GauntletReason>;
}

const FREE = "free" as const;
const ENT = "entitled" as const;
const GATE = "gated" as const;
const PAY = "payment_required" as const;
const BOUGHT = "purchased" as const;

function reasons(
	g2: GauntletReason,
	g3: GauntletReason,
	g4: GauntletReason,
	g5: GauntletReason,
	g6: GauntletReason,
	g7: GauntletReason,
	g8: GauntletReason,
	g9: GauntletReason,
): Record<string, GauntletReason> {
	// G1 is free in every state — the baseline that proves the floor never moves.
	return { G1: FREE, G2: g2, G3: g3, G4: g4, G5: g5, G6: g6, G7: g7, G8: g8, G9: g9 };
}

/**
 * The expected-access staircase — the spec's table, one definition for every consumer.
 * `access-staircase.test.ts` proves it against the pure resolver (no DB, no browser);
 * `user-gauntlet.e2e.ts` walks the real app into each state and asserts the same cells
 * through the live access endpoint. Sharing the table is the same discipline as sharing
 * `GAUNTLET_POSTS`: neither consumer can quietly drift from what the other proved.
 *
 * The two "Free" rows differ only by `following` — identical reasons on purpose, since
 * following must never grant access. The resolver can't even see a follow (no such field
 * in `AccessContext`); the e2e row exists to prove the *app* honors that too.
 */
export const EXPECTED_STAIRCASE: StaircaseState[] = [
	{
		state: "Free, unfollowed",
		following: false,
		anthersSeeds: 0,
		seedDollars: 0,
		purchased: [],
		reasons: reasons(GATE, GATE, GATE, GATE, GATE, GATE, GATE, PAY),
	},
	{
		state: "Free, following",
		following: true,
		anthersSeeds: 0,
		seedDollars: 0,
		purchased: [],
		reasons: reasons(GATE, GATE, GATE, GATE, GATE, GATE, GATE, PAY),
	},
	{
		state: "Root",
		following: true,
		anthersSeeds: 1,
		seedDollars: 0,
		purchased: [],
		reasons: reasons(ENT, GATE, GATE, GATE, GATE, GATE, GATE, PAY),
	},
	{
		state: "Sprout",
		following: true,
		anthersSeeds: 2,
		seedDollars: 0,
		purchased: [],
		reasons: reasons(ENT, ENT, GATE, GATE, GATE, GATE, GATE, PAY),
	},
	{
		state: "Petal",
		following: true,
		anthersSeeds: 3,
		seedDollars: 0,
		purchased: [],
		reasons: reasons(ENT, ENT, ENT, GATE, GATE, GATE, GATE, PAY),
	},
	{
		state: "Blossom",
		following: true,
		anthersSeeds: 4,
		seedDollars: 0,
		purchased: [],
		reasons: reasons(ENT, ENT, ENT, ENT, GATE, GATE, GATE, PAY),
	},
	{
		state: "Blossom + $1 given",
		following: true,
		anthersSeeds: 4,
		seedDollars: 1,
		purchased: [],
		reasons: reasons(ENT, ENT, ENT, ENT, ENT, GATE, GATE, PAY),
	},
	{
		state: "Blossom + $2 given",
		following: true,
		anthersSeeds: 4,
		seedDollars: 2,
		purchased: [],
		reasons: reasons(ENT, ENT, ENT, ENT, ENT, ENT, GATE, PAY),
	},
	{
		state: "Blossom + $4 given",
		following: true,
		anthersSeeds: 4,
		seedDollars: 4,
		purchased: [],
		reasons: reasons(ENT, ENT, ENT, ENT, ENT, ENT, ENT, PAY),
	},
	{
		state: "+ purchased",
		following: true,
		anthersSeeds: 4,
		seedDollars: 4,
		purchased: ["G9"],
		reasons: reasons(ENT, ENT, ENT, ENT, ENT, ENT, ENT, BOUGHT),
	},
];

/**
 * The creator's advertised gate ladder — the named rungs a visitor sees on the profile.
 * Distinct from the per-post access tables above, which are what actually authorize.
 * `seed` thresholds are dollars; `anthers_badge` thresholds are badge RANK (1 = root … 4 = blossom).
 */
export const GAUNTLET_GATES: Array<{
	gateType: "seed" | "anthers_badge";
	threshold: string;
	label: string;
	description: string;
	sortOrder: number;
}> = [
	...BADGE_ORDER.slice(1).map((tier, i) => ({
		gateType: "anthers_badge" as const,
		threshold: String(i + 1),
		label: tier.charAt(0).toUpperCase() + tier.slice(1),
		description: `Anyone currently holding the ${tier} badge (or higher).`,
		sortOrder: i,
	})),
	...SEED_RUNGS.map((dollars, i) => ({
		gateType: "seed" as const,
		threshold: String(dollars),
		label: `$${dollars} in Seeds`,
		description: `Readers who've given at least $${dollars} in Seeds this cycle.`,
		sortOrder: 10 + i,
	})),
];
