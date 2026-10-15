// SPDX-License-Identifier: Apache-2.0
/**
 * The schedule panel's listing, assembled from the two listings the Dashboard already holds.
 *
 * Here for the same reason `studio-worklist.test.ts` is: **the failure mode is an empty or
 * wrong panel rather than an error.** A Work scheduled for release sits private in the
 * catalog with no other surface that says when it goes out, so a filter that silently stops
 * matching renders exactly the same "Nothing is scheduled" that honesty renders — and the
 * creator loses the one view of the schedule this panel exists to be.
 */
import { describe, expect, it } from "bun:test";
import type { PostListItem, Work } from "../../lib/types";
import { buildSchedule } from "./studio-schedule";

function work(over: Partial<Work> = {}): Work {
	return {
		id: 1,
		publicId: 100001,
		type: "video",
		sourceKey: "creators/1/video/tide.mp4",
		title: "Tide",
		visibility: "private",
		scheduledReleaseAt: null,
		maturity: "general",
		streamEnabled: true,
		downloadEnabled: false,
		access: [{ threshold: 0, allow: false, price: "0" }],
		assets: [],
		transcoding: null,
		...over,
	} as unknown as Work;
}

function post(over: Partial<PostListItem> = {}): PostListItem {
	return {
		id: 1,
		publicId: 200001,
		slug: "tide",
		creatorId: 1,
		title: "Tide devlog",
		showOnTimeline: true,
		isPinned: false,
		tags: null,
		isPublished: false,
		publishedAt: null,
		scheduledFor: null,
		viewCount: 0,
		createdAt: "2026-10-01T00:00:00Z",
		updatedAt: "2026-10-01T00:00:00Z",
		thumbnail: null,
		linkedWorkCount: 0,
		...over,
	} as unknown as PostListItem;
}

const NOW = new Date("2026-10-15T12:00:00Z");

const build = (works: Work[], posts: PostListItem[] = []) => {
	const items = buildSchedule({
		works,
		posts,
		editWorkUrl: (w) => `/studio/works/${w.publicId ?? w.id}/edit`,
		editPostUrl: (p) => `/studio/posts/${p.slug}`,
		now: NOW,
	});
	return items.map((item) => ({ kind: item.kind, title: item.title, href: item.href }));
};

describe("buildSchedule", () => {
	it("says nothing at all when nothing is scheduled", () => {
		// The empty case first, as the worklist's own test does: a panel that renders
		// "Nothing is scheduled" is what honesty renders, so anything spurious here is a
		// permanent false calm.
		expect(build([work()], [post()])).toEqual([]);
		expect(build([], [])).toEqual([]);
	});

	it("lists a scheduled private Work and points at its editor", () => {
		const scheduled = work({ scheduledReleaseAt: "2026-10-20T09:00:00Z" });
		expect(build([scheduled])).toEqual([
			{ kind: "release", title: "Tide", href: "/studio/works/100001/edit" },
		]);
	});

	it("lists a scheduled draft post and points at its editor, not at its future page", () => {
		// The row's job is the schedule itself, which only the post form holds.
		const scheduled = post({ scheduledFor: "2026-10-20T09:00:00Z" });
		expect(build([], [scheduled])).toEqual([
			{ kind: "post", title: "Tide devlog", href: "/studio/posts/tide" },
		]);
	});

	it("leaves out what is off the schedule", () => {
		// A released Work has no release to come; a published post has already gone out; a
		// draft with no date is not scheduled, it is parked. None of them are on this panel.
		expect(build([work({ visibility: "released" }), work({ scheduledReleaseAt: null })])).toEqual(
			[],
		);
		expect(
			build([], [post({ isPublished: true, publishedAt: "2026-10-10T00:00:00Z" }), post()]),
		).toEqual([]);
	});

	it("sorts soonest first across both kinds", () => {
		const items = build(
			[work({ id: 2, title: "Ebb", scheduledReleaseAt: "2026-10-22T09:00:00Z" })],
			[post({ slug: "sooner", title: "Sooner", scheduledFor: "2026-10-18T09:00:00Z" })],
		);
		expect(items.map((item) => item.title)).toEqual(["Sooner", "Ebb"]);
	});

	it("marks a release whose time has passed as waiting, and puts it first", () => {
		// The server holds the Work back until its file is ready; a date it cannot keep
		// shows as waiting rather than late.
		const waiting = work({ title: "Waiting", scheduledReleaseAt: "2026-10-14T09:00:00Z" });
		const future = work({ id: 2, title: "Future", scheduledReleaseAt: "2026-10-20T09:00:00Z" });
		const items = buildSchedule({
			works: [future, waiting],
			posts: [],
			editWorkUrl: (w) => `/studio/works/${w.publicId ?? w.id}/edit`,
			editPostUrl: (p) => `/studio/posts/${p.slug}`,
			now: NOW,
		});
		expect(items.map((item) => [item.title, item.waiting])).toEqual([
			["Waiting", true],
			["Future", false],
		]);
	});

	it("falls back to Untitled when neither kind carries a title", () => {
		const scheduled = work({ title: null, scheduledReleaseAt: "2026-10-20T09:00:00Z" });
		const items = buildSchedule({
			works: [scheduled],
			posts: [],
			editWorkUrl: (_w) => "/studio/works/x/edit",
			editPostUrl: (_p) => "/studio/posts/x",
			now: NOW,
		});
		expect(items[0].title).toBe("Untitled");
	});
});
