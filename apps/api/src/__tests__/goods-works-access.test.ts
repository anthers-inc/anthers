// SPDX-License-Identifier: Apache-2.0
/**
 * The goods-works rule at the resolver, where the rule is cheapest to assert.
 *
 * Parker, 2026-10-09: the Public Access rules — how the money works, measuring
 * attention, sign-in restrictions — bind only **streamable** Works. A physical Work
 * delivers by being bought; it has no player, no reader, nothing the attention model
 * can attribute, so the commons machinery must produce none of its postures on it:
 * no free-commons verdict, no signed-out login wall in front of a buyable page, no
 * purchase-forever lockout. What replaces it is stated in the resolver's own comment;
 * these assertions pin the verdict table itself, because the resolver is the single
 * source of truth for who may reach what — a client that improvises its own goods
 * posture is a plausible-looking defect no page would catch.
 *
 * The signed-in digital contrast is the point of several rows: the ONLY thing that
 * differs between a shirt and a free song with the same access rows is `type`, and
 * the two verdicts must differ too.
 */
import { describe, expect, it } from "bun:test";
import { NO_PARENTAL_CONTROLS } from "@anthers/shared/parental-controls";
import { type AccessContext, type AccessibleWork, resolveAccessSync } from "../services/access";

const CREATOR_ID = 900;
const USER_ID = 901;

/** The two shirt Works' actual shape: baseline row open at $0, Badge rungs above. */
const SHIRT_ROWS = [
	{ threshold: 0, allow: true, price: "0" },
	{ threshold: 3, allow: false, price: "0" },
	{ threshold: 6, allow: false, price: "0" },
];

function goodsWork(access = SHIRT_ROWS): AccessibleWork {
	return {
		id: 55,
		creatorId: CREATOR_ID,
		streamEnabled: false,
		downloadEnabled: false,
		access,
		maturity: "general",
		takedownStatus: "active",
		quarantineStatus: "none",
		type: "physical",
	};
}

function ctx(userId: number | null, givenAmount = 0, purchased: number[] = []): AccessContext {
	return {
		userId,
		supportByCreator: new Map(givenAmount > 0 ? [[CREATOR_ID, givenAmount]] : []),
		purchasedWorkIds: new Set(purchased),
		adultAccess: true,
		sharedBy: null,
		parental: NO_PARENTAL_CONTROLS,
	};
}

describe("the goods-works rule", () => {
	it("resolves a buyable page for a signed-out visitor — no login wall, no commons posture", () => {
		const v = resolveAccessSync(goodsWork(), ctx(null));
		expect(v).toMatchObject({
			canAccess: false,
			reason: "payment_required",
			requiresPurchase: true,
			isFree: false,
			price: null, // the store prices the goods; the row's $0 means nothing
		});
	});

	it("resolves the same for a signed-in non-owner", () => {
		const v = resolveAccessSync(goodsWork(), ctx(USER_ID));
		expect(v).toMatchObject({
			canAccess: false,
			reason: "payment_required",
			requiresPurchase: true,
			isFree: false,
		});
	});

	it("keeps a past purchase from being an access verdict — a buyer may buy again", () => {
		const v = resolveAccessSync(goodsWork(), ctx(USER_ID, 0, [55]));
		expect(v).toMatchObject({
			canAccess: false,
			reason: "payment_required",
			requiresPurchase: true,
		});
	});

	it("gates a hard-locked physical Work exactly as a digital one", () => {
		const locked = [{ threshold: 0, allow: false, price: "0" }];
		const out = resolveAccessSync(goodsWork(locked), ctx(USER_ID));
		expect(out).toMatchObject({ canAccess: false, reason: "gated" });
		expect(resolveAccessSync(goodsWork(locked), ctx(null))).toMatchObject({
			canAccess: false,
			reason: "login_required",
		});
	});

	it("gates a badge-gated physical Work and releases entitled supporters to the store panel", () => {
		const badgeGated = [
			{ threshold: 0, allow: false, price: "0" },
			{ threshold: 6, allow: true, price: "0" },
		];
		expect(resolveAccessSync(goodsWork(badgeGated), ctx(USER_ID))).toMatchObject({
			canAccess: false,
			reason: "gated",
		});
		// Qualifying by the creator's ladder still means the goods are bought.
		expect(resolveAccessSync(goodsWork(badgeGated), ctx(USER_ID, 6))).toMatchObject({
			canAccess: false,
			reason: "payment_required",
			requiresPurchase: true,
			isEntitled: true,
		});
	});

	it("leaves the owner alone", () => {
		expect(resolveAccessSync(goodsWork(), ctx(CREATOR_ID))).toMatchObject({
			canAccess: true,
			reason: "owner",
		});
	});
});

describe("the digital contrast — the same rows, a streamable type", () => {
	/** A free song: identical rows to the shirts', minus the goods type. */
	function digitalWork(access = SHIRT_ROWS): AccessibleWork {
		return { ...goodsWork(access), type: "music", streamEnabled: true };
	}

	it("keeps the signed-out login wall AND the commons verdict the goods rule removed", () => {
		const out = resolveAccessSync(digitalWork(), ctx(null));
		expect(out).toMatchObject({ canAccess: false, reason: "login_required", isFree: true });
	});

	it("keeps the free-commons verdict for a signed-in non-owner", () => {
		const out = resolveAccessSync(digitalWork(), ctx(USER_ID));
		expect(out).toMatchObject({ canAccess: true, reason: "free", isFree: true });
	});

	it("keeps the purchase unlock the goods rule skips", () => {
		const out = resolveAccessSync(digitalWork(), ctx(USER_ID, 0, [55]));
		expect(out).toMatchObject({ canAccess: true, reason: "purchased" });
	});
});
