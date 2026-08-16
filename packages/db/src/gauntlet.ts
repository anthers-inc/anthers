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

import type { SeedAccessRow } from "./schema/content.js";

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
 * The Seed ladder's rungs, in **whole Seeds** — one, two and three.
 *
 * Seeds, not dollars: a gate threshold counts Seeds (migration `0007`), and a Seed is an
 * indivisible $3 unit, so a rung between two whole Seeds isn't expressible in the product
 * and the fixture must not pretend otherwise. Use `rungDollars` where money is meant.
 *
 * 🚨 **DELIBERATELY SPARSE, and that is the point of the 5 and the 7.** A creator may
 * place gates at any Seed levels, and a consecutive ladder (1,2,3) makes a threshold and
 * its list position coincide — which is exactly the accident that let the retired
 * `badgeRank = BADGE_ORDER.indexOf(name)` look correct while mis-resolving any set with
 * gaps, toward over-granting. With $15 and $21 in the ladder, a viewer giving $12 must
 * clear the $9.50 rung and NOT the $15 one, and any implementation that has drifted back
 * to counting positions fails the walk instead of passing it.
 *
 * It grew from three rungs to five on 2026-08-12, when Anthers Gates were retired: G2–G5
 * were Badge rungs, and rather than let the staircase get four steps shorter, the walk
 * now climbs the one gate type that still exists, further and less evenly.
 *
 * 🚨 **Re-denominated from whole Seeds to dollars on 2026-08-16, and one rung deliberately
 * carries CENTS.** The old ladder was `[1, 2, 3, 5, 7]` Seeds; a straight × 3 would have
 * given `[3, 6, 9, 15, 21]`, every rung round, and would have exercised none of the new
 * hazard. Thresholds are floats off `numeric` columns now, so `$9.50` is here to catch a
 * resolver that has quietly started comparing them without rounding to cents — the failure
 * that denies a supporter the exact Badge they paid for. A sparse ladder catches position
 * comparison; a non-round rung catches float comparison. The walk needs both.
 */
export const SEED_RUNGS = [3, 6, 9.5, 15, 21] as const;

/**
 * The Seed counts the staircase actually walks: every rung, plus one count sitting in
 * each GAP between two rungs.
 *
 * ⭐ The gap states are the payoff of a sparse ladder and cannot exist on a consecutive
 * one. At 4 Seeds a viewer is above the rung at 3 and below the rung at 5 — so a resolver
 * comparing list POSITIONS rather than thresholds (the retired `badgeRank = indexOf`
 * shape) opens one post too many, toward over-granting, in exactly this state.
 *
 * Ascending, because the walk asserts the ladder only ever climbs.
 */
export const SEED_WALK: number[] = SEED_RUNGS.flatMap((amount, i) => {
	const next = SEED_RUNGS[i + 1];
	// A gap state must sit strictly between two rungs. The midpoint rather than "one more"
	// because the rungs are dollars now and adjacent ones can be a cent apart — `amount + 1`
	// would step straight over the next rung and assert the opposite of what it means to.
	if (next == null || next - amount <= 0.01) return [amount];
	return [amount, Math.round(((amount + next) / 2) * 100) / 100];
});

/**
 * What a rung costs the viewer.
 *
 * Identity since 2026-08-16 — a rung IS its dollars. Kept as a function rather than
 * inlined at every call site so the conversion has one place to come back to if a rung
 * ever stops being denominated the way a payment is.
 */
export function rungDollars(amount: number): number {
	return amount;
}

/** The purchase rung's list price — what the creator receives; fees are added on top. */
export const DOWNLOAD_PRICE = "9.99";

/** publicIds are stable and sit well clear of `seed.ts`'s 100_000_00x range. */
const PUBLIC_ID_BASE = 900_000_000;

/** The "everyone" baseline denied, then one Seed rung allowed at `threshold` whole Seeds. */
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
	seedAccess: SeedAccessRow[];
	/**
	 * Real playable media to attach, produced by `db:gauntlet:media` — which generates a
	 * short clip with ffmpeg and runs it through the **actual** transcode job, so the post
	 * ends up with genuine HLS segments or a genuine normalized MP3 behind it.
	 *
	 * This is what lets the walk assert *bytes* instead of access reasons. A reason-only
	 * suite is structurally incapable of catching a delivery leak — the exact bug class
	 * where the resolver says "gated" and a working URL sits in the same response — so the
	 * fixture has to be able to actually play something.
	 *
	 * Undefined on the other posts on purpose: media seeding costs an ffmpeg run apiece,
	 * and one gated + one free item already cover both directions of the delivery check.
	 */
	media?: "video" | "audio";
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
		seedAccess: SEED_LOCKED,
		...over,
	};
}

/**
 * The posts, in staircase order: one free, one purchase-only, and a Seed ladder between.
 *
 * 🚨 **G2–G5 used to be Anthers Badge rungs** (Root / Sprout / Petal / Blossom), with the
 * two access tables kept strictly orthogonal because access was the OR across both.
 * **Anthers Gates were retired on 2026-08-12** and those four posts went with them. The
 * staircase did not get shorter: the Seed ladder grew from three rungs to five, and to
 * deliberately uneven ones — see `SEED_RUNGS`.
 *
 * The last rung is reachable by no gate at all, so purchase is the only way in.
 */
export const GAUNTLET_POSTS: GauntletPost[] = [
	post(
		1,
		"G1",
		"free-post",
		"Anyone can read this",
		"always — free to everyone",
		"The free post. It streams for anyone, signed in or not, and it is the gauntlet's comment target. With no gate on it and streaming on, this is what Public Access means.",
		{
			seedAccess: [{ threshold: 0, allow: true, price: "0" }],
			// Free + real video: the case where the bytes MUST arrive, for anyone at all.
			contentType: "video",
			media: "video",
		},
	),
	// The Seed rungs are generated from SEED_RUNGS so the slug, the copy and the access
	// table can never disagree about what opens the post — the drift that let an earlier
	// version advertise "$1 in Seeds" while gating on a different number entirely. Slugs are
	// keyed to the Seed *count*, so retuning SEED_PRICE doesn't orphan the seeded rows, and
	// the count is the THRESHOLD rather than the rung's position, which is what keeps a
	// sparse ladder honest.
	...SEED_RUNGS.map((seeds, i) =>
		post(
			2 + i,
			`G${2 + i}`,
			`seed-${seeds}`,
			`For readers who've given ${seedLabel(seeds)}`,
			`≥ ${seedLabel(seeds)}/month given to this creator`,
			i === 0
				? "The first rung — only what is given to this creator this cycle opens it. Nothing about a viewer's Anthers Badge is consulted anywhere on this ladder."
				: `Rung at ${seedLabel(seeds)}. ${seedLabel(SEED_RUNGS[i - 1])} is not enough; ${seedLabel(seeds)} or more opens it.`,
			{
				seedAccess: seedRung(seeds),
				// Gated + real audio on the SECOND rung: the mirror of G1, where the bytes must
				// NOT arrive until the viewer climbs. Audio because it exercises the second
				// delivery endpoint, which nothing else walks. It sat on the Sprout Badge gate
				// until Anthers Gates were retired; the case it covers is unchanged.
				...(i === 1 ? { contentType: "audio", media: "audio" as const } : {}),
			},
		),
	),
	post(
		2 + SEED_RUNGS.length,
		`G${2 + SEED_RUNGS.length}`,
		"paid-download",
		"A download you buy outright",
		`purchased at $${DOWNLOAD_PRICE}`,
		"No gate opens this. It is download-only and the sole way in is a direct purchase.",
		{
			contentType: "software",
			streamEnabled: false,
			downloadEnabled: true,
			seedAccess: [{ threshold: 0, allow: true, price: DOWNLOAD_PRICE }],
		},
	),
];

/**
 * The posts carrying real playable media, in fixture order. `db:gauntlet:media` seeds
 * exactly these; the e2e walk asserts bytes for exactly these. One list, so a post can't
 * be given media the assertions don't know about (or vice versa).
 */
export const GAUNTLET_MEDIA_POSTS = GAUNTLET_POSTS.filter(
	(p): p is GauntletPost & { media: "video" | "audio" } => p.media != null,
);

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
	/** The viewer's Anthers-Seed count; rank (badge) derives from it (`heldBadgeName`). */
	anthersSupport: number;
	/** Monthly dollars given to the gauntlet creator this cycle. */
	seedsGiven: number;
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

/**
 * A staircase row's reasons, built from the Seeds the viewer has given this creator.
 *
 * Generated rather than written out, because the ladder is **sparse** (`SEED_RUNGS`) and a
 * hand-written positional table is exactly where a sparse ladder gets silently flattened
 * back into a consecutive one. A rung is entitled iff the viewer's Seeds meet its
 * THRESHOLD — which is the property the whole fixture exists to keep honest.
 */
function reasonsFor(seedsGiven: number, purchased: boolean): Record<string, GauntletReason> {
	// G1 is free in every state — the baseline that proves the floor never moves.
	const out: Record<string, GauntletReason> = { G1: FREE };
	SEED_RUNGS.forEach((threshold, i) => {
		out[`G${2 + i}`] = seedsGiven >= threshold ? ENT : GATE;
	});
	out[`G${2 + SEED_RUNGS.length}`] = purchased ? BOUGHT : PAY;
	return out;
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
 *
 * 🚨 **`anthersSeeds` is the same kind of field now, and that is the Anthers Gate
 * retirement made visible.** Four Badge rows sat in this staircase until 2026-08-12,
 * climbing Root → Blossom and unlocking a post each. A Badge opens nothing now, and
 * `AccessContext` no longer carries the count at all — so, exactly like a follow, it is
 * *structurally* incapable of affecting access rather than merely asserted not to. The
 * field rides along here as documentation and for the e2e walk to set.
 */
/**
 * "$3" / "$9.50" — the ladder is dollars, and the cents show only when there are any.
 *
 * Printing `$9.50` as `$9.5` or `$10` would both defeat the rung's purpose: it exists to
 * assert that a non-round threshold survives the round trip, so the label has to be able
 * to show one.
 */
function seedLabel(amount: number): string {
	return `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

/** A staircase row's label for the rungs, e.g. "$6 given". */
function seedState(amount: number): string {
	return `${seedLabel(amount)} given`;
}

export const EXPECTED_STAIRCASE: StaircaseState[] = [
	{
		state: "Free, unfollowed",
		following: false,
		anthersSupport: 0,
		seedsGiven: 0,
		purchased: [],
		reasons: reasonsFor(0, false),
	},
	{
		state: "Free, following",
		following: true,
		anthersSupport: 0,
		seedsGiven: 0,
		purchased: [],
		reasons: reasonsFor(0, false),
	},
	{
		// Blossom — the top Badge — and it unlocks NOTHING. The row exists to say so out
		// loud at the layer a reader looks at, even though the resolver can no longer see
		// the count. It is the cell that would have been four cells before 2026-08-12.
		state: "Blossom, nothing given",
		following: true,
		anthersSupport: 12,
		seedsGiven: 0,
		purchased: [],
		reasons: reasonsFor(0, false),
	},
	...SEED_WALK.map((seeds) => ({
		state: SEED_RUNGS.includes(seeds as (typeof SEED_RUNGS)[number])
			? seedState(seeds)
			: `${seedLabel(seeds)} given — between two rungs`,
		following: true,
		anthersSupport: 0,
		seedsGiven: seeds,
		purchased: [] as string[],
		reasons: reasonsFor(seeds, false),
	})),
	{
		state: "+ purchased",
		following: true,
		anthersSupport: 0,
		seedsGiven: SEED_RUNGS[SEED_RUNGS.length - 1],
		purchased: ["G7"],
		reasons: reasonsFor(SEED_RUNGS[SEED_RUNGS.length - 1], true),
	},
];

/**
 * The creator's advertised gate ladder — the named rungs a visitor sees on the profile.
 * Distinct from the per-post access table above, which is what actually authorizes.
 * Thresholds are **monthly dollars given to this creator** (migration `0041`).
 *
 * An `anthers_badge` half sat beside this until 2026-08-12, advertising Root/Sprout/
 * Petal/Blossom as rungs a creator could gate on. Anthers Gates are retired, so a
 * creator advertises only their own ladder now.
 */
export const GAUNTLET_GATES: Array<{
	gateType: "seed";
	threshold: string;
	label: string;
	description: string;
	sortOrder: number;
}> = SEED_RUNGS.map((seeds, i) => ({
	gateType: "seed" as const,
	// The THRESHOLD, never the position in this list — the fixture must not re-introduce
	// the index/threshold conflation the resolver was freed from, or it would agree with a
	// bug instead of catching it. With a sparse ladder the two genuinely differ.
	threshold: String(seeds),
	label: seedLabel(seeds),
	description: `Readers who've given at least ${seedLabel(seeds)} ($${rungDollars(seeds)}) this cycle.`,
	sortOrder: i,
}));
