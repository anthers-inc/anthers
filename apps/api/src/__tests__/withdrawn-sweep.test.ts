// SPDX-License-Identifier: Apache-2.0
/**
 * The preservation program and the withdrawn-Work sweep — the boundary of what Anthers keeps.
 *
 * 🚨 **Every rule here is a promise somebody believed.** A Work anybody saved is kept
 * indefinitely, whatever its creator does; a Work nobody saved has no buyer to protect and
 * its bytes go; and three things — a copyright takedown, a child-safety quarantine, a legal
 * hold — outrank the program. So the assertions are rows and bytes, never "the code ran".
 *
 * The design this replaced (the keeping election, the ninety-day clock, the last-chance
 * warning) is gone, and its tests with it. What survives as a test is the rule that made it
 * worth replacing: **the buyer's copy does not depend on the buyer doing anything.**
 *
 * Fixtures: one creator and three buyers through `createAccount`. Each Work carries one real
 * stored asset (real bytes, so `purgeWorkMedia`'s sweep has something to remove) and is
 * taken back in `afterAll`, on success or failure.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	purchases,
	userLibraryItems,
	workAssets,
	workMediaVersions,
	works,
} from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import { runWithdrawnSweep } from "../jobs/withdrawn-sweep.js";
import { placeHold } from "../services/legal-hold.js";
import { removeItem, saveOnPurchase, saveWork } from "../services/library.js";
import { projectLibraryItem } from "../services/space-projection.js";
import { storage } from "../services/storage/index.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const RUN = crypto.randomUUID().slice(0, 8);

let creatorId = 0;
let buyerId = 0;
let otherBuyerId = 0;
const workIds: number[] = [];
const storedKeys: string[] = [];

/** A Withdrawn Work carrying one real stored asset, with nobody having saved it. */
async function withdrawnWork(opts: { title: string; withdrawnDaysAgo?: number }): Promise<number> {
	const work = await insertWork({ creatorId, type: "game", title: opts.title });
	workIds.push(work.id);
	const key = `creators/${creatorId}/assets/${work.id}/build.zip`;
	await storage.upload(key, new Uint8Array(2048), "application/octet-stream", "private");
	storedKeys.push(key);
	await db.insert(workAssets).values({
		workId: work.id,
		file: key,
		filename: "build.zip",
		fileSize: 2048,
		platform: "windows",
	});
	const withdrawnAt = new Date(Date.now() - (opts.withdrawnDaysAgo ?? 1) * 86400_000);
	await db.update(works).set({ visibility: "withdrawn", withdrawnAt }).where(eq(works.id, work.id));
	return work.id;
}

/** A Withdrawn Work somebody bought — the purchase is what puts it in the program. */
async function soldWork(opts: { title: string; buyer: number; withdrawnDaysAgo: number }) {
	const workId = await withdrawnWork(opts);
	const [work] = await db
		.select({ publicId: works.publicId })
		.from(works)
		.where(eq(works.id, workId));
	await db.insert(purchases).values({
		buyerId: opts.buyer,
		workId,
		creatorId,
		workTitle: opts.title,
		workType: "game",
		workPublicId: work!.publicId,
		type: "digital",
		amount: "5.00",
		processingFee: "0.45",
		creatorEarnings: "4.55",
		// Fixture-side id: marked as one, so the credential-shape guard passes.
		stripePaymentIntentId: `pi_fixture_${workId}_${crypto.randomUUID().slice(0, 8)}`,
		status: "completed",
	});
	// The purchase's own library save is what the checkout calls; doing it here keeps the
	// fixture on the same path production takes rather than setting the flag by hand.
	await saveOnPurchase({ buyerId: opts.buyer, workId });
	return workId;
}

async function preserved(workId: number): Promise<boolean> {
	const [row] = await db
		.select({ preserved: works.preserved })
		.from(works)
		.where(eq(works.id, workId));
	return row?.preserved === true;
}

/** Whether the Work's stored asset still exists — the media's presence, from the object. */
async function mediaExists(workId: number): Promise<boolean> {
	const [asset] = await db
		.select({ file: workAssets.file })
		.from(workAssets)
		.where(eq(workAssets.workId, workId));
	if (!asset) return false;
	return await storage.exists(asset.file);
}

beforeAll(async () => {
	const creator = await createAccount(`pf_c_${RUN}`, { fields: { creatorMode: true } });
	creatorId = creator.userId;
	const buyer = await createAccount(`pf_b_${RUN}`);
	buyerId = buyer.userId;
	const other = await createAccount(`pf_o_${RUN}`);
	otherBuyerId = other.userId;
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	if (workIds.length > 0) await db.delete(works).where(inArray(works.id, workIds));
	for (const key of storedKeys) await storage.delete(key).catch(() => {});
});

describe("coming into the program", () => {
	it("a purchase puts the Work in it, because a purchase saves itself to the Library", async () => {
		const work = await insertWork({ creatorId, type: "game", title: "BoughtAndSaved" });
		workIds.push(work.id);
		expect(await preserved(work.id)).toBe(false);

		await saveOnPurchase({ buyerId, workId: work.id });

		expect(await preserved(work.id)).toBe(true);
	});

	// SABOTAGE: the keeper dropped from `preserveCurrentVersion` (predict: the creator's own
	// draft is flagged, both disposal doors withdraw it, and the draft can never be deleted).
	it("a creator keeping their own Work does not put it in it", async () => {
		const draft = await insertWork({
			creatorId,
			type: "game",
			title: "DraftTheirOwn",
			visibility: "private",
		});
		workIds.push(draft.id);
		expect(await preserved(draft.id)).toBe(false);

		// `saveWork` admits this deliberately: a creator may keep their own unreleased Work.
		const saved = await saveWork(creatorId, draft.id);
		expect(saved.ok).toBe(true);

		// ⭐ **Somebody else is what the program keeps.** The flag has to mean the Work was
		// released and kept by a person other than its maker, or "preserved" would describe
		// every draft its author pressed Save on.
		expect(await preserved(draft.id)).toBe(false);
	});

	it("a space projecting a Library applies the same keeper rule as a save", async () => {
		// The third door into the Library. A rebuild from a reader's space is still somebody
		// keeping a Work, and the creator projecting their own entry is still not.
		const own = await insertWork({ creatorId, type: "game", title: "ProjectedOwn" });
		workIds.push(own.id);
		await projectLibraryItem(creatorId, {
			subject: { kind: "work", id: own.id, uri: null },
			hidden: false,
			sortOrder: 0,
			savedAt: new Date(),
		});
		expect(await preserved(own.id)).toBe(false);

		const theirs = await insertWork({ creatorId, type: "game", title: "ProjectedTheirs" });
		workIds.push(theirs.id);
		await projectLibraryItem(otherBuyerId, {
			subject: { kind: "work", id: theirs.id, uri: null },
			hidden: false,
			sortOrder: 0,
			savedAt: new Date(),
		});
		expect(await preserved(theirs.id)).toBe(true);
	});

	it("a manual save puts the Work in it, and unsaving does not take it out", async () => {
		const work = await insertWork({ creatorId, type: "game", title: "SavedByHand" });
		workIds.push(work.id);
		expect(await preserved(work.id)).toBe(false);

		const saved = await saveWork(otherBuyerId, work.id);
		expect(saved.ok).toBe(true);
		expect(await preserved(work.id)).toBe(true);

		// ⭐ **The write is one-way.** A Library entry can be removed, but a Work Anthers has
		// undertaken to keep is not un-kept by somebody tidying their library.
		const [item] = await db
			.select({ id: userLibraryItems.id })
			.from(userLibraryItems)
			.where(eq(userLibraryItems.userId, otherBuyerId));
		expect(item).toBeDefined();
		await removeItem(otherBuyerId, item!.id);
		expect(await preserved(work.id)).toBe(true);
	});
});

describe("the sweep's one question", () => {
	it("keeps what the program holds, and purges what nobody saved", async () => {
		const kept = await soldWork({ title: "KeptForever", buyer: buyerId, withdrawnDaysAgo: 400 });
		const abandoned = await withdrawnWork({ title: "NobodySaved", withdrawnDaysAgo: 400 });

		const result = await runWithdrawnSweep();

		expect(await mediaExists(kept)).toBe(true);
		expect(await mediaExists(abandoned)).toBe(false);
		expect(result.sweptCount).toBe(1);
		expect(result.keptCount).toBe(0);

		// The purged Work's ROW survives — the record outlives the bytes.
		const [row] = await db
			.select({ visibility: works.visibility, mediaPurgedAt: works.mediaPurgedAt })
			.from(works)
			.where(eq(works.id, abandoned));
		expect(row?.visibility).toBe("withdrawn");
		expect(row?.mediaPurgedAt).not.toBeNull();
	});

	// SABOTAGE: the sweep reading only `works.preserved` (predict: this Work's media is
	// purged even though an archived version of it is flagged, which is the promise read
	// one version too narrowly).
	it("keeps a Work because an ARCHIVED version is preserved", async () => {
		const workId = await withdrawnWork({ title: "OldVersionKept", withdrawnDaysAgo: 400 });
		// The current version is not flagged; a retired one is — the shape a Work takes
		// when preservation was granted before a replacement retired the version.
		await db.insert(workMediaVersions).values({
			workId,
			uploadedAt: new Date(Date.now() - 500 * 86400_000),
			versionLabel: "the one somebody saved",
			preserved: true,
			media: {
				kind: "set",
				files: [
					{
						filename: "old.zip",
						file: "creators/0/old.zip",
						fileSize: 10,
						mimeType: "application/zip",
					},
				],
			},
		});

		await runWithdrawnSweep();

		expect(await mediaExists(workId)).toBe(true);
	});

	it("is idempotent — a swept Work is not re-listed, and a second run costs nothing", async () => {
		const second = await runWithdrawnSweep();
		expect(second.sweptCount).toBe(0);
		expect(second.keptCount).toBe(0);
	});

	// SABOTAGE: the sweep keying on "nobody bought it" instead of the flag (predict: a saved
	// free Work is purged, which is the whole case the program was extended to cover).
	it("keeps a Work nobody bought because somebody saved it", async () => {
		const saved = await withdrawnWork({ title: "SavedNotSold", withdrawnDaysAgo: 400 });
		expect(await saveWork(otherBuyerId, saved)).toMatchObject({ ok: true });

		await runWithdrawnSweep();

		expect(await mediaExists(saved)).toBe(true);
		const [row] = await db
			.select({ mediaPurgedAt: works.mediaPurgedAt })
			.from(works)
			.where(eq(works.id, saved));
		expect(row?.mediaPurgedAt).toBeNull();
	});

	// SABOTAGE: the override dropped from the candidate query (predict: the preserved Work
	// stays, and a takedown's bytes outlive the act that took them).
	it("purges a preserved Work the law or a quarantine has taken", async () => {
		const taken = await soldWork({ title: "TakenDown", buyer: buyerId, withdrawnDaysAgo: 10 });
		await db.update(works).set({ takedownStatus: "taken_down" }).where(eq(works.id, taken));

		const quarantined = await soldWork({
			title: "Quarantined",
			buyer: otherBuyerId,
			withdrawnDaysAgo: 10,
		});
		await db
			.update(works)
			.set({ quarantineStatus: "quarantined" })
			.where(eq(works.id, quarantined));

		await runWithdrawnSweep();

		expect(await mediaExists(taken)).toBe(false);
		expect(await mediaExists(quarantined)).toBe(false);
	});

	// SABOTAGE: the hold check dropped (predict: a held Work's bytes are purged, which is
	// the one unrecoverable thing a retention sweep can do).
	it("defers to a legal hold, preserved or not", async () => {
		const held = await withdrawnWork({ title: "UnderHold", withdrawnDaysAgo: 30 });
		await placeHold({
			subjectType: "work",
			subjectId: held,
			reason: "Fixture: a preservation duty outranks the sweep.",
			note: "withdrawn-sweep fixture",
		});

		await runWithdrawnSweep();

		expect(await mediaExists(held)).toBe(true);
		const [row] = await db
			.select({ mediaPurgedAt: works.mediaPurgedAt })
			.from(works)
			.where(eq(works.id, held));
		expect(row?.mediaPurgedAt).toBeNull();
	});
});

// The sweep's job shape (queue registration, cron) is asserted by retired-queues and the
// schedule assertion suite, which read the registration tables directly.
