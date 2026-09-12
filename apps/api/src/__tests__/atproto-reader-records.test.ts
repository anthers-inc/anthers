// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mapping a reader's rows onto the records they own.
 *
 * ⭐ The load-bearing assertion is that each produced record passes the Lexicon's OWN
 * validator, generated from the JSON in `lexicons/`. Asserting field by field against a
 * hand-written expectation would only restate the mapper's formula; running the schema is the
 * one check that can tell us the Lexicon is adequate for our data, which has to be true
 * before any of it is published as a public commitment.
 *
 * 🚨 **The refusals matter at least as much as the records.** A record is public and cached by
 * strangers, and deleting one later does not unsay it — so every case where a row must NOT
 * become a record is asserted here rather than left to the writer that will eventually call
 * these.
 */
import { describe, expect, it } from "bun:test";
import { commentRecord, followRecord, reviewRecord, voteRecord } from "@anthers/shared/lexicons";
import {
	commentToRecord,
	followToRecord,
	type PublishableComment,
	type PublishableReview,
	type PublishableVote,
	reviewToRecord,
	unpublishableCommentReason,
	unpublishableFollowReason,
	unpublishableReviewReason,
	unpublishableVoteReason,
	voteToRecord,
} from "../services/atproto-reader-records.js";

const WORK_URI = "at://did:plc:z72i7hdynmk6r22z27h6tvur/org.anthers.work/3lbk2vqf7yk2a";
const COMMENT_URI = "at://did:plc:z72i7hdynmk6r22z27h6tvur/org.anthers.comment/3lbk4mzq2rc2h";
const DID = "did:plc:z72i7hdynmk6r22z27h6tvur";

const comment = (o: Partial<PublishableComment> = {}): PublishableComment => ({
	userId: 7,
	body: "The second act does something I have never seen a game try.",
	moderationStatus: "visible",
	...o,
});

const review = (o: Partial<PublishableReview> = {}): PublishableReview => ({
	userId: 7,
	verdict: "recommended",
	body: "The combat never quite lands, and the writing more than carries it.",
	moderationStatus: "visible",
	...o,
});

const vote = (o: Partial<PublishableVote> = {}): PublishableVote => ({
	userId: 7,
	direction: "up",
	...o,
});

describe("a comment", () => {
	it("produces a record its own Lexicon accepts", () => {
		const record = commentToRecord(comment(), WORK_URI);
		expect(record).not.toBeNull();
		expect(commentRecord.safeParse(record).success).toBe(true);
	});

	it("is a REPLY when its subject is another comment, with no second schema involved", () => {
		const record = commentToRecord(comment(), COMMENT_URI);
		expect(commentRecord.safeParse(record).success).toBe(true);
		// The collection segment is what says a reply is a reply. Nothing else has to.
		expect(record?.subject.uri).toContain("/org.anthers.comment/");
	});

	// 🚨 A deleted account's comments are tombstoned rather than removed, so the row outlives
	// the repository. Writing this into anybody else's would be a lie about who said it.
	it("gets no record once its author has gone", () => {
		expect(unpublishableCommentReason(comment({ userId: null }), WORK_URI)).toBe("no_author");
		expect(commentToRecord(comment({ userId: null }), WORK_URI)).toBeNull();
	});

	// 🚨 Refusing to PUBLISH a hidden comment is a different act from deleting one already on
	// the network. A backfill ignoring moderation would push removed material onto a network
	// that has none.
	it("gets no record while it is hidden", () => {
		expect(unpublishableCommentReason(comment({ moderationStatus: "hidden" }), WORK_URI)).toBe(
			"hidden",
		);
	});

	it("gets no record when the thing it is about has none", () => {
		expect(unpublishableCommentReason(comment(), null)).toBe("subject_unpublished");
		expect(commentToRecord(comment(), null)).toBeNull();
	});

	it("gets no record when there is nothing written in it", () => {
		expect(unpublishableCommentReason(comment({ body: "   " }), WORK_URI)).toBe("empty_text");
	});
});

describe("a review", () => {
	it("produces a record its own Lexicon accepts", () => {
		const record = reviewToRecord(review(), WORK_URI);
		expect(record).not.toBeNull();
		expect(reviewRecord.safeParse(record).success).toBe(true);
		expect(record?.verdict).toBe("recommended");
	});

	it("carries a negative verdict just as happily", () => {
		const record = reviewToRecord(review({ verdict: "not-recommended" }), WORK_URI);
		expect(reviewRecord.safeParse(record).success).toBe(true);
	});

	// ⚠️ Anthers requires words when somebody writes a review, and the schema does not, so
	// rows predating that rule stay publishable rather than being stranded by it forever.
	it("publishes a verdict with no words, because the schema leaves text optional", () => {
		const record = reviewToRecord(review({ body: null }), WORK_URI);
		expect(reviewRecord.safeParse(record).success).toBe(true);
		expect(record).not.toHaveProperty("text");
	});

	// An empty string is not a value: it would say the reviewer wrote an empty review.
	it("omits the text rather than publishing an empty one", () => {
		const record = reviewToRecord(review({ body: "   " }), WORK_URI);
		expect(record).not.toHaveProperty("text");
	});

	it("refuses a verdict that is not one of ours", () => {
		expect(unpublishableReviewReason(review({ verdict: "4/5" }), WORK_URI)).toBe("bad_verdict");
		expect(reviewToRecord(review({ verdict: "" }), WORK_URI)).toBeNull();
	});

	it("gets no record once anonymized, or while hidden", () => {
		expect(unpublishableReviewReason(review({ userId: null }), WORK_URI)).toBe("no_author");
		expect(unpublishableReviewReason(review({ moderationStatus: "hidden" }), WORK_URI)).toBe(
			"hidden",
		);
	});
});

describe("a vote", () => {
	it("produces a record its own Lexicon accepts, in both directions", () => {
		for (const direction of ["up", "down"] as const) {
			const record = voteToRecord(vote({ direction }), COMMENT_URI);
			expect(voteRecord.safeParse(record).success).toBe(true);
			expect(record?.direction).toBe(direction);
		}
	});

	// 🚨 The column carried +1/-1 before the record carried a direction. A caller still passing
	// the old encoding must be refused rather than quietly written.
	it("refuses the signed encoding the column used to hold", () => {
		expect(unpublishableVoteReason(vote({ direction: "1" }), COMMENT_URI)).toBe("bad_direction");
		expect(voteToRecord(vote({ direction: "-1" }), COMMENT_URI)).toBeNull();
	});

	// ⚠️ A vote from a departed account still counts in Anthers' own arithmetic; what it cannot
	// be is an assertion by somebody who is no longer there to make it.
	it("gets no record once its voter has gone, and that is not the same as not counting", () => {
		expect(unpublishableVoteReason(vote({ userId: null }), COMMENT_URI)).toBe("no_author");
	});
});

describe("a follow", () => {
	it("produces a record its own Lexicon accepts", () => {
		const record = followToRecord({ followerId: 7 }, DID);
		expect(followRecord.safeParse(record).success).toBe(true);
		expect(record?.subject).toBe(DID);
	});

	// 🚨 This is the one record whose subject is a PERSON rather than something Anthers
	// published, so the gap belongs to the followed creator and nothing the follower does
	// closes it. Reported separately for exactly that reason.
	it("gets no record when the followed account has no identity", () => {
		expect(unpublishableFollowReason({ followerId: 7 }, null)).toBe("subject_has_no_identity");
		expect(unpublishableFollowReason({ followerId: 7 }, "  ")).toBe("subject_has_no_identity");
		expect(followToRecord({ followerId: 7 }, null)).toBeNull();
	});
});

describe("what the Lexicons refuse", () => {
	// ⚠️ The mappers cannot produce these, which is the point: the assertion is that the
	// SCHEMAS would reject them too, so a future writer that skips the mapper is still caught.
	it("will not accept a bare string subject, which is what the sketches first drew", () => {
		expect(
			commentRecord.safeParse({ $type: "org.anthers.comment", subject: WORK_URI, text: "hi" })
				.success,
		).toBe(false);
	});

	it("will not accept a review with no verdict", () => {
		expect(
			reviewRecord.safeParse({
				$type: "org.anthers.review",
				subject: { uri: WORK_URI },
				text: "words but no verdict",
			}).success,
		).toBe(false);
	});

	// ⭐ An open value set really is open — the generated validator drops the known values, so
	// this passes. It is asserted so that nobody "fixes" the openness later believing it a bug:
	// consumers are required to accept values a build has never heard of.
	it("accepts a verdict it has never heard of, because the set is open", () => {
		expect(
			reviewRecord.safeParse({
				$type: "org.anthers.review",
				subject: { uri: WORK_URI },
				verdict: "mixed",
			}).success,
		).toBe(true);
	});
});
