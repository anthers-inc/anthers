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
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	assets,
	comments,
	dmcaNotices,
	legalHolds,
	mediaQuarantine,
	moderationActions,
	stickers,
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
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const RUN = crypto.randomUUID().slice(0, 8);
/** A cycle no distribution row names, so nothing here reads as settled. */
const CYCLE = "2033-02-01";

let giverId: number;
let creatorId: number;
let adminId: number;
const workIds: number[] = [];
const noticeIds: number[] = [];
const commentIds: number[] = [];
const stickerIds: number[] = [];
const storedKeys: string[] = [];

beforeAll(async () => {
	giverId = (await createAccount(`vr_giver_${RUN}`)).userId;
	creatorId = (await createAccount(`vr_creator_${RUN}`)).userId;
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
		.insert(assets)
		.values({ workId: work.id, file: key, filename: "build.zip", fileSize: 19 });
	return work.id;
}

/** The giver's own comment on a Work, which is what a comment Sticker rides. */
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
