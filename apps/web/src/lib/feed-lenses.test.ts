// SPDX-License-Identifier: Apache-2.0
/**
 * The tabs' lens corpus in pure form: the feed's releases become the items the Music
 * Player, Channel Guide and Bookshelf lenses draw on, and the translation never invents
 * a payload the feed did not send.
 *
 * The one seam worth pinning is the delivery address. A listened Work's queue entry is
 * built from `/api/content/works/:id/audio` and a video's guide player from
 * `/api/content/works/:id/hls/master.m3u8` — endpoints that re-resolve access on every
 * request — because the feed ships no transcode URL. If this ever starts carrying a
 * signed URL or a `sourceKey`, a lens queue or a guide player would outlive the
 * permission to use it.
 */
import { describe, expect, test } from "bun:test";
import { type AccessResult, isAccessResult, type WorkRelease } from "@anthers/web-shared/types";
import { type FeedLensEntry, feedLensItems } from "./feed-lenses";

function access(overrides: Partial<AccessResult> = {}): AccessResult {
	return {
		canAccess: true,
		reason: "free",
		isFree: true,
		requiresPurchase: false,
		price: null,
		isEntitled: false,
		streamEnabled: true,
		downloadEnabled: true,
		...overrides,
	};
}

function release(id: number, musicCount = 4): WorkRelease {
	return {
		id: id + 100,
		slug: `record-${id}`,
		title: `Record ${id}`,
		coverImage: null,
		creatorId: 10,
		creatorHandle: "maker",
		creatorDisplayName: "The Maker",
		musicCount,
		audioCount: 0,
	};
}

function entry(overrides: Partial<FeedLensEntry> = {}): FeedLensEntry {
	return {
		kind: "release",
		id: 7,
		type: "music",
		access: access(),
		creator: { handle: "maker", displayName: "The Maker", avatar: "maker.jpg" },
		...overrides,
	};
}

describe("feedLensItems", () => {
	test("drops posts: a lens organizes Works, and a post is not one", () => {
		const items = feedLensItems([{ ...entry({ id: 1 }), kind: "post" }, entry({ id: 2 })]);

		expect(items).toHaveLength(1);
		expect(items[0]?.work?.id).toBe(2);
	});

	test("flattens the creator onto the Work and keeps its release memberships", () => {
		const items = feedLensItems([entry({ releases: [release(7)] })]);
		const work = items[0]?.work;

		expect(work?.creatorHandle).toBe("maker");
		expect(work?.creatorDisplayName).toBe("The Maker");
		expect(work?.creatorAvatar).toBe("maker.jpg");
		expect(work?.releases?.map((r) => r.id)).toEqual([107]);
	});

	test("builds a listened Work's queue address from the delivery endpoint", () => {
		const items = feedLensItems([entry({ id: 7, type: "music" })]);

		expect(items[0]?.work?.transcoding?.outputFileUrl).toMatch(/\/api\/content\/works\/7\/audio$/);
	});

	test("builds a video's manifest address from the delivery endpoint", () => {
		const items = feedLensItems([entry({ id: 9, type: "video" })]);
		const workAccess = items[0]?.work?.access;

		expect(items[0]?.work?.transcoding?.hlsManifestUrl).toMatch(
			/\/api\/content\/works\/9\/hls\/master\.m3u8$/,
		);
		expect(isAccessResult(workAccess) && workAccess.canAccess).toBe(true);
	});

	test("leaves a Work no lens player draws without a payload", () => {
		// The translation adds an address only where a lens has a player to give it to;
		// a written Work keeps the feed's payload-free shape.
		const items = feedLensItems([entry({ id: 9, type: "ebook" })]);

		expect(items[0]?.work?.transcoding).toBeUndefined();
	});

	test("reads the commons off the verdict, not off a field the feed does not send", () => {
		const [free] = feedLensItems([entry({ access: access() })]);
		const [gated] = feedLensItems([entry({ access: access({ isFree: false, canAccess: false }) })]);

		expect(free?.work?.publicAccess).toBe(true);
		expect(gated?.work?.publicAccess).toBe(false);
	});

	test("every item is unsaved and unhidden: the Network is what arrived, not what was kept", () => {
		const [item] = feedLensItems([entry()]);

		expect(item).toMatchObject({ kind: "work", hidden: false, purchased: false });
	});

	test("an entry with no Work type cannot be drawn and is skipped", () => {
		// Named with a valid entry beside it: an untranslated feed and a skipped row both
		// produce nothing, so the assertion has to say the other row survived.
		const items = feedLensItems([entry({ id: 1, type: undefined }), entry({ id: 2 })]);

		expect(items.map((item) => item.id)).toEqual([2]);
	});
});
