// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Library: what a user has kept, and the one property that must never bend.
 *
 * 🚨 **Saving grants nothing.** The Library became a place a user can put *free* content on
 * 2026-08-13, which means for the first time there is a row saying "this Work is mine" that
 * is NOT a purchase. If `resolveAccess` ever learned to read it, Save would be a free
 * unlock button — the worst defect this platform could ship, and one that would look like a
 * feature working. The first test here is that, and it is written from the *access*
 * endpoint rather than from the resolver, so it fails whatever layer the mistake is made in.
 *
 * The rest covers the two rules that look like details:
 *
 *   - **A purchased Work cannot be removed, only hidden.** Somebody who tidies a purchase
 *     off their shelf and can't work out how to get it back has effectively lost what they
 *     paid for. Hide is reversible; unsave would be a black hole with a friendly label.
 *   - **Permanence is derived, never stored.** There is no `source` column: a row is
 *     permanent exactly while a completed purchase exists, so a refund releases it with
 *     nothing to keep in step.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { libraryItems, purchases, works } from "@anthers/db/schema";
import { and, eq, sql } from "drizzle-orm";
import app from "../index";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `lib_c_${id}`;
const readerName = `lib_r_${id}`;

/** Free to everyone — the commons, and the case the Library exists to be able to hold. */
const FREE = [{ threshold: 0, allow: true, price: "0" }];
/** Behind two Seeds given to the creator, which the reader never gives. */
const GATED = [
	{ threshold: 0, allow: false, price: "0" },
	{ threshold: 2, allow: true, price: "0" },
];

let creatorAuth: Record<string, string>;
let readerAuth: Record<string, string>;
let readerCookie: string;
let readerId = 0;
let creatorId = 0;

let freeWorkId = 0;
let gatedWorkId = 0;
let boughtWorkId = 0;
let privateWorkId = 0;

async function signUp(username: string): Promise<{ cookie: string; userId: number }> {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({
			username,
			email: `${username}@example.com`,
			password: "testpass123",
			acceptTerms: true,
		}),
	});
	expect(res.status).toBe(201);
	const cookie = res.headers.get("Set-Cookie")!.split(";")[0];
	return { cookie, userId: (await res.json()).user.id as number };
}

async function makeWork(title: string, access: unknown, released = true): Promise<number> {
	const created = await req("/api/content/works", {
		method: "POST",
		headers: creatorAuth,
		body: JSON.stringify({ type: "audio", title }),
	});
	expect(created.status).toBe(201);
	const workId = (await created.json()).work.id as number;
	const patched = await req(`/api/content/works/${workId}`, {
		method: "PATCH",
		headers: creatorAuth,
		body: JSON.stringify({
			seedAccess: access,
			streamEnabled: true,
			...(released ? { visibility: "released" } : {}),
		}),
	});
	expect(patched.status).toBe(200);
	return workId;
}

/** The reader's shelf. `hidden` includes the tidied-away entries. */
async function shelf(opts: { hidden?: boolean } = {}) {
	const res = await req(`/api/content/library${opts.hidden ? "?hidden=1" : ""}`, {
		headers: { Cookie: readerCookie },
	});
	expect(res.status).toBe(200);
	return (await res.json()).items as {
		id: number;
		kind: string;
		hidden: boolean;
		purchased: boolean;
		work?: { id: number; access: { canAccess: boolean } };
	}[];
}

async function save(body: Record<string, number>) {
	return req("/api/content/library", {
		method: "POST",
		headers: readerAuth,
		body: JSON.stringify(body),
	});
}

/** Whether the reader can actually open a Work, asked at the endpoint that gates bytes. */
async function canOpen(workId: number): Promise<boolean> {
	const res = await req(`/api/content/works/${workId}`, { headers: { Cookie: readerCookie } });
	expect(res.status).toBe(200);
	return (await res.json()).work.access.canAccess as boolean;
}

describe("the Library", () => {
	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${readerName})`);
		const creator = await signUp(creatorName);
		const reader = await signUp(readerName);
		creatorId = creator.userId;
		readerId = reader.userId;
		readerCookie = reader.cookie;
		creatorAuth = { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creator.cookie };
		readerAuth = { "Content-Type": "application/json", Origin: ORIGIN, Cookie: reader.cookie };

		freeWorkId = await makeWork(`Free ${id}`, FREE);
		gatedWorkId = await makeWork(`Gated ${id}`, GATED);
		boughtWorkId = await makeWork(`Bought ${id}`, GATED);
		privateWorkId = await makeWork(`Private ${id}`, FREE, false);

		// A completed purchase, written directly: this file is about the Library, and
		// driving Stripe would test the checkout route instead. The auto-save hook is
		// covered separately, below, by calling the service the webhook calls.
		await db.insert(purchases).values({
			buyerId: readerId,
			workId: boughtWorkId,
			creatorId,
			type: "digital",
			amount: "5.00",
			processingFee: "0.45",
			deliveryFee: "0.00",
			crfFee: "0.00",
			salesTax: "0.00",
			creatorEarnings: "4.55",
			stripePaymentIntentId: `pi_lib_${id}`,
			status: "completed",
		});
	}, DB_SETUP_TIMEOUT);

	// ── The property everything else rests on ──────────────────────────────────

	it("🚨 saving a Work grants NO access to it", async () => {
		// Gated, and the reader holds no Seeds — so this is denied before and must be
		// denied after. Asked at the Work endpoint rather than of `resolveAccessSync`, so
		// a mistake made in a route rather than in the resolver still fails here.
		expect(await canOpen(gatedWorkId)).toBe(false);

		const saved = await save({ workId: gatedWorkId });
		expect(saved.status).toBe(201);

		expect(await canOpen(gatedWorkId)).toBe(false);
		// And the shelf reports it honestly rather than hiding the awkward case: it IS on
		// the shelf, and it is NOT openable.
		const items = await shelf();
		const entry = items.find((i) => i.work?.id === gatedWorkId);
		expect(entry, "the gated Work should be on the shelf").toBeTruthy();
		expect(entry?.work?.access.canAccess).toBe(false);
	});

	// ── Saving ─────────────────────────────────────────────────────────────────

	it("keeps a free Work — the whole reason this table exists", async () => {
		const res = await save({ workId: freeWorkId });
		expect(res.status).toBe(201);
		const items = await shelf();
		expect(items.some((i) => i.work?.id === freeWorkId)).toBe(true);
		// Free means free: kept, and openable, and NOT a purchase.
		expect(items.find((i) => i.work?.id === freeWorkId)?.purchased).toBe(false);
	});

	it("is idempotent — pressing Save twice is not an error", async () => {
		expect((await save({ workId: freeWorkId })).status).toBe(201);
		const items = await shelf();
		expect(items.filter((i) => i.work?.id === freeWorkId)).toHaveLength(1);
	});

	it("refuses a Work that hasn't been released", async () => {
		const res = await save({ workId: privateWorkId });
		expect(res.status).toBe(404);
	});

	it("refuses a request naming both a Work and a Project, or neither", async () => {
		expect((await save({ workId: freeWorkId, projectId: 1 })).status).toBe(400);
		expect((await save({})).status).toBe(400);
	});

	// ── Purchases are permanent ────────────────────────────────────────────────

	it("shows a purchase as purchased, derived from the purchase itself", async () => {
		// Nothing wrote a "this was bought" flag — `purchases` is read back on every
		// request, which is why a refund can release it with no sweep.
		const { saveOnPurchase } = await import("../services/library.js");
		await saveOnPurchase({ buyerId: readerId, workId: boughtWorkId, type: "digital" });

		const entry = (await shelf()).find((i) => i.work?.id === boughtWorkId);
		expect(entry, "a completed purchase should be on the shelf").toBeTruthy();
		expect(entry?.purchased).toBe(true);
	});

	it("refuses to remove a purchased Work, and says what to do instead", async () => {
		const entry = (await shelf()).find((i) => i.work?.id === boughtWorkId);
		const res = await req(`/api/content/library/${entry?.id}`, {
			method: "DELETE",
			headers: readerAuth,
		});
		expect(res.status).toBe(409);
		expect((await res.json()).reason).toBe("purchased");
		// Still there — the refusal is not a soft failure.
		expect((await shelf()).some((i) => i.work?.id === boughtWorkId)).toBe(true);
	});

	it("lets a purchased Work be hidden and brought back", async () => {
		const entry = (await shelf()).find((i) => i.work?.id === boughtWorkId);

		const hide = await req(`/api/content/library/${entry?.id}`, {
			method: "PATCH",
			headers: readerAuth,
			body: JSON.stringify({ hidden: true }),
		});
		expect(hide.status).toBe(200);

		expect((await shelf()).some((i) => i.work?.id === boughtWorkId)).toBe(false);
		// Hidden, never gone: the toggle finds it, which is what makes hiding safe.
		expect((await shelf({ hidden: true })).some((i) => i.work?.id === boughtWorkId)).toBe(true);

		const show = await req(`/api/content/library/${entry?.id}`, {
			method: "PATCH",
			headers: readerAuth,
			body: JSON.stringify({ hidden: false }),
		});
		expect(show.status).toBe(200);
		expect((await shelf()).some((i) => i.work?.id === boughtWorkId)).toBe(true);
	});

	it("a refund releases the entry, because permanence was never stored", async () => {
		await db
			.update(purchases)
			.set({ status: "refunded" })
			.where(and(eq(purchases.buyerId, readerId), eq(purchases.workId, boughtWorkId)));

		const entry = (await shelf()).find((i) => i.work?.id === boughtWorkId);
		expect(entry?.purchased, "a refunded purchase is no longer permanent").toBe(false);

		const res = await req(`/api/content/library/${entry?.id}`, {
			method: "DELETE",
			headers: readerAuth,
		});
		expect(res.status).toBe(204);

		// Put it back for anything that runs after.
		await db
			.update(purchases)
			.set({ status: "completed" })
			.where(and(eq(purchases.buyerId, readerId), eq(purchases.workId, boughtWorkId)));
	});

	// ── Removing what you merely saved ─────────────────────────────────────────

	it("removes a freely-saved Work outright — there is nothing to protect", async () => {
		const entry = (await shelf()).find((i) => i.work?.id === freeWorkId);
		const res = await req(`/api/content/library/${entry?.id}`, {
			method: "DELETE",
			headers: readerAuth,
		});
		expect(res.status).toBe(204);
		expect((await shelf()).some((i) => i.work?.id === freeWorkId)).toBe(false);
	});

	it("saving something you had hidden brings it back rather than doing nothing", async () => {
		await save({ workId: freeWorkId });
		const entry = (await shelf()).find((i) => i.work?.id === freeWorkId);
		await req(`/api/content/library/${entry?.id}`, {
			method: "PATCH",
			headers: readerAuth,
			body: JSON.stringify({ hidden: true }),
		});
		expect((await shelf()).some((i) => i.work?.id === freeWorkId)).toBe(false);

		// Pressing Save on something you tidied away plainly means "put it back". Without
		// this the button appears to do nothing and the item stays invisible.
		expect((await save({ workId: freeWorkId })).status).toBe(201);
		expect((await shelf()).some((i) => i.work?.id === freeWorkId)).toBe(true);
	});

	// ── A shelf is not an owner ────────────────────────────────────────────────

	it("keeps a Work on the shelf when its creator gates it afterwards", async () => {
		// The case that only exists because free content can be saved at all: you kept
		// something free, and the creator later put it behind a gate. It stays yours to
		// see on the shelf, and stops being yours to open. Both halves matter.
		const laterGated = await makeWork(`Later gated ${id}`, FREE);
		expect((await save({ workId: laterGated })).status).toBe(201);
		expect(await canOpen(laterGated)).toBe(true);

		await db.update(works).set({ seedAccess: GATED }).where(eq(works.id, laterGated));

		expect(await canOpen(laterGated)).toBe(false);
		const entry = (await shelf()).find((i) => i.work?.id === laterGated);
		expect(entry, "it should still be on the shelf").toBeTruthy();
		expect(entry?.work?.access.canAccess).toBe(false);
	});

	it("never shows one user another user's shelf", async () => {
		const res = await req("/api/content/library", { headers: creatorAuth });
		expect(res.status).toBe(200);
		const items = (await res.json()).items as { id: number }[];
		const mine = await db
			.select({ id: libraryItems.id })
			.from(libraryItems)
			.where(eq(libraryItems.userId, readerId));
		const mineIds = new Set(mine.map((m) => m.id));
		expect(items.every((i) => !mineIds.has(i.id))).toBe(true);
	});
});
