// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The unlock offer a gated Work reports — what the viewer still needs, and what to call it.
 *
 * This exists because the UI used to work it out itself, and got it wrong in a way no test
 * could see: it labelled the unlock button with `rankForSeeds(threshold)`, which returns the
 * highest Badge **at or below** a level, so any gate sitting above the top Badge was offered
 * as "Unlock with Blossom" — a Badge that by definition does not clear it — with the price
 * silently missing, because the price came from a Badge-rung lookup that found nothing.
 *
 * Anthers' own Badges sit at 1/2/3/4, so that only misfired above 4 and nobody hit it. But
 * `accessRowSchema` accepts any non-negative threshold and the whole point of the
 * threshold-not-position work is that a gate needn't sit on a Badge — so the tests below
 * deliberately gate at levels no Badge occupies. It is the same failure mode `badgeRank()`
 * had: correct only by accident of a consecutive ladder, and failing toward OVER-claiming.
 *
 * 🚨 **Half of this file used to drive the Anthers side**, gating on the viewer's Badge.
 * Anthers Gates were retired on 2026-08-12 and there is one destination left, so the same
 * assertions run against the creator's ladder. The Badge-naming tests survive on
 * `unlockRoute` directly, which still takes an issuer's Badge set — that is the seam a
 * creator's own Badges will arrive through.
 */
import { describe, expect, it } from "bun:test";
import { SEED_PRICE } from "@anthers/shared/constants";
import {
	type AccessContext,
	type AccessibleWork,
	resolveAccessSync,
	unlockRoute,
} from "../services/access";

const CREATOR = 700;
const VIEWER = 701;

function ctx(seedsGiven = 0): AccessContext {
	return {
		userId: VIEWER,
		seedByCreator: new Map(seedsGiven > 0 ? [[CREATOR, seedsGiven]] : []),
		purchasedWorkIds: new Set(),
	};
}

/** A Work gated at `threshold` Seeds given to its creator, with the baseline locked. */
function gatedAt(threshold: number, price = "0"): AccessibleWork {
	return {
		id: 1,
		creatorId: CREATOR,
		streamEnabled: true,
		downloadEnabled: false,
		seedAccess: [
			{ threshold: 0, allow: false, price: "0" },
			{ threshold, allow: true, price },
		],
		takedownStatus: "active",
	};
}

describe("unlock offer — the marginal ask", () => {
	it("reports what the viewer still needs, not what the gate requires", () => {
		// Holding 1, gate at 3 → the ask is TWO more, not three. The distinction is the
		// entire user-facing point: a viewer reads what they must add from here.
		const got = resolveAccessSync(gatedAt(3), ctx(1));
		expect(got.reason).toBe("gated");
		expect(got.unlock?.creator?.threshold).toBe(3);
		expect(got.unlock?.creator?.moreNeeded).toBe(2);
	});

	it("prices the threshold, not the gap", () => {
		// You pay for the level you end up holding — $3 × 3 — not for the two you added.
		const got = resolveAccessSync(gatedAt(3), ctx(1));
		expect(got.unlock?.creator?.price).toBe((SEED_PRICE * 3).toFixed(2));
	});

	it("counts from zero for a viewer holding nothing", () => {
		expect(resolveAccessSync(gatedAt(2), ctx(0)).unlock?.creator?.moreNeeded).toBe(2);
	});
});

describe("unlock offer — there is no Anthers route any more", () => {
	/**
	 * The behavioural half of the Anthers Gate retirement, and the reason it is asserted
	 * rather than left to the type system: a viewer's Badge must not open a Work, and a
	 * Work must not advertise a Badge as a way in. Holding four Seeds given to Anthers —
	 * the top Badge — changes nothing about a creator-gated Work.
	 */
	it("a Badge opens nothing, and the offer names only the creator", () => {
		const got = resolveAccessSync(gatedAt(2), ctx(0));
		expect(got.canAccess).toBe(false);
		expect(got.reason).toBe("gated");
		expect(Object.keys(got.unlock ?? {})).toEqual(["creator"]);
		expect(got.unlock?.creator?.threshold).toBe(2);
	});

	it("resolution reads Seeds given to THIS creator, and nothing else about the viewer", () => {
		// Seeds given to a different creator do not travel. This is the property that used
		// to be shared with the Anthers table and is now the only one there is.
		const other = new Map([[CREATOR + 1, 99]]);
		const got = resolveAccessSync(gatedAt(2), { ...ctx(0), seedByCreator: other });
		expect(got.canAccess).toBe(false);
		expect(resolveAccessSync(gatedAt(2), ctx(2)).canAccess).toBe(true);
	});
});

describe("unlock offer — naming a Badge", () => {
	it("never names a Badge on the creator side", () => {
		// A creator's Badges are their own rows and aren't carried on the Work (thresholds
		// are levels, not Badge identities). The creator's NAME is the identity shown there,
		// so inventing a Badge label here would be guessing.
		const got = resolveAccessSync(gatedAt(2), ctx(0));
		expect(got.unlock?.creator?.badge).toBeNull();
		expect(got.unlock?.creator?.threshold).toBe(2);
	});

	it("names no Badge for a gate BETWEEN two Badges, or above them all", () => {
		// Sparse ladders are legal — a creator's 1/3/5/7 is as valid as Anthers' 1/2/3/4 —
		// so "between" has to work as well as "above". Driven through `unlockRoute` directly
		// against a deliberately gappy set: this is the seam an issuer's Badges arrive
		// through, and it is the one place the naming rule can still be exercised now that
		// no caller passes a Badge set. Same discipline as `packages/shared/src/badges.test.ts`.
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
});

describe("unlock offer — routes that would not actually open the Work", () => {
	it("offers no route when the only allowed row carries a price", () => {
		// Reaching the threshold would leave the viewer at "payment_required", not access.
		// Offering it as an unlock route would promise something climbing can't deliver.
		const got = resolveAccessSync(gatedAt(3, "5.00"), ctx(0));
		expect(got.reason).toBe("gated");
		expect(got.unlock?.creator).toBeNull();
	});

	it("picks the LOWEST allowed rung when the ladder has several", () => {
		const ladder: AccessibleWork = {
			id: 4,
			creatorId: CREATOR,
			streamEnabled: true,
			downloadEnabled: false,
			seedAccess: [
				{ threshold: 0, allow: false, price: "0" },
				{ threshold: 5, allow: true, price: "0" },
				{ threshold: 2, allow: true, price: "0" },
				{ threshold: 9, allow: true, price: "0" },
			],
			takedownStatus: "active",
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
			seedAccess: [{ threshold: 0, allow: true, price: "0" }],
			takedownStatus: "active",
		};
		const got = resolveAccessSync(free, ctx(0));
		expect(got.canAccess).toBe(true);
		expect(got.isFree).toBe(true);
		expect(got.unlock).toBeUndefined();
	});

	it("is absent for a logged-out viewer, whose standing we don't know", () => {
		const anon: AccessContext = {
			userId: null,
			seedByCreator: new Map(),
			purchasedWorkIds: new Set(),
		};
		const got = resolveAccessSync(gatedAt(2), anon);
		expect(got.reason).toBe("login_required");
		expect(got.unlock).toBeUndefined();
	});

	it("is absent for a purchasable Work — ProjectPricing owns that path", () => {
		const buyable: AccessibleWork = {
			id: 6,
			creatorId: CREATOR,
			streamEnabled: false,
			downloadEnabled: true,
			seedAccess: [{ threshold: 0, allow: true, price: "9.99" }],
			takedownStatus: "active",
		};
		const got = resolveAccessSync(buyable, ctx(0));
		expect(got.reason).toBe("payment_required");
		expect(got.unlock).toBeUndefined();
	});
});
