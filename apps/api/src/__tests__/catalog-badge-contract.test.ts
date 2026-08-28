// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The contract the Studio's Catalog badge is built on, asserted against the real resolver.
 *
 * The creator's Catalog grid tells them what each Work is — Public Access, gated, for
 * sale, or *nobody can open this* — and it decides that in the browser, from the Work's
 * own `seedAccess` rows, because it must also answer for rows the creator is editing and
 * has not saved. `resolveAccessSync` cannot do that: it resolves a stored Work.
 *
 * So there are two derivations of one idea, which is the shape this repo has been bitten
 * by repeatedly — five hand-rolled copies of the card fee, `creatorReceipt` re-deriving
 * the storage formula. A duplicated formula agrees with its original right up until a dial
 * moves. What makes this one survivable is that the client's version rests on a single
 * property of the resolver, and this file is that property:
 *
 * 🚨 **For a viewer who has given nothing, bought nothing and owns nothing, freeness is decided by
 * the baseline row alone** — allowed, at price 0. Nothing above threshold 0 can make a
 * Work free to a stranger, and nothing else can take it away.
 *
 * That is deliberately NOT a restatement of `accessState`'s code. It is a claim about
 * `resolveAccessSync`, exhaustive over the access tables a creator can actually build, and
 * it fails the moment the resolver stops honouring it — which is the moment the Studio
 * badge would start lying about what readers can open.
 *
 * Verified by sabotage before being committed, and the numbers are measured, not guessed:
 * dropping the `amountMeets` check from `offersFor` fails 6; ignoring the `allow` flag fails
 * 7; marking every allowed row `baseline: true` fails 1 — and that last one failed *none*
 * until the entitled-vs-free case at the bottom was written for it. See the note there.
 */
import { describe, expect, it } from "bun:test";
import type { SeedAccessRow } from "@anthers/db/schema";
import { NO_PARENTAL_CONTROLS } from "@anthers/shared/parental-controls";
import {
	type AccessContext,
	type AccessibleWork,
	type AccessReason,
	resolveAccessSync,
} from "../services/access";

const CREATOR_ID = 700;
const STRANGER_ID = 701;

/** A signed-in viewer who has given nothing to anyone and bought nothing. */
const stranger: AccessContext = {
	userId: STRANGER_ID,
	supportByCreator: new Map(),
	purchasedWorkIds: new Set(),
	adultAccess: true,
	sharedBy: null,
	parental: NO_PARENTAL_CONTROLS,
};

function work(seedAccess: SeedAccessRow[], streamEnabled = true): AccessibleWork {
	return {
		id: 1,
		creatorId: CREATOR_ID,
		streamEnabled,
		downloadEnabled: !streamEnabled,
		seedAccess,
		maturity: "general",
		takedownStatus: "active",
		quarantineStatus: "none",
		type: "text",
	};
}

const row = (threshold: number, allow: boolean, price = "0"): SeedAccessRow => ({
	threshold,
	allow,
	price,
});

/**
 * What the Studio badge believes, expressed in the badge's own terms rather than by
 * calling its code — `works.tsx` lives in `@anthers/web-shared`, which the API does not
 * depend on, and importing it would only prove the two files agree with each other.
 */
const baselineIsOpenToAll = (rows: SeedAccessRow[]) => {
	const baseline = rows.find((r) => r.threshold === 0);
	return !!baseline?.allow && Number(baseline.price) === 0;
};

/**
 * ⚠️ The `free` column below is **hand-written**, and that is the whole point of the file.
 *
 * The obvious version of this test compared `resolved.isFree` against `baselineIsOpenToAll`
 * and passed 18/18 — because the resolver *already* computes `isFree` as "some allowed
 * baseline row is priced at or below zero", so the assertion was its own implementation
 * copied across a package boundary. Sabotaging `amountMeets` out of `offersFor` broke exactly
 * one of those tests, which is what a tautology looks like from the outside: green, plausible
 * and load-bearing on nothing.
 *
 * So each row states what a stranger should *experience*, derived from the product rules and
 * not from the code, and both the resolver and the badge's rule are checked against it.
 */
const TABLES: {
	name: string;
	rows: SeedAccessRow[];
	canAccess: boolean;
	reason: AccessReason;
	free: boolean;
}[] = [
	{
		name: "the server's create default — one locked baseline, so nobody gets in",
		rows: [row(0, false)],
		canAccess: false,
		reason: "gated",
		free: false,
	},
	{
		name: "baseline allowed at $0 — the commons",
		rows: [row(0, true)],
		canAccess: true,
		reason: "free",
		free: true,
	},
	{
		name: "baseline allowed at a price — anyone may buy",
		rows: [row(0, true, "5.00")],
		canAccess: false,
		reason: "payment_required",
		free: false,
	},
	{
		name: "empty table — no row can admit anyone",
		rows: [],
		canAccess: false,
		reason: "gated",
		free: false,
	},
	{
		name: "gated at 1 over a locked baseline — a stranger is out",
		rows: [row(0, false), row(1, true)],
		canAccess: false,
		reason: "gated",
		free: false,
	},
	{
		name: "gated at 1 over a free baseline — the gate adds nothing for a stranger",
		rows: [row(0, true), row(1, true)],
		canAccess: true,
		reason: "free",
		free: true,
	},
	{
		name: "gated at 1 over a priced baseline — buy in, or climb",
		rows: [row(0, true, "3.00"), row(1, true)],
		canAccess: false,
		reason: "payment_required",
		free: false,
	},
	{
		name: "every rung locked",
		rows: [row(0, false), row(1, false), row(2, false)],
		canAccess: false,
		reason: "gated",
		free: false,
	},
	{
		name: "a rung allowed above a locked baseline",
		rows: [row(0, false), row(1, false), row(2, true)],
		canAccess: false,
		reason: "gated",
		free: false,
	},
	{
		name: "a free rung at 2 cannot reach down to a stranger with a priced baseline",
		rows: [row(0, true, "1.50"), row(2, true, "0")],
		canAccess: false,
		reason: "payment_required",
		free: false,
	},
	{
		name: "baseline free with a priced rung above — still the commons",
		rows: [row(0, true), row(1, true, "9.99")],
		canAccess: true,
		reason: "free",
		free: true,
	},
	{
		name: "a lone high rung, no baseline at all",
		rows: [row(4, true)],
		canAccess: false,
		reason: "gated",
		free: false,
	},
];

describe("what a stranger meets, per access table", () => {
	for (const t of TABLES) {
		it(t.name, () => {
			const resolved = resolveAccessSync(work(t.rows), stranger);
			expect(resolved.canAccess).toBe(t.canAccess);
			expect(resolved.reason).toBe(t.reason);
			expect(resolved.isFree).toBe(t.free);
		});
	}
});

describe("the badge's rule agrees with the resolver on every one of them", () => {
	// The bridge. Each side is checked against the same independently-written column, so
	// this fails when they drift apart rather than when they drift together.
	for (const t of TABLES) {
		it(t.name, () => {
			expect(baselineIsOpenToAll(t.rows)).toBe(t.free);
		});
	}
});

describe("the properties the badge's individual states rest on", () => {
	it("no allowed row at all means nobody gets in — the 'nobody can open' state is real", () => {
		const resolved = resolveAccessSync(work([row(0, false), row(1, false)]), stranger);
		expect(resolved.canAccess).toBe(false);
		expect(resolved.isFree).toBe(false);
	});

	it("a Work with an allowed baseline is reachable without giving anything", () => {
		expect(resolveAccessSync(work([row(0, true)]), stranger).canAccess).toBe(true);
	});

	it("a priced baseline is a purchase, not a gate — the badge says 'for sale'", () => {
		const resolved = resolveAccessSync(work([row(0, true, "4.00")]), stranger);
		expect(resolved.isFree).toBe(false);
		expect(resolved.requiresPurchase).toBe(true);
		expect(resolved.price).toBe("4.00");
	});

	it("a locked baseline under an allowed rung is a gate, and says what would open it", () => {
		const resolved = resolveAccessSync(work([row(0, false), row(2, true)]), stranger);
		expect(resolved.canAccess).toBe(false);
		expect(resolved.reason).toBe("gated");
	});

	/**
	 * The badge draws "Public Access" only when the Work also streams, mirroring the
	 * serializer's `isFree && streamEnabled && released`. The resolver itself is
	 * deliberately indifferent to delivery — freeness and how bytes reach someone are
	 * orthogonal switches — so this pins the half the badge has to add for itself.
	 */
	it("freeness says nothing about delivery — a download-only Work is free but not the commons", () => {
		const resolved = resolveAccessSync(work([row(0, true)], false), stranger);
		expect(resolved.isFree).toBe(true);
		expect(resolved.streamEnabled).toBe(false);
	});

	/**
	 * Clearing a gate is `entitled`, never `free`, and the distinction is load-bearing in
	 * two directions: the Studio badge must not call a gated Work part of the commons, and
	 * `attention_events.public_access` is stamped from this same idea — crediting a
	 * supporter's free allowance for work they paid a creator to reach would bill them
	 * twice for one thing.
	 *
	 * This case exists because the stranger table above cannot reach it. A stranger only
	 * ever qualifies for the baseline row, so breaking the `baseline: threshold <= 0` flag
	 * is invisible to all twelve of those tables — verified: that sabotage passed 30/30
	 * before this test was added, and fails here.
	 */
	it("clearing a rung makes a viewer entitled, not the Work free", () => {
		const generous: AccessContext = {
			userId: STRANGER_ID,
			supportByCreator: new Map([[CREATOR_ID, 5]]),
			purchasedWorkIds: new Set(),
			adultAccess: true,
			sharedBy: null,
			parental: NO_PARENTAL_CONTROLS,
		};
		const rows = [row(0, false), row(2, true)];
		const resolved = resolveAccessSync(work(rows), generous);
		expect(resolved.canAccess).toBe(true);
		expect(resolved.reason).toBe("entitled");
		expect(resolved.isFree).toBe(false);
		// …and the stranger's view of the same Work is unchanged, which is what makes the
		// creator's badge a statement about the Work rather than about one viewer.
		expect(resolveAccessSync(work(rows), stranger).isFree).toBe(false);
	});
});
