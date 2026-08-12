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
import { SEED_PRICE } from "@anthers/shared/constants";
import {
	type AccessContext,
	type AccessibleWork,
	type AccessReason,
	resolveAccessSync,
} from "../services/access";

const CREATOR_ID = 900;
const VIEWER_ID = 901;

/**
 * The posts under test are the FIXTURE's own definitions, imported rather than restated.
 * That's deliberate: if this file described the nine posts itself, it could pass green while
 * `make gauntlet-reset` seeded something else — the test would be proving a fiction. Here,
 * every assertion below is about the exact rows the fixture writes.
 */
function accessible(key: string): AccessibleWork {
	const spec = gauntletPost(key);
	return {
		id: spec.publicId,
		creatorId: CREATOR_ID,
		streamEnabled: spec.streamEnabled,
		downloadEnabled: spec.downloadEnabled,
		seedAccess: spec.seedAccess,
	};
}

const POSTS = Object.fromEntries(GAUNTLET_POSTS.map((p) => [p.key, accessible(p.key)])) as Record<
	string,
	AccessibleWork
>;

type PostKey = string;

/**
 * A viewer context. `seedsGiven` is **whole Seeds given to the gauntlet creator this
 * cycle**, and it is the only viewer fact gate resolution reads besides purchases.
 *
 * The staircase row's `anthersSeeds` is deliberately NOT passed: there is nowhere to put
 * it. Since Anthers Gates were retired the Badge cannot reach resolution at all, which is
 * a stronger statement than any assertion — the same shape as `following`.
 */
function ctx(seedsGiven: number, purchased: number[] = []): AccessContext {
	return {
		userId: VIEWER_ID,
		seedByCreator: new Map(seedsGiven > 0 ? [[CREATOR_ID, seedsGiven]] : []),
		purchasedWorkIds: new Set(purchased),
	};
}

const GATE: AccessReason = "gated";
const PAY: AccessReason = "payment_required";

/**
 * The staircase itself lives in `@anthers/db/gauntlet` (`EXPECTED_STAIRCASE`) — ONE table
 * shared with the e2e walk, for the same reason the posts are shared: neither consumer can
 * quietly drift from what the other proved. Each row is realized as a resolver context here;
 * the `following` and `anthersSeeds` fields are untestable at this layer (see the header
 * note) and ride along as documentation. Resolution reads the viewer's Seeds given to THIS
 * creator as a raw count, never a Badge or a list position, so a sparse ladder resolves
 * correctly and a viewer is never quantised to the nearest named rung.
 */
const STAIRCASE = EXPECTED_STAIRCASE.map((row) => ({
	state: row.state,
	ctx: ctx(
		row.seedsGiven,
		row.purchased.map((key) => POSTS[key].id),
	),
	reasons: row.reasons as Record<PostKey, AccessReason>,
}));

const POST_KEYS = Object.keys(POSTS) as PostKey[];
/** The purchase rung's key — derived, so extending SEED_RUNGS doesn't strand it. */
const BUY = `G${2 + SEED_RUNGS.length}`;

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

	it("each Seed rung unlocks exactly one more post than the rung below", () => {
		// Derived from the fixture's rungs, never typed, so retuning SEED_RUNGS needs no
		// matching edit here. A viewer at 0 Seeds sees only G1; each rung adds exactly one.
		const counts = [0, ...SEED_RUNGS].map(
			(s) => POST_KEYS.filter((k) => resolveAccessSync(POSTS[k], ctx(s)).canAccess).length,
		);
		expect(counts).toEqual([1, ...SEED_RUNGS.map((_, i) => 2 + i)]);
	});

	/**
	 * ⭐ The reason `SEED_RUNGS` is sparse. Between two rungs, a viewer's Seed count and the
	 * rung's POSITION in the ladder diverge — so an implementation that compared positions
	 * (the retired `badgeRank = indexOf` shape) opens one post too many here, toward
	 * over-granting. On a consecutive ladder this state does not exist to test.
	 */
	it("a viewer between two rungs clears the lower and NOT the higher", () => {
		for (let i = 0; i < SEED_RUNGS.length - 1; i++) {
			const lower = SEED_RUNGS[i];
			const higher = SEED_RUNGS[i + 1];
			if (higher - lower < 2) continue; // adjacent rungs have no "between"
			const between = lower + 1;
			expect(resolveAccessSync(POSTS[`G${2 + i}`], ctx(between)).canAccess).toBe(true);
			expect(resolveAccessSync(POSTS[`G${3 + i}`], ctx(between)).canAccess).toBe(false);
		}
	});

	it("the ladder is genuinely sparse — otherwise the test above proves nothing", () => {
		// A guard against someone quietly flattening SEED_RUNGS back to 1,2,3: the case
		// above `continue`s on adjacent rungs, so a consecutive ladder would make it pass
		// vacuously.
		const gaps = SEED_RUNGS.slice(1).map((s, i) => s - SEED_RUNGS[i]);
		expect(gaps.some((g) => g > 1)).toBe(true);
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
	it("G1 is free to everyone; a Seed unlock is 'entitled', not 'free'", () => {
		const free = resolveAccessSync(POSTS.G1, ctx(0));
		expect(free.isFree).toBe(true);
		expect(free.isEntitled).toBe(false);

		// G2 at its rung qualifies via a non-baseline row → entitled, and NOT isFree.
		const entitled = resolveAccessSync(POSTS.G2, ctx(SEED_RUNGS[0]));
		expect(entitled.isFree).toBe(false);
		expect(entitled.isEntitled).toBe(true);
	});

	it("an anonymous viewer is 'login_required' where a logged-in one is 'gated'", () => {
		const anon: AccessContext = {
			userId: null,
			seedByCreator: new Map(),
			purchasedWorkIds: new Set(),
		};
		expect(resolveAccessSync(POSTS.G2, anon).reason).toBe("login_required");
		expect(resolveAccessSync(POSTS.G2, ctx(0)).reason).toBe("gated");
		// ...but a free post is free to anyone, logged in or not.
		expect(resolveAccessSync(POSTS.G1, anon).reason).toBe("free");
	});

	it("the purchase rung quotes its price until bought, then unlocks download permanently", () => {
		const before = resolveAccessSync(POSTS[BUY], ctx(0));
		expect(before.requiresPurchase).toBe(true);
		expect(before.price).toBe(DOWNLOAD_PRICE);
		expect(before.downloadEnabled).toBe(true);
		expect(before.streamEnabled).toBe(false);

		// A purchase outranks everything, even with no Seeds given at all.
		const after = resolveAccessSync(POSTS[BUY], ctx(0, [POSTS[BUY].id]));
		expect(after.canAccess).toBe(true);
		expect(after.reason).toBe("purchased");
	});

	it("the ladder never unlocks the purchase rung — it can't be reached by climbing", () => {
		const top = resolveAccessSync(POSTS[BUY], ctx(SEED_RUNGS[SEED_RUNGS.length - 1]));
		expect(top.canAccess).toBe(false);
		expect(top.reason).toBe("payment_required");
	});

	it("the creator always sees their own gated content", () => {
		const owner = resolveAccessSync(POSTS.G3, {
			userId: CREATOR_ID,
			seedByCreator: new Map(),
			purchasedWorkIds: new Set(),
		});
		expect(owner.canAccess).toBe(true);
		expect(owner.reason).toBe("owner");
	});

	it("Seeds given to one creator don't unlock another's gates", () => {
		const elsewhere: AccessContext = {
			userId: VIEWER_ID,
			seedByCreator: new Map([[CREATOR_ID + 1, 99]]),
			purchasedWorkIds: new Set(),
		};
		expect(resolveAccessSync(POSTS.G2, elsewhere).reason).toBe("gated");
	});
});
