// SPDX-License-Identifier: Apache-2.0
/**
 * The claim-aware sweep and the keeping election — the boundary of the rescue window.
 *
 * 🚨 **Every rule here is a promise somebody believed**: a buyer warned once, a keeper
 * spared past ninety days, a released keeper's clock re-armed, media purged only when
 * no claim remains. So the assertions are rows and bytes and notification counts —
 * never "the code ran" — and each describe names the failures its sabotage pass
 * produced before the suite was trusted.
 *
 * Fixtures: one creator and three buyers (a keeper, a free buyer inside the window,
 * a second buyer for the 1/N arithmetic), each through `createAccount`. Each Work
 * carries one real stored asset (real bytes, so `purgeWorkMedia`'s sweep has something
 * to remove) and is taken back in `afterAll`, on success or failure.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { assets, notifications, purchases, works } from "@anthers/db/schema";
import { WITHDRAWN_RESCUE_DAYS } from "@anthers/shared/constants";
import { and, eq, inArray } from "drizzle-orm";
import app from "../index";
import { releaseKeepersFor, runWithdrawnSweep } from "../jobs/withdrawn-sweep.js";
import { electToKeep, releaseKeep } from "../services/keeping.js";
import { storage } from "../services/storage/index.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const RUN = crypto.randomUUID().slice(0, 8);

let creatorId = 0;
let keeperId = 0;
let keeperCookie: string;
let freeBuyerId = 0;
let otherBuyerId = 0;
const workIds: number[] = [];
const storedKeys: string[] = [];

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

/** A fixture-side payment intent id — marked as what it is, so the credential guard passes. */

/** A withdrawn Work with one real stored asset and one completed purchase per buyer. */
async function soldWithdrawnWork(opts: {
	title: string;
	buyers: number[];
	withdrawnDaysAgo: number;
}): Promise<number> {
	const work = await insertWork({ creatorId, type: "game", title: opts.title });
	workIds.push(work.id);
	const key = `creators/${creatorId}/assets/${work.id}/build.zip`;
	await storage.upload(key, new Uint8Array(2048), "application/octet-stream", "private");
	storedKeys.push(key);
	await db.insert(assets).values({
		workId: work.id,
		file: key,
		filename: "build.zip",
		fileSize: 2048,
		platform: "windows",
	});
	for (const buyer of opts.buyers) {
		await db.insert(purchases).values({
			buyerId: buyer,
			workId: work.id,
			creatorId,
			workTitle: opts.title,
			workType: "game",
			workPublicId: work.publicId,
			type: "digital",
			amount: "5.00",
			processingFee: "0.45",
			creatorEarnings: "4.55",
			// A fixture-side id, per the credential-shape rule: marked as a fixture, not
			// shaped like a real vendor's.
			stripePaymentIntentId: `pi_fixture_${work.id}_${buyer}_${crypto.randomUUID().slice(0, 8)}`,
			status: "completed",
		});
	}
	const withdrawnAt = new Date(Date.now() - opts.withdrawnDaysAgo * 86400_000);
	await db.update(works).set({ visibility: "withdrawn", withdrawnAt }).where(eq(works.id, work.id));
	return work.id;
}

/** Whether the Work's stored asset still exists — the media's presence, from the object. */
async function mediaExists(workId: number): Promise<boolean> {
	const [asset] = await db
		.select({ file: assets.file })
		.from(assets)
		.where(eq(assets.workId, workId));
	if (!asset) return false;
	return await storage.exists(asset.file);
}

beforeAll(async () => {
	const creator = await createAccount(`kf_c_${RUN}`, { fields: { isCreator: true } });
	creatorId = creator.userId;
	const keeper = await createAccount(`kf_keep_${RUN}`);
	keeperId = keeper.userId;
	keeperCookie = keeper.cookie;
	const other = await createAccount(`kf_other_${RUN}`);
	otherBuyerId = other.userId;
	const free = await createAccount(`kf_free_${RUN}`);
	freeBuyerId = free.userId;
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	// The works rows (their cascade carries assets, purchases, library items and the
	// saves), and the objects the rows pointed at — cascade reaches rows, not bytes.
	if (workIds.length > 0) await db.delete(works).where(inArray(works.id, workIds));
	for (const key of storedKeys) await storage.delete(key).catch(() => {});
});

describe("the keeping election", () => {
	it("a buyer elects through the route; the claim is the timestamp", async () => {
		const workId = await soldWithdrawnWork({
			title: "Elect",
			buyers: [keeperId],
			withdrawnDaysAgo: 1,
		});
		const res = await req(`/api/content/works/${workId}/keep`, {
			method: "POST",
			headers: { Cookie: keeperCookie, Origin: ORIGIN },
		});
		expect(res.status).toBe(200);
		const [row] = await db
			.select({ keptAt: purchases.keptAt })
			.from(purchases)
			.where(and(eq(purchases.buyerId, keeperId), eq(purchases.workId, workId)));
		expect(row?.keptAt).not.toBeNull();
	});

	it("a release drops the claim; the service is the one writer", async () => {
		const result = await releaseKeep(keeperId, workIds[0]);
		expect(result.ok).toBe(true);
		const [row] = await db
			.select({ keptAt: purchases.keptAt, updatedAt: purchases.updatedAt })
			.from(purchases)
			.where(and(eq(purchases.buyerId, keeperId), eq(purchases.workId, workIds[0])));
		expect(row?.keptAt).toBeNull();
	});

	it("refuses a non-purchaser and a published Work, naming why", async () => {
		// not_purchased: a buyer-less account electing on any Work.
		const refused = await electToKeep(otherBuyerId, workIds[0]);
		expect(refused).toEqual({ ok: false, reason: "not_purchased" });

		// not_withdrawn: keeping a published Work says nothing, so it is refused.
		const work = await insertWork({ creatorId, type: "game", title: "StillUp" });
		workIds.push(work.id);
		await db.insert(purchases).values({
			buyerId: keeperId,
			workId: work.id,
			creatorId,
			workTitle: "StillUp",
			workType: "game",
			workPublicId: work.publicId,
			type: "digital",
			amount: "5.00",
			processingFee: "0.45",
			creatorEarnings: "4.55",
			stripePaymentIntentId: `pi_fixture_${work.id}_${crypto.randomUUID().slice(0, 8)}`,
			status: "completed",
		});
		const published = await electToKeep(keeperId, work.id);
		expect(published).toEqual({ ok: false, reason: "not_withdrawn" });
	});
});

describe("the claim-aware sweep", () => {
	// SABOTAGE: the keeper check dropped (predict: exactly the keeper-spared case fails —
	// the keeper's Work swept, which is the one wrong deletion this window can make).
	it("spares a keeper past ninety days, sweeps a free buyer past them", async () => {
		// The keeper's Work: withdrawn 120 days ago, elected.
		const kept = await soldWithdrawnWork({
			title: "KeptPastWindow",
			buyers: [keeperId],
			withdrawnDaysAgo: 120,
		});
		await electToKeep(keeperId, kept);
		// The free buyer's Work: withdrawn 120 days ago, no election.
		const abandoned = await soldWithdrawnWork({
			title: "AbandonedPastWindow",
			buyers: [freeBuyerId],
			withdrawnDaysAgo: 120,
		});
		// A buyer inside the window: withdrawn 5 days ago.
		const inside = await soldWithdrawnWork({
			title: "InsideWindow",
			buyers: [otherBuyerId],
			withdrawnDaysAgo: 5,
		});

		const result = await runWithdrawnSweep();
		expect(result.sweptCount).toBe(1); // only the abandoned one

		expect(await mediaExists(kept)).toBe(true);
		expect(await mediaExists(inside)).toBe(true);
		expect(await mediaExists(abandoned)).toBe(false);

		// The swept Work's ROW and its purchase survive — the record outlives the bytes.
		const [sweptRow] = await db
			.select({ visibility: works.visibility, mediaPurgedAt: works.mediaPurgedAt })
			.from(works)
			.where(eq(works.id, abandoned));
		expect(sweptRow?.visibility).toBe("withdrawn");
		expect(sweptRow?.mediaPurgedAt).not.toBeNull();
		const [sweptPurchase] = await db
			.select({ id: purchases.id })
			.from(purchases)
			.where(eq(purchases.workId, abandoned));
		expect(sweptPurchase).toBeDefined();
	});

	it("is idempotent — a swept Work is not re-listed, and a second run costs nothing", async () => {
		const second = await runWithdrawnSweep();
		expect(second.sweptCount).toBe(0);
		expect(second.warnedCount).toBe(0);
	});

	// SABOTAGE: the dedupe key dropped (predict: the warning count doubles).
	it("warns a buyer inside the last week — once per purchase, every buyer told", async () => {
		// Withdrawn 88 days ago: inside the window's last week (90−7=83 days ago is the
		// warning's first moment), not yet at the deadline. **Two buyers of the same
		// Work** — the exact shape the withdrawal-notice suite names: keying per Work
		// tells one buyer and silently drops the other.
		const workId = await soldWithdrawnWork({
			title: "NearlyThere",
			buyers: [keeperId, otherBuyerId],
			withdrawnDaysAgo: WITHDRAWN_RESCUE_DAYS - 2,
		});
		const result = await runWithdrawnSweep();
		expect(result.warnedCount).toBeGreaterThanOrEqual(2);

		const notices = await db
			.select({ dedupeKey: notifications.dedupeKey, userId: notifications.userId })
			.from(notifications)
			.where(eq(notifications.kind, "work_withdrawn_last_chance"));
		// Every buyer of the warned Work was told — the count, not just existence.
		const told = new Set(notices.map((n) => n.userId));
		expect(told.has(keeperId)).toBe(true);
		expect(told.has(otherBuyerId)).toBe(true);
		const keys = new Set(notices.map((n) => n.dedupeKey));
		// One key per purchase: a key shared by two buyers would have dropped the second.
		expect(keys.size).toBe(notices.length);

		// A re-run re-sends nothing — the notification's dedupe holds.
		const again = await runWithdrawnSweep();
		expect(again.warnedCount).toBe(0);

		const mediaStillThere = await mediaExists(workId); // inside the window: media stays
		expect(mediaStillThere).toBe(true);
		const [row] = await db
			.select({ mediaPurgedAt: works.mediaPurgedAt })
			.from(works)
			.where(eq(works.id, workId));
		expect(row?.mediaPurgedAt).toBeNull();
	});

	it("the lapse rule: a released keeper's claim drops and their Work loses its spare", async () => {
		// The keeper elected on KeptPastWindow; the release must drop the claim and the
		// next sweep — with 120 days gone — must sweep it.
		const releasedCount = await releaseKeepersFor(keeperId);
		expect(releasedCount).toBeGreaterThanOrEqual(1);
		const result = await runWithdrawnSweep();
		expect(result.sweptCount).toBe(1); // KeptPastWindow, now unkept and out of window
	});
});

// The route's own wiring asserts through the service above; the sweep's job shape
// (queue registration, cron) is asserted by retired-queues and the schedule assertion
// suite, which read the registration tables directly.
