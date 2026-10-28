// SPDX-License-Identifier: Apache-2.0
/**
 * Every path by which Anthers removes something voids the Stickers it reaches, and undoing one
 * removal puts them back only when nothing else still has the subject removed.
 *
 * 🚨 **The removals are driven through their own services** — `hideSubject`, `quarantineWork`,
 * `takeDownWork` and their reversals — rather than by calling `voidStickersOnSubject` directly.
 * A test of the void function alone passes while a removal path never calls it, which is the
 * defect this file exists to catch.
 *
 * ⚠️ **A Sticker on a comment pays whoever wrote the thread's root**, so a Work's removal has to
 * reach the Stickers on its comments. Comments on Works are older rows, since a Work now takes
 * reviews instead, but they still exist and still pay.
 *
 * ⭐ **Since 2026-10-24 the money follows the nearest creator up the thread**, so a hide reaches
 * more than the row it hid: the replies beneath a hidden creator's comment whose money that
 * creator was taking are voided with it, and an ordinary comment's hide reaches only itself. The
 * second half matters as much as the first — a reach that followed every hidden ancestor would
 * revoke Stickers the hide never applied to.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	comments,
	dmcaNotices,
	legalHolds,
	mediaQuarantine,
	moderationActions,
	posts,
	reviews,
	stickers,
	workAssets,
} from "@anthers/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { restoreWork, takeDownWork } from "../services/dmca.js";
import { hideSubject, restoreSubject } from "../services/moderation.js";
import { clearQuarantine, quarantineWork } from "../services/quarantine.js";
import { storage } from "../services/storage/index.js";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork, testPublicId } from "./work-fixtures.js";

purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const RUN = crypto.randomUUID().slice(0, 8);
/** A cycle no distribution row names, so nothing here reads as settled. */
const CYCLE = "2033-02-01";

let giverId: number;
let creatorId: number;
/** A second creator, payable, whose comments and replies take the money for their own threads. */
let otherCreatorId: number;
let adminId: number;
const workIds: number[] = [];
const noticeIds: number[] = [];
const commentIds: number[] = [];
const postIds: number[] = [];
const reviewIds: number[] = [];
const stickerIds: number[] = [];
const storedKeys: string[] = [];

beforeAll(async () => {
	giverId = (await createAccount(`vr_giver_${RUN}`)).userId;
	creatorId = (await createAccount(`vr_creator_${RUN}`)).userId;
	otherCreatorId = (await createAccount(`vr_other_${RUN}`)).userId;
	adminId = (await createAdminFixture("sticker-void")).id;
}, DB_SETUP_TIMEOUT);

// Quarantine moves real objects, places holds, and writes findings and a log; none of those
// reach the fixture accounts through a cascade, so each is taken by what this file created.
afterAll(async () => {
	if (stickerIds.length > 0) await db.delete(stickers).where(inArray(stickers.id, stickerIds));
	if (workIds.length > 0) {
		const parked = await db
			.select({ key: mediaQuarantine.quarantineKey })
			.from(mediaQuarantine)
			.where(inArray(mediaQuarantine.workId, workIds));
		for (const { key } of parked) await storage.delete(key).catch(() => {});
		await db.delete(mediaQuarantine).where(inArray(mediaQuarantine.workId, workIds));
		await db
			.delete(legalHolds)
			.where(and(eq(legalHolds.subjectType, "work"), inArray(legalHolds.subjectId, workIds)));
		await db
			.delete(moderationActions)
			.where(
				and(
					eq(moderationActions.subjectType, "work"),
					inArray(moderationActions.subjectId, workIds),
				),
			);
	}
	if (commentIds.length > 0) {
		await db
			.delete(moderationActions)
			.where(
				and(
					eq(moderationActions.subjectType, "comment"),
					inArray(moderationActions.subjectId, commentIds),
				),
			);
	}
	await db
		.delete(legalHolds)
		.where(and(eq(legalHolds.subjectType, "user"), eq(legalHolds.subjectId, creatorId)));
	if (reviewIds.length > 0) await db.delete(reviews).where(inArray(reviews.id, reviewIds));
	if (postIds.length > 0) await db.delete(posts).where(inArray(posts.id, postIds));
	if (noticeIds.length > 0) await db.delete(dmcaNotices).where(inArray(dmcaNotices.id, noticeIds));
	for (const key of storedKeys) await storage.delete(key).catch(() => {});
});

/** A Work with one stored object, so a quarantine has something to move and a finding to clear. */
async function aWork(title: string) {
	const work = await insertWork({ creatorId, type: "software", title: `${title} ${RUN}` });
	workIds.push(work.id);
	const key = `creators/${creatorId}/assets/${work.publicId}-build.zip`;
	await storage.upload(key, Buffer.from("pretend build bytes"), "application/zip");
	storedKeys.push(key);
	await db
		.insert(workAssets)
		.values({ workId: work.id, file: key, filename: "build.zip", fileSize: 19 });
	return work.id;
}

/** The giver's own comment on a Work, which is what a comment Sticker rides. */
/** A review of the fixture Work, whose Sticker pays the Work's creator. */
async function aReview(workId: number, userId: number) {
	const [row] = await db
		.insert(reviews)
		.values({ userId, workId, verdict: "recommend", body: `Review ${RUN}` })
		.returning({ id: reviews.id });
	reviewIds.push(row.id);
	return row.id;
}

async function aComment(workId: number) {
	const [row] = await db
		.insert(comments)
		.values({ userId: giverId, subjectType: "work", subjectId: workId, body: `Mine ${RUN}` })
		.returning({ id: comments.id });
	commentIds.push(row.id);
	return row.id;
}

async function aSticker(subjectType: "work" | "comment", subjectId: number) {
	const [row] = await db
		.insert(stickers)
		.values({
			giverId,
			creatorId,
			subjectType,
			subjectId,
			billingCycle: CYCLE,
			amount: "1.00",
			artKey: "butterfly-large",
		})
		.returning({ id: stickers.id });
	stickerIds.push(row.id);
	return row.id;
}

async function voided(stickerId: number): Promise<boolean> {
	const [row] = await db
		.select({ voidedAt: stickers.voidedAt })
		.from(stickers)
		.where(eq(stickers.id, stickerId));
	return row.voidedAt !== null;
}

/** A notice ready to be acted on, against this Work. */
async function aNotice(workId: number) {
	const [row] = await db
		.insert(dmcaNotices)
		.values({
			workId,
			workTitle: `Notice ${RUN}`,
			complainantName: "Copyright Holder",
			complainantEmail: `void-${RUN}-${workId}@example.com`,
			complainantAddress: "123 Main St, Anytown, US",
			copyrightedWorkDescription: "An original game.",
			infringingMaterialDescription: "A copy of it.",
			goodFaithStatement: "Not authorized.",
			authorizationStatement: "Authorized to act.",
			fairUseConsidered: true,
			attestationTextSnapshot: "EXAMPLE attestation",
			status: "received",
		})
		.returning({ id: dmcaNotices.id });
	noticeIds.push(row.id);
	return row.id;
}

const quarantine = (workId: number) =>
	quarantineWork({ workId, source: "operator", classification: "test", adminId });

describe("a Sticker Anthers' removal reaches", () => {
	it("is voided when an operator hides the comment it rides, and back when the comment is restored", async () => {
		const workId = await aWork("Hidden comment");
		const commentId = await aComment(workId);
		const sticker = await aSticker("comment", commentId);

		await hideSubject({ subjectType: "comment", subjectId: commentId, adminId, reason: "spam" });
		expect(await voided(sticker), "a hidden comment kept paying").toBe(true);

		await restoreSubject({ subjectType: "comment", subjectId: commentId, adminId });
		expect(await voided(sticker)).toBe(false);
	});

	it("is voided when its Work is quarantined, on the Work and on the comments beneath it", async () => {
		const workId = await aWork("Quarantined");
		const onWork = await aSticker("work", workId);
		const onComment = await aSticker("comment", await aComment(workId));

		await quarantine(workId);
		expect(await voided(onWork), "a quarantined Work kept paying").toBe(true);
		expect(await voided(onComment), "a comment kept paying the quarantined Work's creator").toBe(
			true,
		);

		await clearQuarantine({ workId, adminId });
		expect(await voided(onWork)).toBe(false);
		expect(await voided(onComment)).toBe(false);
	});

	it("is voided by a takedown, and back when the takedown is undone", async () => {
		const workId = await aWork("Taken down");
		const onWork = await aSticker("work", workId);
		const onComment = await aSticker("comment", await aComment(workId));
		const noticeId = await aNotice(workId);

		await takeDownWork({ noticeId, adminId });
		expect(await voided(onWork)).toBe(true);
		expect(await voided(onComment), "a comment kept paying the taken-down Work's creator").toBe(
			true,
		);

		await restoreWork({ noticeId, adminId });
		expect(await voided(onWork), "the restore read the Work before it was restored").toBe(false);
		expect(await voided(onComment)).toBe(false);
	});

	it("🚨 stays voided when a takedown is undone while a quarantine still stands", async () => {
		const workId = await aWork("Taken down and quarantined");
		const onWork = await aSticker("work", workId);
		const noticeId = await aNotice(workId);

		await takeDownWork({ noticeId, adminId });
		await quarantine(workId);
		expect(await restoreWork({ noticeId, adminId })).toEqual({ status: "restored" });
		expect(await voided(onWork), "restored while the Work was still quarantined").toBe(true);

		await clearQuarantine({ workId, adminId });
		expect(await voided(onWork)).toBe(false);
	});

	it("🚨 stays voided when its comment is restored while the Work above it is still removed", async () => {
		const workId = await aWork("Hidden under quarantine");
		const commentId = await aComment(workId);
		const sticker = await aSticker("comment", commentId);

		await hideSubject({ subjectType: "comment", subjectId: commentId, adminId, reason: "spam" });
		await quarantine(workId);
		await restoreSubject({ subjectType: "comment", subjectId: commentId, adminId });
		expect(await voided(sticker), "restored while its thread's Work was quarantined").toBe(true);

		await clearQuarantine({ workId, adminId });
		expect(await voided(sticker)).toBe(false);
	});
});

describe("the nearest creator a Sticker pays", () => {
	/** A published post by the fixture creator, which a thread of comments hangs off. */
	async function aPost() {
		const [row] = await db
			.insert(posts)
			.values({
				creatorId,
				publicId: testPublicId(),
				title: `Thread ${RUN}`,
				slug: `void-thread-${crypto.randomUUID().slice(0, 8)}`,
				isPublished: true,
				publishedAt: new Date(),
			})
			.returning({ id: posts.id });
		postIds.push(row.id);
		return row.id;
	}

	async function aCommentOn(subjectType: "post" | "comment", subjectId: number, userId: number) {
		const [row] = await db
			.insert(comments)
			.values({ userId, subjectType, subjectId, body: `Row ${RUN}` })
			.returning({ id: comments.id });
		commentIds.push(row.id);
		return row.id;
	}

	/** A Sticker paying a named creator, wherever it sits. */
	async function aStickerPaying(
		subjectType: "work" | "post" | "comment" | "review",
		subjectId: number,
		payeeId: number,
	) {
		const [row] = await db
			.insert(stickers)
			.values({
				giverId,
				creatorId: payeeId,
				subjectType,
				subjectId,
				billingCycle: CYCLE,
				amount: "1.00",
				artKey: "butterfly-large",
			})
			.returning({ id: stickers.id });
		stickerIds.push(row.id);
		return row.id;
	}

	it("voids the replies beneath a hidden creator's comment, and restores them", async () => {
		const postId = await aPost();
		const creatorsComment = await aCommentOn("post", postId, otherCreatorId);
		const underIt = await aCommentOn("comment", creatorsComment, giverId);
		const payingCreator = await aStickerPaying("comment", underIt, otherCreatorId);
		const payingRoot = await aStickerPaying("comment", creatorsComment, creatorId);

		await hideSubject({
			subjectType: "comment",
			subjectId: creatorsComment,
			adminId,
			reason: "spam",
		});
		expect(await voided(payingCreator), "a reply kept paying the creator who was hidden").toBe(
			true,
		);
		expect(await voided(payingRoot)).toBe(true);

		await restoreSubject({ subjectType: "comment", subjectId: creatorsComment, adminId });
		expect(await voided(payingCreator)).toBe(false);
		expect(await voided(payingRoot)).toBe(false);
	});

	it("leaves a reply paying somebody else alone when an ordinary comment is hidden", async () => {
		const postId = await aPost();
		const ordinary = await aCommentOn("post", postId, giverId);
		const underIt = await aCommentOn("comment", ordinary, otherCreatorId);
		// The reply's money goes to the creator who wrote it, not to the ordinary comment above.
		const payingTheReplysCreator = await aStickerPaying("comment", underIt, otherCreatorId);

		await hideSubject({ subjectType: "comment", subjectId: ordinary, adminId, reason: "spam" });
		expect(
			await voided(payingTheReplysCreator),
			"a hide reached money it never paid, and now routes it somewhere else",
		).toBe(false);
	});

	it("voids a review's Sticker when the review is hidden, and back when it is restored", async () => {
		const workId = await aWork("Reviewed");
		const reviewId = await aReview(workId, giverId);
		const sticker = await aStickerPaying("review", reviewId, creatorId);

		await hideSubject({ subjectType: "review", subjectId: reviewId, adminId, reason: "spam" });
		expect(await voided(sticker), "a hidden review kept paying the Work's creator").toBe(true);

		await restoreSubject({ subjectType: "review", subjectId: reviewId, adminId });
		expect(await voided(sticker)).toBe(false);
	});

	it("voids a review's Sticker when its Work is taken down", async () => {
		const workId = await aWork("Reviewed and taken down");
		const reviewId = await aReview(workId, giverId);
		const sticker = await aStickerPaying("review", reviewId, creatorId);
		const noticeId = await aNotice(workId);

		await takeDownWork({ noticeId, adminId });
		expect(await voided(sticker), "a review kept paying a taken-down Work's creator").toBe(true);

		await restoreWork({ noticeId, adminId });
		expect(await voided(sticker)).toBe(false);
	});
});
