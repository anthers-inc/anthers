// SPDX-License-Identifier: Apache-2.0
/**
 * Planning and syncing the records Anthers writes on somebody's behalf.
 *
 * 🚨 **What happens to a record that ALREADY EXISTS is what this suite exists for, and it has
 * three answers rather than two.** A creator returning a post to a draft is taking it back, so
 * its record comes down. A moderator hiding a reader's comment is not the reader taking
 * anything back, so the record stays where its author put it — the wiki's *User Records in the
 * Atmosphere* ruling, which an earlier version of this suite asserted the opposite of. And a row
 * with no record needs nothing at all. Collapsing any two of those is a bug in one direction or
 * the other: a record left up that its owner withdrew, or somebody's words deleted from their own
 * repository over a decision they did not make.
 *
 * ⚠️ **Every collection is treated as published here except in the suite about the gate**, so
 * the planning tests exercise planning. The gate has its own tests at the bottom.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	COMMENT_COLLECTION,
	COMMENT_KIND,
	FOLLOW_KIND,
	POST_KIND,
	planRecord,
	REVIEW_KIND,
	syncRecord,
	VOTE_KIND,
} from "../services/atproto-record-plan.js";
import type { RecordRef, RepoWriter } from "../services/atproto-repo.js";
import {
	PUBLISHED_LEXICONS,
	setPublishedLexiconsForTesting,
} from "../services/published-lexicons.js";

const EVERY_COLLECTION = [
	"org.anthers.comment",
	"org.anthers.review",
	"org.anthers.vote",
	"org.anthers.follow",
	"org.anthers.post",
	"org.anthers.project",
];

beforeAll(() => setPublishedLexiconsForTesting(EVERY_COLLECTION));
afterAll(() => setPublishedLexiconsForTesting(undefined));

const DID = "did:plc:z72i7hdynmk6r22z27h6tvur";
const WORK_URI = `at://${DID}/org.anthers.work/3lbk2vqf7yk2a`;
const EXISTING = `at://${DID}/org.anthers.comment/3lbk4mzq2rc2h`;

const visibleComment = {
	comment: { userId: 7, body: "Worth the time.", moderationStatus: "visible" },
	subjectUri: WORK_URI,
};

const hiddenComment = {
	...visibleComment,
	comment: { ...visibleComment.comment, moderationStatus: "hidden" },
};

/** A comment its author has edited down to nothing — the author taking their words back. */
const emptiedComment = {
	...visibleComment,
	comment: { ...visibleComment.comment, body: "   " },
};

/** Records every call, so a test can assert which one the plan actually reached for. */
function fakeWriter(): RepoWriter & { calls: string[] } {
	const calls: string[] = [];
	return {
		did: DID,
		calls,
		async createRecord(collection: string): Promise<RecordRef> {
			calls.push(`create:${collection}`);
			return { uri: `at://${DID}/${collection}/new`, cid: "bafy" };
		},
		async putRecord(collection: string, rkey: string): Promise<RecordRef> {
			calls.push(`put:${collection}:${rkey}`);
			return { uri: `at://${DID}/${collection}/${rkey}`, cid: "bafy" };
		},
		async deleteRecord(collection: string, rkey: string): Promise<void> {
			calls.push(`delete:${collection}:${rkey}`);
		},
	};
}

describe("planning a record", () => {
	it("creates one when the row has none", () => {
		const plan = planRecord(COMMENT_KIND, visibleComment, null);
		expect(plan.action).toBe("create");
	});

	it("replaces the one it already has rather than adding a second", () => {
		const plan = planRecord(COMMENT_KIND, visibleComment, EXISTING);
		expect(plan).toMatchObject({ action: "replace", rkey: "3lbk4mzq2rc2h" });
	});

	// 🚨 **The case an earlier version of this suite got backwards.** Hiding is Anthers declining to
	// show a comment. It is not the commenter withdrawing it, so their record stays where they put
	// it and the address stays with it.
	it("KEEPS a hidden comment's record where its author put it", () => {
		expect(planRecord(COMMENT_KIND, hiddenComment, EXISTING)).toEqual({
			action: "keep",
			rkey: "3lbk4mzq2rc2h",
			reason: "hidden",
		});
	});

	// Other people's records survive the thing they were about.
	it("keeps a comment's record when its subject stops having one", () => {
		expect(
			planRecord(COMMENT_KIND, { ...visibleComment, subjectUri: null }, EXISTING),
		).toMatchObject({ action: "keep", reason: "subject_unpublished" });
	});

	// The author's own act, and so the one reader refusal that takes a record down.
	it("DELETES a comment's record when its author edits the words away", () => {
		expect(planRecord(COMMENT_KIND, emptiedComment, EXISTING)).toEqual({
			action: "delete",
			rkey: "3lbk4mzq2rc2h",
			reason: "empty_text",
		});
	});

	// 🚨 And the creator's side of the same line: a post returned to a draft is its creator taking
	// it back, so its record must come down rather than be kept.
	it("DELETES a post's record when its creator returns it to a draft", () => {
		const draft = {
			creatorId: 7,
			slug: "notes",
			publicId: 12,
			isPublished: false,
			publishedAt: new Date("2026-08-14T00:00:00.000Z"),
		};
		expect(planRecord(POST_KIND, draft, `at://${DID}/org.anthers.post/3lbk`)).toEqual({
			action: "delete",
			rkey: "3lbk",
			reason: "not_published",
		});
	});

	// The same row with no record needs nothing doing, and saying so is different from saying
	// "delete something that is not there".
	it("does nothing when the row is unpublishable and never had a record", () => {
		expect(planRecord(COMMENT_KIND, hiddenComment, null)).toMatchObject({
			action: "none",
			reason: "hidden",
		});
	});

	// 🚨 Reading an unparseable URI as "no record" would write a second record and orphan the
	// first. A duplicate public record is far harder to clean up than a row somebody looks at.
	it("refuses a stored address it cannot read rather than starting over", () => {
		const plan = planRecord(COMMENT_KIND, visibleComment, "not-an-at-uri");
		expect(plan.action).toBe("invalid");
	});

	// A URI pointing at some other collection is the same hazard wearing a disguise.
	it("refuses an address that names a different collection", () => {
		const plan = planRecord(COMMENT_KIND, visibleComment, `at://${DID}/org.anthers.vote/abc`);
		expect(plan.action).toBe("invalid");
	});

	it("plans a review, a vote and a follow through the same code path", () => {
		expect(
			planRecord(
				REVIEW_KIND,
				{
					review: {
						userId: 7,
						verdict: "recommended",
						body: "Worth it.",
						moderationStatus: "visible",
					},
					subjectUri: WORK_URI,
				},
				null,
			).action,
		).toBe("create");
		expect(
			planRecord(VOTE_KIND, { vote: { userId: 7, direction: "up" }, subjectUri: WORK_URI }, null)
				.action,
		).toBe("create");
		expect(
			planRecord(FOLLOW_KIND, { follow: { followerId: 7 }, creatorDid: DID }, null).action,
		).toBe("create");
	});
});

describe("syncing a record", () => {
	it("reaches for the operation its plan named, and nothing else", async () => {
		const writer = fakeWriter();
		const created = await syncRecord(writer, COMMENT_KIND, visibleComment, null);
		expect(writer.calls).toEqual([`create:${COMMENT_COLLECTION}`]);
		expect(created.uri).toContain(COMMENT_COLLECTION);

		const replaced = await syncRecord(writer, COMMENT_KIND, visibleComment, EXISTING);
		expect(writer.calls.at(-1)).toBe(`put:${COMMENT_COLLECTION}:3lbk4mzq2rc2h`);
		expect(replaced.uri).toBe(EXISTING);
	});

	it("returns a null address after a delete, so the row forgets where the record was", async () => {
		const writer = fakeWriter();
		const outcome = await syncRecord(writer, COMMENT_KIND, emptiedComment, EXISTING);
		expect(writer.calls).toEqual([`delete:${COMMENT_COLLECTION}:3lbk4mzq2rc2h`]);
		expect(outcome.uri).toBeNull();
	});

	// 🚨 A kept record is still one Anthers must be able to find — to rewrite it when the comment
	// is restored, or to remove it when its author deletes it. Returning null here would clear the
	// column and strand the record for good.
	it("touches nothing and keeps the address when the record is kept", async () => {
		const writer = fakeWriter();
		const outcome = await syncRecord(writer, COMMENT_KIND, hiddenComment, EXISTING);
		expect(writer.calls).toEqual([]);
		expect(outcome.uri).toBe(EXISTING);
	});

	it("touches the repository not at all when there is nothing to do", async () => {
		const writer = fakeWriter();
		await syncRecord(writer, COMMENT_KIND, hiddenComment, null);
		expect(writer.calls).toEqual([]);
	});

	// ⚠️ An invalid plan must not also make the row forget where its record is. The two causes
	// are an unreadable URI and a record failing its schema, and neither is improved by losing
	// the only pointer to what is already on the network.
	it("keeps the stored address when it cannot make sense of things", async () => {
		const writer = fakeWriter();
		const outcome = await syncRecord(writer, COMMENT_KIND, visibleComment, "not-an-at-uri");
		expect(writer.calls).toEqual([]);
		expect(outcome.uri).toBe("not-an-at-uri");
	});
});

describe("a collection whose Lexicon is not published", () => {
	// The real set, for this block only.
	beforeAll(() => setPublishedLexiconsForTesting(undefined));
	afterAll(() => setPublishedLexiconsForTesting(EVERY_COLLECTION));

	it("writes under exactly the published schemas it has chosen to", async () => {
		expect([...PUBLISHED_LEXICONS].sort()).toEqual([
			"org.anthers.creatorPermissions",
			"org.anthers.post",
			"org.anthers.project",
			"org.anthers.userPermissions",
			"org.anthers.work",
		]);
		// And each names a schema this repository actually holds, so a typo cannot open the gate
		// for a collection nobody wrote.
		for (const nsid of PUBLISHED_LEXICONS) {
			const path = `lexicons/${nsid.split(".").slice(0, -1).join("/")}/${nsid.split(".").at(-1)}.json`;
			expect((await Bun.file(path).json()).id).toBe(nsid);
		}
	});

	// 🚨 A record is a draft schema's first public commitment, and it would skip the review that
	// publishing a schema gets.
	it("writes nothing for a row that would otherwise get a record", async () => {
		expect(planRecord(COMMENT_KIND, visibleComment, null)).toEqual({
			action: "none",
			reason: "lexicon_unpublished",
		});

		const writer = fakeWriter();
		const outcome = await syncRecord(writer, COMMENT_KIND, visibleComment, EXISTING);
		expect(outcome.plan).toMatchObject({ action: "keep", reason: "lexicon_unpublished" });
		expect(writer.calls).toEqual([]);
		// And one somehow already out there is not forgotten.
		expect(outcome.uri).toBe(EXISTING);
	});

	// ⚠️ Removal is the safe direction under every schema, so the gate never stands in its way.
	it("still takes a record down", async () => {
		const writer = fakeWriter();
		const outcome = await syncRecord(writer, COMMENT_KIND, emptiedComment, EXISTING);
		expect(writer.calls).toEqual([`delete:${COMMENT_COLLECTION}:3lbk4mzq2rc2h`]);
		expect(outcome.uri).toBeNull();
	});

	// Checked before the gate, so a malformed record is reported even while its schema is a draft.
	it("still reports a record that would fail its own schema", () => {
		const bad = {
			...visibleComment,
			comment: { ...visibleComment.comment, body: "x".repeat(40_000) },
		};
		expect(planRecord(COMMENT_KIND, bad, null).action).toBe("invalid");
	});
});
