// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Planning and syncing a reader's records.
 *
 * 🚨 **The delete branch is what this suite exists for.** A comment that gets hidden, a review
 * whose author deletes their account, a vote that stops being valid — each must have its
 * record REMOVED once one exists, not merely skipped. Skipping leaves an assertion standing
 * on a public network that Anthers has stopped standing behind, and a record is public the
 * moment it lands. "Unpublishable" is therefore two different outcomes depending on whether a
 * record exists, and collapsing them is the bug the shape prevents.
 */
import { describe, expect, it } from "bun:test";
import {
	COMMENT_COLLECTION,
	COMMENT_KIND,
	FOLLOW_KIND,
	planRecord,
	REVIEW_KIND,
	syncRecord,
	VOTE_KIND,
} from "../services/atproto-record-plan.js";
import type { RecordRef, RepoWriter } from "../services/atproto-repo.js";

const DID = "did:plc:z72i7hdynmk6r22z27h6tvur";
const WORK_URI = `at://${DID}/org.anthers.work/3lbk2vqf7yk2a`;
const EXISTING = `at://${DID}/org.anthers.comment/3lbk4mzq2rc2h`;

const visibleComment = {
	comment: { userId: 7, body: "Worth the time.", moderationStatus: "visible" },
	subjectUri: WORK_URI,
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

	// 🚨 The whole point. Hiding a comment that is already on the network has to take it down.
	it("DELETES the record when the row stops being publishable and one exists", () => {
		const hidden = {
			...visibleComment,
			comment: { ...visibleComment.comment, moderationStatus: "hidden" },
		};
		expect(planRecord(COMMENT_KIND, hidden, EXISTING)).toMatchObject({
			action: "delete",
			rkey: "3lbk4mzq2rc2h",
			reason: "hidden",
		});
	});

	// The same row with no record needs nothing doing, and saying so is different from saying
	// "delete something that is not there".
	it("does nothing when the row is unpublishable and never had a record", () => {
		const hidden = {
			...visibleComment,
			comment: { ...visibleComment.comment, moderationStatus: "hidden" },
		};
		expect(planRecord(COMMENT_KIND, hidden, null)).toMatchObject({
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
		const hidden = {
			...visibleComment,
			comment: { ...visibleComment.comment, moderationStatus: "hidden" },
		};
		const outcome = await syncRecord(writer, COMMENT_KIND, hidden, EXISTING);
		expect(writer.calls).toEqual([`delete:${COMMENT_COLLECTION}:3lbk4mzq2rc2h`]);
		expect(outcome.uri).toBeNull();
	});

	it("touches the repository not at all when there is nothing to do", async () => {
		const writer = fakeWriter();
		const hidden = {
			...visibleComment,
			comment: { ...visibleComment.comment, moderationStatus: "hidden" },
		};
		await syncRecord(writer, COMMENT_KIND, hidden, null);
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
