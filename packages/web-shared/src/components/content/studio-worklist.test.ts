// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the Studio's Dashboard tells a creator is wrong.
 *
 * Here for the same reason `work-state.test.ts` is: **the failure mode is an empty list
 * rather than an error.** A creator with nothing wrong is supposed to see nothing, so a
 * condition that silently stops matching renders exactly what success renders. Nothing on
 * the screen can tell the two apart, and the items this list is most for — a released Work
 * nobody can open, payout setup that blocks every release — are precisely the ones the
 * creator cannot discover any other way.
 */
import { describe, expect, it } from "bun:test";
import type { Work } from "../../lib/types";
import { buildWorklist, type WorklistKind } from "./studio-worklist";

/** A released, rated, streaming, Public Access Work — nothing wrong with it. */
function work(over: Partial<Work> = {}): Work {
	return {
		id: 1,
		publicId: 100001,
		type: "video",
		title: "Tide",
		visibility: "released",
		maturity: "general",
		streamEnabled: true,
		downloadEnabled: false,
		seedAccess: [{ threshold: 0, allow: true, price: "0" }],
		assets: [],
		transcoding: null,
		...over,
	} as unknown as Work;
}

const build = (works: Work[], payoutsReady: boolean | null = true) =>
	buildWorklist({
		works,
		payoutsReady,
		editUrl: (w) => `/studio/works/${w.publicId}/edit`,
		catalogUrl: "/studio/catalog",
	});

const kinds = (works: Work[], payoutsReady: boolean | null = true): WorklistKind[] =>
	build(works, payoutsReady).map((i) => i.kind);

describe("buildWorklist", () => {
	it("says nothing at all when nothing is wrong", () => {
		// The empty case is the one worth asserting first: this list is absent from the
		// Dashboard when it is empty, so anything spurious here is a permanent false alarm.
		expect(build([work()])).toEqual([]);
		expect(build([])).toEqual([]);
	});

	it("leads with a released Work nobody can open", () => {
		// The server's own `defaultSeedAccess()` produces exactly this, so it is one click
		// away, and a creator can always open their own work — nothing else would tell them.
		const locked = work({ seedAccess: [{ threshold: 0, allow: false, price: "0" }] });
		const items = build([locked], false);
		expect(items[0].kind).toBe("locked");
		// Above payout setup deliberately: this one is already wrong in public.
		expect(items[1].kind).toBe("payouts");
		expect(items[0].href).toBe("/studio/works/100001/edit");
	});

	it("names the Work when there is one and counts them when there are several", () => {
		const locked = (id: number, title: string) =>
			work({ id, publicId: id, title, seedAccess: [{ threshold: 0, allow: false, price: "0" }] });

		expect(build([locked(1, "Tide")])[0].message).toContain("“Tide”");
		const many = build([locked(1, "Tide"), locked(2, "Ebb")]);
		expect(many[0].message).toContain("2 Works");
		// Several means the Catalog, where every card carries its own link. Naming one of
		// them would be picking a Work on the creator's behalf.
		expect(many[0].href).toBe("/studio/catalog");
	});

	it("stays silent about payouts until the answer actually arrives", () => {
		// `null` is "the status request has not come back", and the release control treats it
		// the same way. Inventing a problem from a failed fetch is worse than saying nothing.
		expect(kinds([work()], null)).toEqual([]);
		expect(kinds([work()], true)).toEqual([]);
		expect(kinds([work()], false)).toEqual(["payouts"]);
	});

	it("does not ask about the rating of something already released", () => {
		// The server refuses to release an unrated Work, so a released one that reads as
		// unrated is a state that cannot exist — asking about it would be asking about a bug
		// somewhere else, in the one place a creator can do nothing about it.
		expect(kinds([work({ visibility: "released", maturity: "unrated" })])).toEqual([]);
		expect(kinds([work({ visibility: "private", maturity: "unrated" })])).toEqual(["unrated"]);
		expect(
			kinds([work({ visibility: "private", maturity: null as unknown as undefined })]),
		).toEqual(["unrated"]);
	});

	it("flags a Work with no way to be consumed, before it is released", () => {
		const stuck = work({
			visibility: "private",
			streamEnabled: false,
			downloadEnabled: false,
		});
		expect(kinds([stuck])).toEqual(["no-delivery"]);
	});

	it("reports a failed encode and stays quiet about one still running", () => {
		// 🚨 The distinction this list rests on. A failed encode is the creator's to act on;
		// a running one resolves itself, and a list carrying what resolves itself is a list
		// people learn to skim — which costs the items that needed reading.
		expect(kinds([work({ transcoding: { status: "failed" } as Work["transcoding"] })])).toEqual([
			"encode-failed",
		]);
		expect(kinds([work({ transcoding: { status: "processing" } as Work["transcoding"] })])).toEqual(
			[],
		);
		expect(kinds([work({ transcoding: { status: "pending" } as Work["transcoding"] })])).toEqual(
			[],
		);
		expect(kinds([work({ transcoding: { status: "completed" } as Work["transcoding"] })])).toEqual(
			[],
		);
	});

	it("orders the whole list worst first", () => {
		const all = [
			work({ id: 1, publicId: 1, seedAccess: [{ threshold: 0, allow: false, price: "0" }] }),
			work({ id: 2, publicId: 2, transcoding: { status: "failed" } as Work["transcoding"] }),
			work({ id: 3, publicId: 3, visibility: "private", maturity: "unrated" }),
			work({
				id: 4,
				publicId: 4,
				visibility: "private",
				streamEnabled: false,
				downloadEnabled: false,
			}),
		];
		expect(kinds(all, false)).toEqual([
			"locked",
			"payouts",
			"encode-failed",
			"unrated",
			"no-delivery",
		]);
	});
});
