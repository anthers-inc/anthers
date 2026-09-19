// SPDX-License-Identifier: Apache-2.0
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
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import type { Work } from "../../lib/types";
import { buildWorklist, type WorklistKind } from "./studio-worklist";

/** A released, rated, streaming, Public Access Work — nothing wrong with it. */
function work(over: Partial<Work> = {}): Work {
	return {
		id: 1,
		publicId: 100001,
		type: "video",
		sourceKey: "creators/1/video/tide.mp4",
		title: "Tide",
		visibility: "released",
		maturity: "general",
		maturityRows: rowsRatedAs("general"),
		streamEnabled: true,
		downloadEnabled: false,
		seedAccess: [{ threshold: 0, allow: true, price: "0" }],
		assets: [],
		transcoding: null,
		...over,
	} as unknown as Work;
}

const build = (
	works: Work[],
	payoutsReady: boolean | null = true,
	uploading: ReadonlySet<number> = new Set(),
) =>
	buildWorklist({
		works,
		payoutsReady,
		editUrl: (w) => `/studio/works/${w.publicId}/edit`,
		catalogUrl: "/studio/catalog",
		uploading,
	});

const kinds = (
	works: Work[],
	payoutsReady: boolean | null = true,
	uploading: ReadonlySet<number> = new Set(),
): WorklistKind[] => build(works, payoutsReady, uploading).map((i) => i.kind);

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

	it("asks about a rating with any row unanswered, and only before release", () => {
		// Asked of the rows rather than the rating: a Work rated before the matrix existed holds a
		// rating with no rows behind it, and the server refuses to release it all the same.
		const { language: _left, ...fiveRows } = rowsRatedAs("general");
		expect(kinds([work({ visibility: "private", maturity: "unrated", maturityRows: {} })])).toEqual(
			["unrated"],
		);
		expect(kinds([work({ visibility: "private", maturityRows: {} })])).toEqual(["unrated"]);
		expect(kinds([work({ visibility: "private", maturityRows: fiveRows })])).toEqual(["unrated"]);
		expect(kinds([work({ visibility: "private", maturityRows: undefined })])).toEqual(["unrated"]);
	});

	it("tells the creator of a released Work with unanswered rows who is missing it", () => {
		// Only a Work released before the matrix existed can be here, and a reader hiding any kind
		// of content never meets it, because an unanswered row counts as present.
		const items = build([work({ visibility: "released", maturityRows: {} })]);
		expect(items.map((i) => i.kind)).toEqual(["unanswered-rows"]);
		expect(items[0].message).toContain("readers who hide a kind of content");
		expect(kinds([work({ visibility: "released" })])).toEqual([]);
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

	it("flags a Work whose file never arrived, and not one whose file is on its way", () => {
		// A Work is made the moment its file is picked, so no file is an ordinary moment in its
		// life while the upload runs. It is only wrong once nothing is uploading it any more.
		const empty = work({ id: 9, visibility: "private", sourceKey: "" });
		expect(kinds([empty])).toEqual(["no-file"]);
		expect(kinds([empty], true, new Set([9]))).toEqual([]);
		// A kind that is not its file has nothing to wait for.
		expect(kinds([work({ visibility: "private", type: "game", sourceKey: "" })])).toEqual([]);
	});

	it("orders the whole list worst first", () => {
		const all = [
			work({ id: 1, publicId: 1, seedAccess: [{ threshold: 0, allow: false, price: "0" }] }),
			work({ id: 2, publicId: 2, transcoding: { status: "failed" } as Work["transcoding"] }),
			work({ id: 5, publicId: 5, visibility: "private", sourceKey: "" }),
			work({ id: 3, publicId: 3, visibility: "private", maturity: "unrated", maturityRows: {} }),
			work({ id: 6, publicId: 6, maturityRows: {} }),
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
			"no-file",
			"unrated",
			"unanswered-rows",
			"no-delivery",
		]);
	});
});
