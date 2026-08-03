// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The unlock offer a gated post reports — what the viewer still needs, and what to call it.
 *
 * This exists because the UI used to work it out itself, and got it wrong in a way no test
 * could see: it labelled the unlock button with `rankForSeeds(threshold)`, which returns the
 * highest Badge **at or below** a level, so any gate sitting above the top Badge was offered
 * as "Unlock with Blossom" — a Badge that by definition does not clear it — with the price
 * silently missing, because the price came from a Badge-rung lookup that found nothing.
 *
 * Anthers's own Badges sit at 1/2/3/4, so that only misfired above 4 and nobody hit it. But
 * `accessRowSchema` accepts any non-negative threshold and the whole point of the
 * threshold-not-position work is that a gate needn't sit on a Badge — so the tests below
 * deliberately gate at levels no Badge occupies. It is the same failure mode `badgeRank()`
 * had: correct only by accident of a consecutive ladder, and failing toward OVER-claiming.
 */
import { describe, expect, it } from "bun:test";
import { ANTHERS_BADGES, SEED_PRICE } from "@anthers/shared/constants";
import {
	type AccessContext,
	type AccessibleWork,
	resolveAccessSync,
	unlockRoute,
} from "../services/access";

const CREATOR = 700;
const VIEWER = 701;

function ctx(anthersSeeds: number, seedsGiven = 0): AccessContext {
	return {
		userId: VIEWER,
		anthersSeeds,
		seedByCreator: new Map(seedsGiven > 0 ? [[CREATOR, seedsGiven]] : []),
		purchasedWorkIds: new Set(),
	};
}

/** A post gated on the Anthers side at `threshold`, locked everywhere else. */
function anthersGatedAt(threshold: number, price = "0"): AccessibleWork {
	return {
		id: 1,
		creatorId: CREATOR,
		streamEnabled: true,
		downloadEnabled: false,
		anthersAccess: [
			{ threshold: 0, allow: false, price: "0" },
			{ threshold, allow: true, price },
		],
		seedAccess: [{ threshold: 0, allow: false, price: "0" }],
	};
}

/** A post gated on the creator side at `threshold`, locked everywhere else. */
function creatorGatedAt(threshold: number): AccessibleWork {
	return {
		id: 2,
		creatorId: CREATOR,
		streamEnabled: true,
		downloadEnabled: false,
		anthersAccess: [{ threshold: 0, allow: false, price: "0" }],
		seedAccess: [
			{ threshold: 0, allow: false, price: "0" },
			{ threshold, allow: true, price: "0" },
		],
	};
}

const TOP_BADGE = ANTHERS_BADGES[ANTHERS_BADGES.length - 1];

describe("unlock offer — the marginal ask", () => {
	it("reports what the viewer still needs, not what the gate requires", () => {
		// Holding 1, gate at 3 → the ask is TWO more, not three. The distinction is the
		// entire user-facing point: a viewer reads what they must add from here.
		const got = resolveAccessSync(anthersGatedAt(3), ctx(1));
		expect(got.reason).toBe("gated");
		expect(got.unlock?.anthers?.threshold).toBe(3);
		expect(got.unlock?.anthers?.moreNeeded).toBe(2);
	});

	it("prices the threshold, not the gap", () => {
		// You pay for the level you end up holding — $3 × 3 — not for the two you added.
		const got = resolveAccessSync(anthersGatedAt(3), ctx(1));
		expect(got.unlock?.anthers?.price).toBe((SEED_PRICE * 3).toFixed(2));
	});

	it("counts from zero for a viewer holding nothing", () => {
		const got = resolveAccessSync(anthersGatedAt(2), ctx(0));
		expect(got.unlock?.anthers?.moreNeeded).toBe(2);
	});
});

describe("unlock offer — naming the Badge", () => {
	it("names the Badge when the gate sits exactly on one", () => {
		for (const badge of ANTHERS_BADGES) {
			const got = resolveAccessSync(anthersGatedAt(badge.threshold), ctx(0));
			expect(got.unlock?.anthers?.badge, `gate at ${badge.threshold}`).toBe(badge.name);
		}
	});

	it("names NO Badge when the gate sits above every Badge", () => {
		// The regression. `rankForSeeds` would answer with the top Badge here, and the old
		// UI printed it — offering a Badge that cannot clear the gate it sits below.
		const above = TOP_BADGE.threshold + 3;
		const got = resolveAccessSync(anthersGatedAt(above), ctx(0));
		expect(got.unlock?.anthers?.badge).toBeNull();
		// The route is still real and still correctly priced — that's what the old code lost.
		expect(got.unlock?.anthers?.threshold).toBe(above);
		expect(got.unlock?.anthers?.moreNeeded).toBe(above);
		expect(got.unlock?.anthers?.price).toBe((SEED_PRICE * above).toFixed(2));
	});

	it("names no Badge for a gate BETWEEN two Badges", () => {
		// Sparse ladders are legal — a creator's 1/3/5/7 is as valid as Anthers's 1/2/3/4 —
		// so "between" has to work as well as "above". Driven through `unlockRoute` directly
		// against a deliberately gappy set, because `resolveAccessSync` is bound to Anthers's
		// own consecutive Badges and could never exhibit the gap. Same discipline as
		// `packages/shared/src/badges.test.ts`.
		const sparse = [
			{ name: "blorp", threshold: 2 },
			{ name: "zorp", threshold: 6 },
		];
		const gate = (threshold: number) => [
			{ threshold: 0, allow: false, price: "0" },
			{ threshold, allow: true, price: "0" },
		];

		// A gate at 4 sits in the gap: the nearest Badge below is "blorp" at 2, which a
		// 4-Seed gate does not accept. Naming it would be the original bug.
		expect(unlockRoute(gate(4), 0, sparse)?.badge).toBeNull();
		// Above the top Badge, likewise.
		expect(unlockRoute(gate(9), 0, sparse)?.badge).toBeNull();
		// And on a Badge, it still names it.
		expect(unlockRoute(gate(6), 0, sparse)?.badge).toBe("zorp");
		expect(unlockRoute(gate(2), 0, sparse)?.badge).toBe("blorp");
	});

	it("never names a Badge on the creator side", () => {
		// A creator's Badges are their own rows and aren't carried on the post (thresholds
		// are levels, not Badge identities). The creator's NAME is the identity shown there,
		// so inventing a Badge label here would be guessing.
		const got = resolveAccessSync(creatorGatedAt(2), ctx(0));
		expect(got.unlock?.creator?.badge).toBeNull();
		expect(got.unlock?.creator?.threshold).toBe(2);
	});
});

describe("unlock offer — routes that would not actually open the post", () => {
	it("offers no route when the only allowed row carries a price", () => {
		// Reaching the threshold would leave the viewer at "payment_required", not access.
		// Offering it as an unlock route would promise something climbing can't deliver.
		const got = resolveAccessSync(anthersGatedAt(3, "5.00"), ctx(0));
		expect(got.reason).toBe("gated");
		expect(got.unlock?.anthers).toBeNull();
		expect(got.unlock?.creator).toBeNull();
	});

	it("reports each side independently when both gates are open routes", () => {
		const both: AccessibleWork = {
			id: 3,
			creatorId: CREATOR,
			streamEnabled: true,
			downloadEnabled: false,
			anthersAccess: [
				{ threshold: 0, allow: false, price: "0" },
				{ threshold: 4, allow: true, price: "0" },
			],
			seedAccess: [
				{ threshold: 0, allow: false, price: "0" },
				{ threshold: 2, allow: true, price: "0" },
			],
		};
		const got = resolveAccessSync(both, ctx(1, 1));
		expect(got.unlock?.anthers?.moreNeeded).toBe(3); // 4 − 1 held
		expect(got.unlock?.creator?.moreNeeded).toBe(1); // 2 − 1 given
	});

	it("picks the LOWEST allowed rung when a table has several", () => {
		const ladder: AccessibleWork = {
			id: 4,
			creatorId: CREATOR,
			streamEnabled: true,
			downloadEnabled: false,
			anthersAccess: [{ threshold: 0, allow: false, price: "0" }],
			seedAccess: [
				{ threshold: 0, allow: false, price: "0" },
				{ threshold: 5, allow: true, price: "0" },
				{ threshold: 2, allow: true, price: "0" },
				{ threshold: 9, allow: true, price: "0" },
			],
		};
		expect(resolveAccessSync(ladder, ctx(0)).unlock?.creator?.threshold).toBe(2);
	});
});

describe("unlock offer — when it is absent", () => {
	it("is absent for a viewer who already has access", () => {
		const free: AccessibleWork = {
			id: 5,
			creatorId: CREATOR,
			streamEnabled: true,
			downloadEnabled: false,
			anthersAccess: [{ threshold: 0, allow: true, price: "0" }],
			seedAccess: [{ threshold: 0, allow: false, price: "0" }],
		};
		const got = resolveAccessSync(free, ctx(0));
		expect(got.canAccess).toBe(true);
		expect(got.unlock).toBeUndefined();
	});

	it("is absent for a logged-out viewer, whose standing we don't know", () => {
		const anon: AccessContext = {
			userId: null,
			anthersSeeds: 0,
			seedByCreator: new Map(),
			purchasedWorkIds: new Set(),
		};
		const got = resolveAccessSync(anthersGatedAt(2), anon);
		expect(got.reason).toBe("login_required");
		expect(got.unlock).toBeUndefined();
	});

	it("is absent for a purchasable post — ProjectPricing owns that path", () => {
		const buyable: AccessibleWork = {
			id: 6,
			creatorId: CREATOR,
			streamEnabled: false,
			downloadEnabled: true,
			anthersAccess: [{ threshold: 0, allow: true, price: "9.99" }],
			seedAccess: [{ threshold: 0, allow: false, price: "0" }],
		};
		const got = resolveAccessSync(buyable, ctx(0));
		expect(got.reason).toBe("payment_required");
		expect(got.unlock).toBeUndefined();
	});
});
