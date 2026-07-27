// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The User Gauntlet's expected-access staircase, asserted against the real resolver.
 *
 * `resolveAccessSync` is pure and synchronous, so the whole staircase resolves here with
 * no browser, no database, no fixture and no Stripe — which makes this the cheapest place
 * to find out whether the gauntlet spec is actually true of the code. The fixture and the
 * e2e spec are both built on this table; if a cell is wrong, they inherit the error.
 *
 * Spec: `40-59 PhD Projects/43 Platforms/Anthers/70-79 Testing & QA/70 - User Gauntlet.md`
 *
 * Note the spec's "Free, following" row has no representation here, and cannot: `AccessContext`
 * carries no follow field, so following is *structurally* incapable of affecting access. That's
 * a stronger guarantee than a test — the equivalent assertion belongs in the e2e walk, where a
 * follow really happens and the feed really changes.
 */
import { describe, expect, it } from "bun:test";
import {
	DOWNLOAD_PRICE,
	EXPECTED_STAIRCASE,
	GAUNTLET_POSTS,
	gauntletPost,
	rungDollars,
	SEED_RUNGS,
} from "@anthers/db/gauntlet";
import { ANTHERS_BADGES, SEED_PRICE } from "@anthers/shared/constants";
import {
	type AccessContext,
	type AccessiblePost,
	type AccessReason,
	resolveAccessSync,
} from "../services/access";

const CREATOR_ID = 900;
const VIEWER_ID = 901;

/** Anthers-Seed levels the staircase walks: no Badge (0), then each Badge's threshold. */
const ANTHERS_LEVELS = [0, ...ANTHERS_BADGES.map((b) => b.threshold)];
/** The top Badge's threshold — the Anthers ladder fully climbed. */
const TOP = ANTHERS_LEVELS[ANTHERS_LEVELS.length - 1];

/**
 * The posts under test are the FIXTURE's own definitions, imported rather than restated.
 * That's deliberate: if this file described the nine posts itself, it could pass green while
 * `make gauntlet-reset` seeded something else — the test would be proving a fiction. Here,
 * every assertion below is about the exact rows the fixture writes.
 */
function accessible(key: string): AccessiblePost {
	const spec = gauntletPost(key);
	return {
		id: spec.publicId,
		creatorId: CREATOR_ID,
		streamEnabled: spec.streamEnabled,
		downloadEnabled: spec.downloadEnabled,
		anthersAccess: spec.anthersAccess,
		seedAccess: spec.seedAccess,
	};
}

const POSTS = Object.fromEntries(GAUNTLET_POSTS.map((p) => [p.key, accessible(p.key)])) as Record<
	string,
	AccessiblePost
>;

type PostKey = string;

/**
 * A viewer context. Both counts are **whole Seeds** — Anthers-Seeds held, and Seeds given
 * to the gauntlet creator this cycle — which is the only thing gate resolution reads.
 */
function ctx(anthersSeeds: number, seedsGiven: number, purchased: number[] = []): AccessContext {
	return {
		userId: VIEWER_ID,
		anthersSeeds,
		seedByCreator: new Map(seedsGiven > 0 ? [[CREATOR_ID, seedsGiven]] : []),
		purchasedPostIds: new Set(purchased),
	};
}

const GATE: AccessReason = "gated";
const PAY: AccessReason = "payment_required";

/**
 * The staircase itself lives in `@anthers/db/gauntlet` (`EXPECTED_STAIRCASE`) — ONE table
 * shared with the e2e walk, for the same reason the posts are shared: neither consumer can
 * quietly drift from what the other proved. Each row is realized as a resolver context here;
 * the `following` field is untestable at this layer (see the header note) and rides along
 * as documentation. The viewer's badge derives from the row's Anthers-Seed count exactly as
 * the app derives it — the support-model linkage, pinned. Resolution reads the Anthers-Seed
 * COUNT directly rather than the Badge it names, so a viewer is never quantised down to the
 * nearest named rung before their access is decided.
 */
const STAIRCASE = EXPECTED_STAIRCASE.map((row) => ({
	state: row.state,
	ctx: ctx(
		row.anthersSeeds,
		row.seedsGiven,
		row.purchased.map((key) => POSTS[key].id),
	),
	reasons: row.reasons as Record<PostKey, AccessReason>,
}));

const POST_KEYS = Object.keys(POSTS) as PostKey[];

describe("User Gauntlet — expected-access staircase", () => {
	for (const { state, ctx: viewer, reasons } of STAIRCASE) {
		for (const key of POST_KEYS) {
			const want = reasons[key];
			it(`${state} → ${key} is ${want}`, () => {
				const got = resolveAccessSync(POSTS[key], viewer);
				expect(got.reason).toBe(want);
				// canAccess must agree with the reason — a gate that reports "gated" but lets
				// you in (or vice versa) is the failure this whole gauntlet exists to catch.
				expect(got.canAccess).toBe(want !== GATE && want !== PAY);
			});
		}
	}

	it("the ladders only ever climb — no state unlocks less than the one before it", () => {
		let previous = new Set<PostKey>();
		for (const { state, ctx: viewer } of STAIRCASE) {
			const unlocked = new Set(
				POST_KEYS.filter((k) => resolveAccessSync(POSTS[k], viewer).canAccess),
			);
			for (const key of previous) {
				expect(unlocked.has(key), `${state} lost access to ${key}`).toBe(true);
			}
			previous = unlocked;
		}
	});

	it("each badge rung unlocks exactly one more post than the rung below", () => {
		// Levels come from the Badge set's own thresholds, so a re-placed Badge re-aims this
		// test rather than silently testing the wrong rung.
		const counts = ANTHERS_LEVELS.map(
			(seeds) =>
				POST_KEYS.filter((k) => resolveAccessSync(POSTS[k], ctx(seeds, 0)).canAccess).length,
		);
		// No Badge sees only G1; each paid rung adds exactly one badge-gated post.
		expect(counts).toEqual([1, 2, 3, 4, 5]);
	});

	it("each Seed rung unlocks exactly one more post than the rung below", () => {
		// Derived from the fixture's rungs, never typed, so retuning SEED_RUNGS needs no
		// matching edit here.
		const counts = [0, ...SEED_RUNGS].map(
			(s) => POST_KEYS.filter((k) => resolveAccessSync(POSTS[k], ctx(TOP, s)).canAccess).length,
		);
		// From Blossom (5 unlocked), each whole Seed adds exactly one Seed-gated post.
		expect(counts).toEqual([5, 6, 7, 8]);
	});

	it("every Seed rung is a whole number of Seeds", () => {
		// The product can't express a fraction of a Seed — the stepper steps whole Seeds and
		// POST /seeds rejects the rest — so a fractional threshold would be testing a state no
		// user can reach. Thresholds count Seeds now, so "whole" is the assertion; the $3 that
		// a Seed costs is a separate fact, checked against the money helper.
		for (const rung of SEED_RUNGS) {
			expect(Number.isInteger(rung)).toBe(true);
			expect(rung).toBeGreaterThan(0);
			expect(rungDollars(rung) % SEED_PRICE).toBe(0);
		}
	});
});

describe("User Gauntlet — the reasons behind the staircase", () => {
	it("G1 is free to everyone; a badge/Seed unlock is 'entitled', not 'free'", () => {
		const free = resolveAccessSync(POSTS.G1, ctx(0, 0));
		expect(free.isFree).toBe(true);
		expect(free.isEntitled).toBe(false);

		// G2 at Root qualifies via a non-baseline row → entitled, and NOT isFree.
		const entitled = resolveAccessSync(POSTS.G2, ctx(1, 0));
		expect(entitled.isFree).toBe(false);
		expect(entitled.isEntitled).toBe(true);
	});

	it("an anonymous viewer is 'login_required' where a logged-in one is 'gated'", () => {
		const anon: AccessContext = {
			userId: null,
			anthersSeeds: 0,
			seedByCreator: new Map(),
			purchasedPostIds: new Set(),
		};
		expect(resolveAccessSync(POSTS.G2, anon).reason).toBe("login_required");
		expect(resolveAccessSync(POSTS.G2, ctx(0, 0)).reason).toBe("gated");
		// ...but a free post is free to anyone, logged in or not.
		expect(resolveAccessSync(POSTS.G1, anon).reason).toBe("free");
	});

	it("G9 quotes its price until bought, then unlocks download permanently", () => {
		const before = resolveAccessSync(POSTS.G9, ctx(0, 0));
		expect(before.requiresPurchase).toBe(true);
		expect(before.price).toBe(DOWNLOAD_PRICE);
		expect(before.downloadEnabled).toBe(true);
		expect(before.streamEnabled).toBe(false);

		// A purchase outranks everything, even back down on the Free plan.
		const after = resolveAccessSync(POSTS.G9, ctx(0, 0, [POSTS.G9.id]));
		expect(after.canAccess).toBe(true);
		expect(after.reason).toBe("purchased");
	});

	it("neither ladder unlocks G9 — the purchase rung can't be reached by climbing", () => {
		const top = resolveAccessSync(POSTS.G9, ctx(TOP, 4));
		expect(top.canAccess).toBe(false);
		expect(top.reason).toBe("payment_required");
	});

	it("the creator always sees their own gated content", () => {
		const owner = resolveAccessSync(POSTS.G5, {
			userId: CREATOR_ID,
			anthersSeeds: 0,
			seedByCreator: new Map(),
			purchasedPostIds: new Set(),
		});
		expect(owner.canAccess).toBe(true);
		expect(owner.reason).toBe("owner");
	});

	it("Seeds given to one creator don't unlock another's gates", () => {
		const elsewhere: AccessContext = {
			userId: VIEWER_ID,
			anthersSeeds: 0,
			seedByCreator: new Map([[CREATOR_ID + 1, 99]]),
			purchasedPostIds: new Set(),
		};
		expect(resolveAccessSync(POSTS.G6, elsewhere).reason).toBe("gated");
	});
});
