// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mapping a creator's posts and projects onto their records.
 *
 * ⭐ As with the reader's records, the load-bearing assertion is that what comes out passes
 * the Lexicon's own validator rather than a restatement of the mapper's formula.
 */
import { describe, expect, it } from "bun:test";
import { postRecord, projectRecord } from "@anthers/shared/lexicons";
import {
	type PublishablePost,
	type PublishableProject,
	postToRecord,
	postUrl,
	projectToRecord,
	projectUrl,
	unpublishablePostReason,
	unpublishableProjectReason,
} from "../services/atproto-creator-records.js";

const BASE = "https://anthers.org";
const PUBLISHED = new Date("2026-08-14T00:00:00.000Z");

const post = (o: Partial<PublishablePost> = {}): PublishablePost => ({
	creatorId: 42,
	slug: "what-i-learned",
	publicId: 1204,
	isPublished: true,
	publishedAt: PUBLISHED,
	...o,
});

const project = (o: Partial<PublishableProject> = {}): PublishableProject => ({
	creatorId: 42,
	slug: "the-lanterns-trilogy",
	title: "The Lanterns Trilogy",
	description: "Three games about light.",
	isPublished: true,
	...o,
});

describe("a post", () => {
	it("produces a record its own Lexicon accepts", () => {
		const record = postToRecord(post(), { baseUrl: BASE });
		expect(record).not.toBeNull();
		expect(postRecord.safeParse(record).success).toBe(true);
	});

	it("mirrors the app's own route, publicId and all", () => {
		expect(postUrl(post(), BASE)).toBe("https://anthers.org/posts/what-i-learned-1204");
		// A trailing slash on the base must not produce a doubled one in a public record.
		expect(postUrl(post(), "https://anthers.org/")).toBe(
			"https://anthers.org/posts/what-i-learned-1204",
		);
	});

	// 🚨 The record carries the post's OWN date rather than the record's, because a post may be
	// drafted long before it goes live and a backfill would otherwise claim its own date.
	it("carries the publication date rather than the moment the record was made", () => {
		const record = postToRecord(post(), { baseUrl: BASE });
		expect(record?.publishedAt).toBe(PUBLISHED.toISOString());
	});

	// 🚨 `content` is markdown in the Lexicon and a post is stored as sanitized HTML, so there
	// is nothing to map yet. This asserts the absence deliberately: a mapper that started
	// converting HTML here would make a lossy conversion happen invisibly on every write.
	it("carries no content, because there is no markdown source to carry", () => {
		const record = postToRecord(post(), { baseUrl: BASE });
		expect(record).not.toHaveProperty("content");
		// And the Lexicon accepts that, which is what makes shipping without it legitimate.
		expect(postRecord.safeParse(record).success).toBe(true);
	});

	it("gets no record while it is a draft", () => {
		expect(unpublishablePostReason(post({ isPublished: false, publishedAt: null }))).toBe(
			"not_published",
		);
		expect(
			postToRecord(post({ isPublished: false, publishedAt: null }), { baseUrl: BASE }),
		).toBeNull();
	});

	// 🚨 The case the first implementation got wrong, and the one that matters most. `published_at`
	// is stamped on the transition into published and is NEVER cleared, so a retracted post is a
	// row reading `is_published = false` beside a live-looking date. A mapper testing the date
	// alone calls this publishable — and because a record already exists by then, the plan comes
	// out `replace` rather than `delete`, which is a creator taking something down and Anthers
	// rewriting it on the network instead.
	it("gets no record once its creator takes it down, date still stamped", () => {
		const retracted = post({ isPublished: false, publishedAt: PUBLISHED });
		expect(unpublishablePostReason(retracted)).toBe("not_published");
		expect(postToRecord(retracted, { baseUrl: BASE })).toBeNull();
	});

	// A departed creator's posts are tombstoned so the threads under them survive. There is no
	// repository left to write into.
	it("gets no record once its creator has gone", () => {
		expect(unpublishablePostReason(post({ creatorId: null }))).toBe("no_creator");
		expect(postToRecord(post({ creatorId: null }), { baseUrl: BASE })).toBeNull();
	});
});

describe("a project", () => {
	it("produces a record its own Lexicon accepts", () => {
		const record = projectToRecord(project(), { baseUrl: BASE });
		expect(record).not.toBeNull();
		expect(projectRecord.safeParse(record).success).toBe(true);
		expect(projectUrl(project(), BASE)).toBe("https://anthers.org/projects/the-lanterns-trilogy");
	});

	// 🚨 The whole design decision about this record is what it does NOT hold. A membership list
	// would have to be rewritten every time a work moved, broadcasting a new version each time.
	it("names nothing it contains", () => {
		const record = projectToRecord(project(), { baseUrl: BASE });
		expect(record).not.toHaveProperty("works");
		expect(record).not.toHaveProperty("items");
		expect(record).not.toHaveProperty("members");
	});

	it("omits an empty description rather than publishing one", () => {
		expect(projectToRecord(project({ description: "  " }), { baseUrl: BASE })).not.toHaveProperty(
			"description",
		);
		expect(projectToRecord(project({ description: null }), { baseUrl: BASE })).not.toHaveProperty(
			"description",
		);
	});

	it("gets no record when it names nothing", () => {
		expect(unpublishableProjectReason(project({ title: "   " }))).toBe("missing_title");
		expect(projectToRecord(project({ title: "" }), { baseUrl: BASE })).toBeNull();
	});

	// 🚨 A draft project is one its creator has kept out of the public browse listing, which
	// filters on exactly this column. Broadcasting a record for it would publish the thing more
	// loudly than the listing it was withheld from.
	it("gets no record while it is a draft", () => {
		expect(unpublishableProjectReason(project({ isPublished: false }))).toBe("not_published");
		expect(projectToRecord(project({ isPublished: false }), { baseUrl: BASE })).toBeNull();
	});
});
