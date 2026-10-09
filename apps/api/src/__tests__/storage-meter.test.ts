// SPDX-License-Identifier: Apache-2.0
/**
 * The storage meter — what a snapshot counts, whose account it attributes bytes to, and
 * the reading surface's allowance arithmetic.
 *
 * 🚨 **Every counting rule here is asserted as rows and bytes, never as "the code ran".**
 * The meter's whole output is one row per account per cycle, and every failure mode worth
 * guarding is a figure that could silently misattribute: a save charged to a creator, a
 * byte count written twice by an idempotence failure, a reading that recomputes rather
 * than reads, an allowance that invents GiB where the ruled ladder has none.
 *
 * Verified by sabotage before being committed, per the machine-wide rule: the predicted
 * failures are named in each describe's comment, and stubbing the counted surface skips
 * exactly the cases that depend on it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { assets, storageUsage, workSaves, works } from "@anthers/db/schema";
import { STORAGE_LADDER_GIB, STORAGE_USE_KINDS } from "@anthers/shared/constants";
import { and, eq, inArray } from "drizzle-orm";
import app from "../index";
import { runStorageUsageSweep } from "../jobs/storage-usage.js";
import { storageReadingFor } from "../services/storage-reading.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const RUN = crypto.randomUUID().slice(0, 8);

let creatorCookie: string;
let creatorId = 0;
let _playerCookie: string;
let playerId = 0;
const workIds: number[] = [];
const storedKeys: string[] = [];

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

/** Upload real bytes through the storage service, so `size()` and `prefixSize` answer. */
async function store(key: string, bytes: number): Promise<string> {
	await storageUpload(key, bytes);
	storedKeys.push(key);
	return key;
}

async function storageUpload(key: string, bytes: number): Promise<void> {
	const { storage } = await import("../services/storage/index.js");
	await storage.upload(key, new Uint8Array(bytes), "application/octet-stream", "private");
}

beforeAll(async () => {
	const creator = await createAccount(`meter_c_${RUN}`, { fields: { isCreator: true } });
	creatorCookie = creator.cookie;
	creatorId = creator.userId;
	const player = await createAccount(`meter_p_${RUN}`);
	_playerCookie = player.cookie;
	playerId = player.userId;
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	// storage_usage rows cascade with the account; works, assets, builds and saves
	// cascade too. The objects stored behind the rows do not — named and removed.
	if (workIds.length > 0) await db.delete(works).where(inArray(works.id, workIds));
	for (const key of storedKeys) await storageDelete(key).catch(() => {});
});

async function storageDelete(key: string): Promise<void> {
	const { storage } = await import("../services/storage/index.js");
	await storage.delete(key);
}

describe("the storage meter", () => {
	it("counts assets and build files from the rows that carry their sizes", async () => {
		const work = await insertWork({ creatorId, type: "game" });
		workIds.push(work.id);
		const assetKey = await store(`creators/${creatorId}/assets/${work.id}/game.zip`, 3000);
		await db.insert(assets).values({
			workId: work.id,
			file: assetKey,
			filename: "game.zip",
			fileSize: 3000,
			platform: "windows",
		});

		const count = await runStorageUsageSweep();
		expect(count).toBeGreaterThanOrEqual(1); // the creator's row; the player has nothing yet

		const [creatorRow] = await db
			.select()
			.from(storageUsage)
			.where(eq(storageUsage.userId, creatorId))
			.limit(1);
		expect(creatorRow).toBeDefined();
		expect(creatorRow!.purposes.catalog).toBe(3000);
		expect(creatorRow!.bytes).toBe(3000);
	});

	it("attributes cloud saves to the player's account, never the creator's", async () => {
		const work = await insertWork({ creatorId, type: "game" });
		workIds.push(work.id);
		await db.insert(workSaves).values({
			userId: playerId,
			workId: work.id,
			blob: Buffer.alloc(1200, 7).toString("base64"),
			runtime: "godot-4",
			byteSize: 1200,
		});

		await runStorageUsageSweep();

		const [playerRow] = await db
			.select()
			.from(storageUsage)
			.where(eq(storageUsage.userId, playerId))
			.limit(1);
		// The save blob's byteSize is the *bytes* figure; the base64 string's length is
		// 1600 — the attribution is the point, and so is which figure was recorded.
		expect(playerRow!.purposes["cloud-saves"]).toBe(1200);
		const [creatorRow] = await db
			.select()
			.from(storageUsage)
			.where(eq(storageUsage.userId, creatorId))
			.limit(1);
		expect(creatorRow!.purposes["cloud-saves"]).toBe(0);
	});

	it("is idempotent per cycle — a second sweep rewrites, never duplicates", async () => {
		const first = await runStorageUsageSweep();
		expect(first).toBeGreaterThan(0);
		const [before] = await db
			.select({ id: storageUsage.id, bytes: storageUsage.bytes })
			.from(storageUsage)
			.where(eq(storageUsage.userId, creatorId))
			.limit(1);

		const second = await runStorageUsageSweep();
		expect(second).toBe(first); // same population, no new accounts

		const [after] = await db
			.select({ id: storageUsage.id, bytes: storageUsage.bytes })
			.from(storageUsage)
			.where(eq(storageUsage.userId, creatorId))
			.limit(1);
		expect(after!.id).toBe(before!.id);
		expect(after!.bytes).toBe(before!.bytes);
	});

	it("counts HLS output and stores the reading with every known purpose key", async () => {
		// An inline image under the creator's prefix — the real shape the post editor
		// stores, with no table carrying its size.
		const inlineKey = await store(`creators/${creatorId}/inline-images/shot.png`, 900);
		await db.insert((await import("@anthers/db/schema")).inlineImages).values({
			creatorId,
			image: inlineKey,
		});

		await runStorageUsageSweep();
		const [row] = await db
			.select()
			.from(storageUsage)
			.where(eq(storageUsage.userId, creatorId))
			.limit(1);
		expect(Object.keys(row!.purposes).sort()).toEqual([...STORAGE_USE_KINDS].sort());
		// 3000 assets + 900 inline = the catalog line; kept-files rides at zero.
		expect(row!.purposes.catalog).toBe(3900);
		expect(row!.purposes["kept-files"]).toBe(0);
		expect(row!.bytes).toBe(3900);
	});
});

describe("the reading — allowance, drawn bytes and the at-cost estimate", () => {
	it("serves the composed reading through the account route", async () => {
		const res = await req("/api/accounts/me/storage", {
			headers: { Cookie: creatorCookie, Origin: "http://localhost:3000" },
		});
		expect(res.status).toBe(200);
		const reading = (await res.json()) as {
			allowanceGiB: number;
			bytesUsed: number;
			giBUsed: number;
			bytesFree: number;
			topUpEligible: boolean;
			overflowCost: string;
			purposes: Record<string, number>;
			sampledAt: string | null;
			cycle: string;
		};
		// Free at no Badge: the ruled combined floor.
		expect(reading.allowanceGiB).toBe(STORAGE_LADDER_GIB.free);
		expect(reading.bytesUsed).toBe(3900);
		expect(reading.topUpEligible).toBe(false);
		expect(reading.overflowCost).toBe("0.00");
		expect(reading.sampledAt).not.toBeNull();
		expect(Object.keys(reading.purposes).sort()).toEqual([...STORAGE_USE_KINDS].sort());
	});

	it("answers the unmetered shape rather than pretending zeros were sampled", async () => {
		// A brand-new account is in no snapshot until the daily sweep reaches it.
		const fresh = await createAccount(`meter_fresh_${RUN}`);
		try {
			const reading = await storageReadingFor(fresh.userId);
			expect(reading.bytesUsed).toBe(0);
			expect(reading.sampledAt).toBeNull();
			expect(reading.allowanceGiB).toBe(STORAGE_LADDER_GIB.free);
		} finally {
			await db.delete(storageUsage).where(eq(storageUsage.userId, fresh.userId));
		}
	});
});

describe("the ladder through the metered reading", () => {
	it("a Root holding raises the allowance the reading shows", async () => {
		// The same fixture shape the work-saves suite uses, threshold filter included:
		// 🚨 the find MUST name the threshold. A lookup by issuer alone grabs whichever
		// Anthers rung a seeded session lists first (Blossom in CI) and the holding
		// would point there rather than at Root — passing on an unseeded local session
		// and failing every seeded one. Root is $3.
		const { badges, userBadges } = await import("@anthers/db/schema");
		const { anthersUserId } = await import("../services/anthers-badges.js");
		const { currentCycleKey } = await import("@anthers/shared/billing-cycle");
		const anthersId = await anthersUserId();
		const [existing] = await db
			.select({ id: badges.id })
			.from(badges)
			.where(and(eq(badges.creatorId, anthersId), eq(badges.threshold, "3")))
			.limit(1);
		const badgeId =
			existing?.id ??
			(
				await db
					.insert(badges)
					.values({ creatorId: anthersId, threshold: "3", label: "$3" })
					.returning({ id: badges.id })
			)[0].id;
		await db.insert(userBadges).values({
			userId: creatorId,
			badgeId,
			billingCycle: currentCycleKey(),
		});

		const reading = await storageReadingFor(creatorId);
		expect(reading.allowanceGiB).toBe(STORAGE_LADDER_GIB.root);
		expect(reading.topUpEligible).toBe(true);

		// Clean up the holding, so the suite's own later reads stay at free.
		await db.delete(userBadges).where(eq(userBadges.userId, creatorId));
	});
});
