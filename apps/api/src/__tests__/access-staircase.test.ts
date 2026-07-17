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
import type { AnthersAccessRow, SeedAccessRow } from "@anthers/db/schema";
import type { Badge } from "@anthers/shared/constants";
import {
	type AccessContext,
	type AccessiblePost,
	type AccessReason,
	resolveAccessSync,
	TIER_ORDER,
} from "../services/access";

const CREATOR_ID = 900;
const VIEWER_ID = 901;

/** Every badge rung denied — the neutral Anthers table. */
function lockedAnthers(): AnthersAccessRow[] {
	return TIER_ORDER.map((tier) => ({ tier, allow: false, price: "0" }));
}

/** Allow exactly one badge rung. The resolver makes it cumulative: that rung *and above*. */
function anthersRung(rung: Badge): AnthersAccessRow[] {
	return TIER_ORDER.map((tier) => ({ tier, allow: tier === rung, price: "0" }));
}

/** The $0 "everyone" baseline denied, then one Seed rung allowed at `threshold` dollars. */
function seedRung(threshold: number): SeedAccessRow[] {
	return [
		{ threshold: 0, allow: false, price: "0" },
		{ threshold, allow: true, price: "0" },
	];
}

const SEED_LOCKED: SeedAccessRow[] = [{ threshold: 0, allow: false, price: "0" }];

function post(id: number, over: Partial<AccessiblePost>): AccessiblePost {
	return {
		id,
		creatorId: CREATOR_ID,
		streamEnabled: true,
		downloadEnabled: false,
		anthersAccess: lockedAnthers(),
		seedAccess: SEED_LOCKED,
		...over,
	};
}

/**
 * The fixture's nine posts. The two tables are kept strictly orthogonal — a badge-gated post
 * has its Seed table fully locked and vice versa — so each rung tests exactly one thing.
 */
const POSTS = {
	// Free to everyone: the $0 baseline row allowed at $0. The comment target.
	G1: post(1, { seedAccess: [{ threshold: 0, allow: true, price: "0" }] }),
	G2: post(2, { anthersAccess: anthersRung("root") }),
	G3: post(3, { anthersAccess: anthersRung("sprout") }),
	G4: post(4, { anthersAccess: anthersRung("petal") }),
	G5: post(5, { anthersAccess: anthersRung("blossom") }),
	G6: post(6, { seedAccess: seedRung(1) }),
	G7: post(7, { seedAccess: seedRung(2) }),
	G8: post(8, { seedAccess: seedRung(4) }),
	// Purchasable by anyone at $9.99, unlocked by neither ladder. Download-only.
	G9: post(9, {
		seedAccess: [{ threshold: 0, allow: true, price: "9.99" }],
		streamEnabled: false,
		downloadEnabled: true,
	}),
} satisfies Record<string, AccessiblePost>;

type PostKey = keyof typeof POSTS;

function ctx(badge: Badge, seeds: number, purchased: number[] = []): AccessContext {
	return {
		userId: VIEWER_ID,
		badge,
		seedByCreator: new Map(seeds > 0 ? [[CREATOR_ID, seeds]] : []),
		purchasedPostIds: new Set(purchased),
	};
}

const FREE: AccessReason = "free";
const ENT: AccessReason = "entitled";
const GATE: AccessReason = "gated";
const PAY: AccessReason = "payment_required";
const BOUGHT: AccessReason = "purchased";

/** The staircase, exactly as the spec's table reads. Each row: one viewer state, nine reasons. */
const STAIRCASE: Array<{
	state: string;
	ctx: AccessContext;
	reasons: Record<PostKey, AccessReason>;
}> = [
	{
		state: "Free",
		ctx: ctx("free", 0),
		reasons: {
			G1: FREE,
			G2: GATE,
			G3: GATE,
			G4: GATE,
			G5: GATE,
			G6: GATE,
			G7: GATE,
			G8: GATE,
			G9: PAY,
		},
	},
	{
		state: "Root",
		ctx: ctx("root", 0),
		reasons: {
			G1: FREE,
			G2: ENT,
			G3: GATE,
			G4: GATE,
			G5: GATE,
			G6: GATE,
			G7: GATE,
			G8: GATE,
			G9: PAY,
		},
	},
	{
		state: "Sprout",
		ctx: ctx("sprout", 0),
		reasons: {
			G1: FREE,
			G2: ENT,
			G3: ENT,
			G4: GATE,
			G5: GATE,
			G6: GATE,
			G7: GATE,
			G8: GATE,
			G9: PAY,
		},
	},
	{
		state: "Petal",
		ctx: ctx("petal", 0),
		reasons: {
			G1: FREE,
			G2: ENT,
			G3: ENT,
			G4: ENT,
			G5: GATE,
			G6: GATE,
			G7: GATE,
			G8: GATE,
			G9: PAY,
		},
	},
	{
		state: "Blossom",
		ctx: ctx("blossom", 0),
		reasons: {
			G1: FREE,
			G2: ENT,
			G3: ENT,
			G4: ENT,
			G5: ENT,
			G6: GATE,
			G7: GATE,
			G8: GATE,
			G9: PAY,
		},
	},
	{
		state: "Blossom + $1 given",
		ctx: ctx("blossom", 1),
		reasons: { G1: FREE, G2: ENT, G3: ENT, G4: ENT, G5: ENT, G6: ENT, G7: GATE, G8: GATE, G9: PAY },
	},
	{
		state: "Blossom + $2 given",
		ctx: ctx("blossom", 2),
		reasons: { G1: FREE, G2: ENT, G3: ENT, G4: ENT, G5: ENT, G6: ENT, G7: ENT, G8: GATE, G9: PAY },
	},
	{
		state: "Blossom + $4 given",
		ctx: ctx("blossom", 4),
		reasons: { G1: FREE, G2: ENT, G3: ENT, G4: ENT, G5: ENT, G6: ENT, G7: ENT, G8: ENT, G9: PAY },
	},
	{
		state: "Blossom + $4 given + purchased",
		ctx: ctx("blossom", 4, [POSTS.G9.id]),
		reasons: {
			G1: FREE,
			G2: ENT,
			G3: ENT,
			G4: ENT,
			G5: ENT,
			G6: ENT,
			G7: ENT,
			G8: ENT,
			G9: BOUGHT,
		},
	},
];

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
		const counts = (["free", "root", "sprout", "petal", "blossom"] as Badge[]).map(
			(b) => POST_KEYS.filter((k) => resolveAccessSync(POSTS[k], ctx(b, 0)).canAccess).length,
		);
		// Free sees only G1; each paid rung adds exactly one badge-gated post.
		expect(counts).toEqual([1, 2, 3, 4, 5]);
	});

	it("each Seed rung unlocks exactly one more post than the rung below", () => {
		const counts = [0, 1, 2, 4].map(
			(s) =>
				POST_KEYS.filter((k) => resolveAccessSync(POSTS[k], ctx("blossom", s)).canAccess).length,
		);
		// From Blossom (5 unlocked), $1/$2/$4 each add exactly one Seed-gated post.
		expect(counts).toEqual([5, 6, 7, 8]);
	});
});

describe("User Gauntlet — the reasons behind the staircase", () => {
	it("G1 is free to everyone; a badge/Seed unlock is 'entitled', not 'free'", () => {
		const free = resolveAccessSync(POSTS.G1, ctx("free", 0));
		expect(free.isFree).toBe(true);
		expect(free.isEntitled).toBe(false);

		// G2 at Root qualifies via a non-baseline row → entitled, and NOT isFree.
		const entitled = resolveAccessSync(POSTS.G2, ctx("root", 0));
		expect(entitled.isFree).toBe(false);
		expect(entitled.isEntitled).toBe(true);
	});

	it("an anonymous viewer is 'login_required' where a logged-in one is 'gated'", () => {
		const anon: AccessContext = {
			userId: null,
			badge: "free",
			seedByCreator: new Map(),
			purchasedPostIds: new Set(),
		};
		expect(resolveAccessSync(POSTS.G2, anon).reason).toBe("login_required");
		expect(resolveAccessSync(POSTS.G2, ctx("free", 0)).reason).toBe("gated");
		// ...but a free post is free to anyone, logged in or not.
		expect(resolveAccessSync(POSTS.G1, anon).reason).toBe("free");
	});

	it("G9 quotes its price until bought, then unlocks download permanently", () => {
		const before = resolveAccessSync(POSTS.G9, ctx("free", 0));
		expect(before.requiresPurchase).toBe(true);
		expect(before.price).toBe("9.99");
		expect(before.downloadEnabled).toBe(true);
		expect(before.streamEnabled).toBe(false);

		// A purchase outranks everything, even back down on the Free plan.
		const after = resolveAccessSync(POSTS.G9, ctx("free", 0, [POSTS.G9.id]));
		expect(after.canAccess).toBe(true);
		expect(after.reason).toBe("purchased");
	});

	it("neither ladder unlocks G9 — the purchase rung can't be reached by climbing", () => {
		const top = resolveAccessSync(POSTS.G9, ctx("blossom", 4));
		expect(top.canAccess).toBe(false);
		expect(top.reason).toBe("payment_required");
	});

	it("the creator always sees their own gated content", () => {
		const owner = resolveAccessSync(POSTS.G5, {
			userId: CREATOR_ID,
			badge: "free",
			seedByCreator: new Map(),
			purchasedPostIds: new Set(),
		});
		expect(owner.canAccess).toBe(true);
		expect(owner.reason).toBe("owner");
	});

	it("Seeds given to one creator don't unlock another's gates", () => {
		const elsewhere: AccessContext = {
			userId: VIEWER_ID,
			badge: "free",
			seedByCreator: new Map([[CREATOR_ID + 1, 99]]),
			purchasedPostIds: new Set(),
		};
		expect(resolveAccessSync(POSTS.G6, elsewhere).reason).toBe("gated");
	});
});
