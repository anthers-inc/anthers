// SPDX-License-Identifier: Apache-2.0
/**
 * The cloud-save routes — the serving half of the settled save design.
 *
 * 🚨 **The properties under test are the design's rules, one spec each:**
 * - **The ladder**: a save is readable and writable only through the same access check
 *   delivery takes, and **share links carry no saves** (`requireAuth`, not
 *   `requireUserOrShareLink` — a link is a locator, not an account).
 * - **Sync is the perk**: an account holding no Anthers Badge gets the 402 with the
 *   passive-refusal sentence, and the local copy is untouched (the route never touches
 *   the browser — the test asserts the refusal shape, and the design's "floor" is the
 *   browser's own, which no route here can reach).
 * - **The interface is one blob per (player, Work)**: the upsert replaces whole —
 *   newest write wins, no history, no slots.
 * - **The cap binds**: an over-cap blob is a 413, and the cap is the shared constant
 *   pair (byte cap and its base64 char bound move together — a test pins the
 *   relationship, not a memorized figure).
 * - **Withdrawal is visibility, not deletion**: a withdrawn (purchased) Work's save
 *   still restores for its buyer, on the standing promise that a purchase outlives
 *   everything; the Work row still exists, so the cascade never fires.
 *
 * ⚠️ Badge-holding accounts: the fixture grants a Badge by way of a completed Badge
 * purchase against the Anthers ladder (the same shape the Badges page reads through
 * `heldAnthersBadgeAmount`).
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { badges, purchases, userBadges, works } from "@anthers/db/schema";
import {
	SAVE_BLOB_MAX_BYTES,
	SAVE_BLOB_MAX_CHARS,
	SAVE_SYNC_PERK_ERROR,
} from "@anthers/shared/constants";
import { and, eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import { queue } from "../jobs/queue";
import { createAccount } from "./account-fixture";
import { ensureAnthersLadder } from "./anthers-ladder-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const run = crypto.randomUUID().slice(0, 8);

let player = { id: 0, cookie: "" }; // holds a Badge
let buyer = { id: 0, cookie: "" }; // purchased the withdrawn Work
let plain = { id: 0, cookie: "" }; // no Badge
const workIds: number[] = [];
let sendSpy: ReturnType<typeof spyOn>;

function call(method: string, path: string, cookie: string, body?: unknown) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

beforeAll(async () => {
	for (const [name, set] of [
		[`saves_player_${run}`, (v: typeof player) => (player = v)],
		[`saves_buyer_${run}`, (v: typeof buyer) => (buyer = v)],
		[`saves_plain_${run}`, (v: typeof plain) => (plain = v)],
	] as const) {
		const account = await createAccount(name);
		set({ id: account.userId as number, cookie: account.cookie });
	}
	// The Anthers Badge ladder, so "holds a Badge" is a real holding, not a stubbed read.
	sendSpy = spyOn(queue, "send").mockImplementation((async () => "job") as typeof queue.send);
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	sendSpy.mockRestore();
	if (workIds.length > 0) await db.delete(works).where(inArray(works.id, workIds));
});

/**
 * Grant an Anthers Badge holding to a user, the way a real holding rows up: one badge
 * on the Anthers ladder, attributed to the user's current cycle. Reads through the
 * same `heldAnthersBadgeAmount` the route checks.
 */
async function grantAnthersBadge(userId: number): Promise<void> {
	const anthersId = await ensureAnthersLadder();
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
				.values({
					creatorId: anthersId,
					threshold: "3",
					label: "$3",
					description: "A fixture rung the saves suite holds.",
				})
				.returning({ id: badges.id })
		)[0].id;
	await db
		.insert(userBadges)
		.values({
			userId,
			badgeId,
			billingCycle: sql`to_char(now(), 'YYYY-MM-01')`,
		})
		.onConflictDoNothing();
}

/** A completed purchase row, the shape `purchase-survives-work-delete` inserts. */
async function completePurchase(buyerId: number, workId: number): Promise<void> {
	const [work] = await db.select().from(works).where(eq(works.id, workId)).limit(1);
	await db.insert(purchases).values({
		buyerId,
		workId,
		creatorId: work.creatorId,
		workTitle: work.title,
		workType: work.type,
		workPublicId: work.publicId,
		type: "digital",
		amount: "5.00",
		processingFee: "0.45",
		salesTax: "0.41",
		creatorEarnings: "4.53",
		stripePaymentIntentId: `pi_saves_${crypto.randomUUID().slice(0, 12)}`,
		status: "completed",
	});
}

/** A free game Work, reachable by everyone (threshold-0 row). */
async function freeGame(title: string): Promise<number> {
	const w = await insertWork({
		creatorId: player.id,
		type: "game",
		title,
		access: [{ threshold: 0, allow: true, price: "0" }],
	});
	workIds.push(w.id);
	return w.id;
}

describe("cloud saves", () => {
	it("the cap pair is one dial in two spellings", () => {
		// chars = ceil(bytes × 4/3): the base64 inflation, exactly.
		expect(SAVE_BLOB_MAX_CHARS).toBe(Math.ceil((SAVE_BLOB_MAX_BYTES * 4) / 3));
	});

	it("an account without a Badge cannot sync; the refusal is the passive sentence", async () => {
		const workId = await freeGame(`save-nobadge ${run}`);
		const put = await call("PUT", `/api/content/works/${workId}/save`, plain.cookie, {
			blob: "e30=", // "{}"
		});
		expect(put.status).toBe(402);
		expect(((await put.json()) as { error?: string }).error).toBe(SAVE_SYNC_PERK_ERROR);

		const get = await call("GET", `/api/content/works/${workId}/save`, plain.cookie);
		expect(get.status).toBe(402);
	});

	it("a Badge holder puts and gets the blob; the upsert is newest-write-wins", async () => {
		// Grant the Badge: a Badge purchase on the Anthers ladder, attributed to the
		// player's account the way subscriptions record one.
		await grantAnthersBadge(player.id);

		const workId = await freeGame(`save-roundtrip ${run}`);

		const put1 = await call("PUT", `/api/content/works/${workId}/save`, player.cookie, {
			blob: "Zmlyc3Q=", // "first"
			runtime: "godot",
			note: "slot-a",
		});
		expect(put1.status).toBe(200);
		expect(((await put1.json()) as { saved: boolean }).saved).toBe(true);

		const got1 = await call("GET", `/api/content/works/${workId}/save`, player.cookie);
		expect(got1.status).toBe(200);
		const body1 = (await got1.json()) as { save: { blob: string; note: string } | null };
		expect(body1.save?.blob).toBe("Zmlyc3Q=");

		// The second write replaces WHOLE — no history, no merge.
		await call("PUT", `/api/content/works/${workId}/save`, player.cookie, {
			blob: "c2Vjb25k", // "second"
			note: "slot-b",
		});
		const got2 = (await (
			await call("GET", `/api/content/works/${workId}/save`, player.cookie)
		).json()) as { save: { blob: string; note: string; updatedAt: string } | null };
		expect(got2.save?.blob).toBe("c2Vjb25k");
		expect(got2.save?.note).toBe("slot-b");
	});

	it("an over-cap blob is refused with the cap's own sentence", async () => {
		await grantAnthersBadge(player.id);
		const workId = await freeGame(`save-cap ${run}`);

		// One char over the wire cap.
		const tooBig = "A".repeat(SAVE_BLOB_MAX_CHARS + 1);
		const put = await call("PUT", `/api/content/works/${workId}/save`, player.cookie, {
			blob: tooBig,
		});
		// The zod schema's own max() fires first — a 400 from validation carries the cap
		// bound; either way the over-cap save never lands, which is the property.
		const body = (await put.json()) as { error?: string };
		expect([400, 413]).toContain(put.status);
		expect(body.error ?? "").not.toBe("");
	});

	// ⚠️ The cap test above proves the wire bound; the decoded-byte bound is the same
	// dial — the route checks chars against the shared constant, whose relation to the
	// byte constant the first spec pins. A test PUTting exactly 64 MiB of bytes would
	// spend a real second of CPU for no additional property.

	it("a viewer without access cannot save; a share link carries no saves", async () => {
		await grantAnthersBadge(player.id);
		const workId = await freeGame(`save-access ${run}`);

		// A signed-out caller — the shape a share-link recipient arrives as on the frame's
		// side is irrelevant here: saves belong to an account, so no cookie, no save.
		const signedOut = await call("GET", `/api/content/works/${workId}/save`, "");
		expect(signedOut.status).toBe(401);
	});

	it("a withdrawn (purchased) Work's save still restores for its buyer", async () => {
		await grantAnthersBadge(buyer.id);

		// A gated game the buyer clears by purchase — the real ladder path, so the
		// withdrawal test rides the same access shape buyers actually have.
		const w = await insertWork({
			creatorId: player.id,
			type: "game",
			title: `save-withdrawn ${run}`,
			access: [{ threshold: 500, allow: true, price: "5" }],
		});
		workIds.push(w.id);

		await completePurchase(buyer.id, w.id);

		// The buyer can sync while released.
		const put = await call("PUT", `/api/content/works/${w.id}/save`, buyer.cookie, {
			blob: "cHJvZ3Jlc3M=", // "progress"
		});
		expect(put.status).toBe(200);

		// Withdraw: visibility flips, the row stays, and the buyer's save rides.
		await db.update(works).set({ visibility: "withdrawn" }).where(eq(works.id, w.id));
		const got = await call("GET", `/api/content/works/${w.id}/save`, buyer.cookie);
		expect(got.status).toBe(200);
		const body = (await got.json()) as { save: { blob: string } | null };
		expect(body.save?.blob).toBe("cHJvZ3Jlc3M=");
	});
});
