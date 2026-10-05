// SPDX-License-Identifier: Apache-2.0
/**
 * The User Gauntlet walk's own instance of the fixture — pure data, no side effects.
 *
 * `gauntlet.ts` is the ONE definition of the fixture, and two projects in
 * `playwright.config.ts` both run scripts that reset it: the `authed` specs depend on
 * the fixture `setup` leaves behind, while the gauntlet walk's `beforeAll` resets the
 * very same fixture, which is what forced `gauntlet` to wait for `authed` and serialized
 * the two projects. This module gives the walk its OWN instance — instance B — derived
 * from that one definition so the two cannot drift, and instance A (instance A's rows,
 * `gauntlet_*` accounts, `gauntlet-` slugs) stays untouched by anything the walk does.
 *
 * Derivation, not duplication: every post below spreads `GAUNTLET_POSTS` and changes
 * only its slug and its publicId, so a walk post means exactly what its instance-A twin
 * means — same title, body, access table, media kind. Only the identity of the rows
 * differs, which is the property that makes the race structurally impossible: neither
 * project's reset can touch the other's rows.
 *
 * 🚨 **The walk's slug prefix must NOT nest under `gauntlet-`.** Instance A's
 * `deleteGauntletPosts` matches its posts by `like(posts.slug, 'gauntlet-%')`, so a
 * `gauntlet-walk-…` prefix would sit inside that pattern and let A's reset sweep B's
 * posts away with its own. `walk-gauntlet-` sits outside the pattern: the two instances'
 * slug namespaces are disjoint, so every fixture helper — including the ones that match
 * on a Work's slug alone, with no creator scoping (`db:gauntlet:state --purchase`) — can
 * only ever land on one generation. publicIds keep the same discipline: A writes
 * `900_000_000 + index` (and the announcement posts `+1_000` on top), B writes the same
 * shape from a base far enough up that no id ever collides.
 *
 * 🔒 **The staircase is NOT part of the instance.** `EXPECTED_STAIRCASE`, `BADGE_RUNGS`,
 * `BADGE_WALK` and `DOWNLOAD_PRICE` stay in `gauntlet.ts` and stay shared — they are the
 * published access table the walk asserts and the unit test proves, and forking them
 * would let the browser walk assert a different staircase than the one proven against
 * the resolver. Only the fixture's ROWS fork; the meaning does not. They are re-exported
 * below for a consumer that wants one import site, not re-derived.
 *
 * Keep it free of imports with side effects (no `db`) so importing it never touches
 * Postgres, exactly as `gauntlet.ts` is.
 *
 * Spec: the Anthers wiki, `70-79 Testing & QA/70 - User Gauntlet.md`
 */

import type { GauntletPost } from "./gauntlet.js";
import {
	GAUNTLET_BADGES,
	GAUNTLET_POSTS,
	GAUNTLET_SLUG_PREFIX,
	PUBLIC_ID_BASE,
} from "./gauntlet.js";

export type { GauntletPost, GauntletReason, StaircaseState } from "./gauntlet.js";
export { BADGE_RUNGS, BADGE_WALK, DOWNLOAD_PRICE, EXPECTED_STAIRCASE } from "./gauntlet.js";

/**
 * Instance B's account names — the walk's own creator and user.
 *
 * 🚨 **Handle-safe on purpose, and the shape costs a small naming departure from instance
 * A.** An account's handle is a domain label a reference PDS caps at 18 characters
 * (`MAX_HANDLE_NAME`), and it refuses underscores outright — so `gauntlet_walk_creator`
 * cannot be a handle name, and `localHandleName`'s fallback for a name no handle can
 * carry is a GENERATED name, which would make the walk's fixture non-idempotent: every
 * reset would mint a fresh creator under a new random handle instead of finding its own.
 * `walk-creator` and `walk-walker` are short, dashed and stable, so the seeder resolves
 * them through `localHandleName` unchanged and every lookup — the seeder's on re-run,
 * the state hopper's, the spec's `gauntletHandle` — lands on the same account every
 * time. The `walk-` prefix carries the instance-B mark the underscore spelling would
 * have; nothing in the model reads the account name, so nothing else is lost.
 */
export const WALK_CREATOR_USERNAME = "walk-creator";
export const WALK_CREATOR_EMAIL = "walk-creator@example.test";

/**
 * Instance B's user, created on demand by `seed-gauntlet.ts --instance walk
 * --ensure-walker` — the walk's own harness account, reset freely without ever touching
 * instance A's `gauntlet_walker`. Signing in is the emailed code, as everywhere.
 */
export const WALK_WALKER_USERNAME = "walk-walker";
export const WALK_WALKER_EMAIL = "walk-walker@example.test";

/**
 * Instance B's slug prefix, sitting OUTSIDE instance A's `like` delete pattern — see the
 * module docblock for why it must not be `gauntlet-walk-…`.
 */
export const WALK_SLUG_PREFIX = "walk-gauntlet-";

/**
 * Instance B's publicId base. A starts at 900_000_000; B starts far enough above that a
 * Work or post publicId can never collide between the instances, even though the seeder
 * writes both.
 */
const WALK_PUBLIC_ID_BASE = 900_500_000;

/** The walk's own posts: instance A's posts with the walk's identity. */
export const WALK_POSTS: GauntletPost[] = GAUNTLET_POSTS.map((post) => ({
	...post,
	// The instance-A slug WITHOUT its prefix, re-prefixed — the staircase part of the slug
	// ("free-post", "seed-9.5", …) stays in lockstep with A's by construction.
	slug: `${WALK_SLUG_PREFIX}${post.slug.slice(GAUNTLET_SLUG_PREFIX.length)}`,
	publicId: WALK_PUBLIC_ID_BASE + (post.publicId - PUBLIC_ID_BASE),
}));

/**
 * The walk's posts carrying real playable media, in fixture order — the same filter
 * instance A's media list applies, over the walk's own posts.
 */
export const WALK_MEDIA_POSTS = WALK_POSTS.filter(
	(p): p is GauntletPost & { media: "video" | "audio" } => p.media != null,
);

/**
 * The walk's advertised Badge ladder. The thresholds are the SHARED staircase's (`BADGE_RUNGS`,
 * via `gauntlet.ts`), so the ladder rows are identical in shape to instance A's — only the
 * ladder's owner (the walk creator) differs. `resetGates` rebuilds exactly this list.
 */
export const WALK_BADGES = GAUNTLET_BADGES.map((badge) => ({ ...badge }));

/** Look a gauntlet walk post up by its staircase key (G1…G7), as `gauntletPost` does for A. */
export function walkPost(key: string): GauntletPost {
	const found = WALK_POSTS.find((p) => p.key === key);
	if (!found) throw new Error(`No gauntlet walk post "${key}"`);
	return found;
}
