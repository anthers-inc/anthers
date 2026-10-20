// SPDX-License-Identifier: Apache-2.0
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
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { and, eq, sql } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayouts } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { CREATED_CREDIT, giveWorkAFile } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `lib_c_${id}`;
const userName = `lib_r_${id}`;

/** Free to everyone — the commons, and the case the Library exists to be able to hold. */
const FREE = [{ threshold: 0, allow: true, price: "0" }];
/** Behind $2 given to the creator, which the user never gives. */
const GATED = [
	{ threshold: 0, allow: false, price: "0" },
	{ threshold: 2, allow: true, price: "0" },
];

let creatorAuth: Record<string, string>;
let userAuth: Record<string, string>;
let userCookie: string;
let userId = 0;
let creatorId = 0;
let creatorHandle = "";

let freeWorkId = 0;
let gatedWorkId = 0;
let boughtWorkId = 0;
let privateWorkId = 0;

/** A published Project of two music Works, and a draft holding one — the release data. */
let musicProject: { id: number; slug: string; title: string };
let musicTrackA = 0;
let musicTrackB = 0;
let mixedAudioTrack = 0;
let draftProject: { id: number; slug: string; title: string };
let draftTrack = 0;

async function signUp(
	username: string,
): Promise<{ cookie: string; userId: number; handle: string }> {
	const account = await createAccount(username);
	const cookie = account.cookie;
	return { cookie, userId: account.userId as number, handle: account.handle };
}

async function makeWork(
	title: string,
	access: unknown,
	released = true,
	type: "audio" | "music" = "audio",
): Promise<number> {
	const created = await req("/api/content/works", {
		method: "POST",
		headers: creatorAuth,
		body: JSON.stringify({
			type,
			title,
			maturityRows: rowsRatedAs("general"),
			credits: CREATED_CREDIT,
		}),
	});
	expect(created.status).toBe(201);
	const workId = (await created.json()).work.id as number;
	await giveWorkAFile(workId);
	const patched = await req(`/api/content/works/${workId}`, {
		method: "PATCH",
		headers: creatorAuth,
		body: JSON.stringify({
			access: access,
			streamEnabled: true,
			...(released ? { visibility: "released" } : {}),
		}),
	});
	expect(patched.status).toBe(200);
	return workId;
}

/** A Project the creator owns, published unless the test is about a draft. */
async function makeProject(
	title: string,
	isPublished = true,
): Promise<{ id: number; slug: string; title: string }> {
	const slug = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id}`;
	const res = await req("/api/content/projects", {
		method: "POST",
		headers: creatorAuth,
		body: JSON.stringify({ title, slug, isPublished }),
	});
	expect(res.status).toBe(201);
	const { project } = await res.json();
	return { id: project.id as number, slug: project.slug as string, title: project.title };
}

async function addToProject(projectSlug: string, workId: number): Promise<void> {
	const res = await req(`/api/content/projects/${projectSlug}/works`, {
		method: "POST",
		headers: creatorAuth,
		body: JSON.stringify({ workId }),
	});
	expect(res.status).toBe(201);
}

/** A published post by the creator, for the shelf's post arm. */
async function makePost(title: string): Promise<number> {
	const res = await req("/api/content/posts", {
		method: "POST",
		headers: creatorAuth,
		body: JSON.stringify({ title, body: `${title} body`, isPublished: true }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).post.id as number;
}

/** The user's shelf. `hidden` includes the tidied-away entries. */
async function shelf(opts: { hidden?: boolean } = {}) {
	const res = await req(`/api/content/library${opts.hidden ? "?hidden=1" : ""}`, {
		headers: { Cookie: userCookie },
	});
	expect(res.status).toBe(200);
	return (await res.json()).items as {
		id: number;
		kind: string;
		hidden: boolean;
		purchased: boolean;
		work?: {
			id: number;
			access: { canAccess: boolean };
			creatorHandle?: string | null;
			creatorDisplayName?: string | null;
			creatorAvatar?: string | null;
			releases?: Array<{
				id: number;
				slug: string;
				title: string;
				coverImage: string | null;
				musicCount: number;
				audioCount: number;
			}>;
		};
		project?: {
			id: number;
			slug: string;
			title: string;
			coverImage: string | null;
			trackCount: number;
			musicCount: number;
			audioCount: number;
		};
		post?: {
			id: number;
			publicId: number;
			slug: string;
			title: string | null;
			excerpt: string | null;
			isPublished: boolean;
			creator: { handle: string; displayName: string | null; avatar: string | null } | null;
		};
	}[];
}

async function save(body: Record<string, number>) {
	return req("/api/content/library", {
		method: "POST",
		headers: userAuth,
		body: JSON.stringify(body),
	});
}

/** Whether the user can actually open a Work, asked at the endpoint that gates bytes. */
async function canOpen(workId: number): Promise<boolean> {
	const res = await req(`/api/content/works/${workId}`, { headers: { Cookie: userCookie } });
	expect(res.status).toBe(200);
	return (await res.json()).work.access.canAccess as boolean;
}

describe("the Library", () => {
	beforeAll(async () => {
		await db.execute(
			sql`DELETE FROM users WHERE email IN (${sql.join([sql`${`${creatorName}@example.com`}`, sql`${`${userName}@example.com`}`], sql`, `)})`,
		);
		const creator = await signUp(creatorName);
		await enablePayouts(creatorName);
		const user = await signUp(userName);
		await enablePayouts(userName);
		creatorId = creator.userId;
		creatorHandle = creator.handle;
		userId = user.userId;
		userCookie = user.cookie;
		creatorAuth = { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creator.cookie };
		userAuth = { "Content-Type": "application/json", Origin: ORIGIN, Cookie: user.cookie };

		freeWorkId = await makeWork(`Free ${id}`, FREE);
		gatedWorkId = await makeWork(`Gated ${id}`, GATED);
		boughtWorkId = await makeWork(`Bought ${id}`, GATED);
		privateWorkId = await makeWork(`Private ${id}`, FREE, false);

		// A release the shelf can describe without fetching it: two music Works in a
		// published Project, plus a draft Project holding a released track, which must
		// never be advertised through that track's shelf entry.
		musicProject = await makeProject(`Music release ${id}`);
		musicTrackA = await makeWork(`Release track A ${id}`, FREE, true, "music");
		musicTrackB = await makeWork(`Release track B ${id}`, FREE, true, "music");
		mixedAudioTrack = await makeWork(`Release episode ${id}`, FREE, true, "audio");
		await addToProject(musicProject.slug, musicTrackA);
		await addToProject(musicProject.slug, musicTrackB);
		await addToProject(musicProject.slug, mixedAudioTrack);

		draftProject = await makeProject(`Draft release ${id}`, false);
		draftTrack = await makeWork(`Draft track ${id}`, FREE, true, "music");
		await addToProject(draftProject.slug, draftTrack);

		// A completed purchase, written directly: this file is about the Library, and
		// driving Stripe would test the checkout route instead. The auto-save hook is
		// covered separately, below, by calling the service the webhook calls.
		await db.insert(purchases).values({
			buyerId: userId,
			workId: boughtWorkId,
			creatorId,
			type: "digital",
			amount: "5.00",
			processingFee: "0.45",
			salesTax: "0.00",
			creatorEarnings: "4.55",
			stripePaymentIntentId: `pi_lib_${id}`,
			status: "completed",
		});
	}, DB_SETUP_TIMEOUT);

	// ── The property everything else rests on ──────────────────────────────────

	it("🚨 saving a Work grants NO access to it", async () => {
		// Gated, and the user has given nothing — so this is denied before and must be
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

	it("carries the creator's display surface on the work arm, for the lens that labels channels by maker", async () => {
		// A lens that organizes the shelf by its creators (the Channel Guide) needs each
		// entry's channel label and avatar without a profile fetch per creator — the
		// project arm has always carried its creator pair; the work arm now answers the
		// same question. The join is a LEFT one for a reason: an account row that has
		// gone missing must not vanish someone's saved Work from their shelf.
		const entry = (await shelf()).find((i) => i.work?.id === freeWorkId);
		expect(entry, "the free Work should be on the shelf").toBeTruthy();
		expect(entry?.work?.creatorHandle).toBe(creatorHandle);
		// `displayName` may legitimately be unset on an account; the field must ride
		// regardless, as `creatorAvatar` must (its default is the empty string).
		expect("creatorDisplayName" in (entry?.work ?? {})).toBe(true);
		expect("creatorAvatar" in (entry?.work ?? {})).toBe(true);
	});

	it("carries each saved music Work's published Projects, so the music lens can group it into a release", async () => {
		// The music lens groups a saved track under the Project it came from. The shelf
		// carries the metadata a release card needs; the tracks themselves wait for the
		// open, which is why this is a count and a name rather than an N+1 of members.
		expect((await save({ workId: musicTrackA })).status).toBe(201);
		const entry = (await shelf()).find((i) => i.work?.id === musicTrackA);
		expect(entry?.work?.releases).toHaveLength(1);
		expect(entry?.work?.releases?.[0]).toMatchObject({
			id: musicProject.id,
			slug: musicProject.slug,
			title: musicProject.title,
			musicCount: 2,
			audioCount: 1,
		});

		// A Work in no Project carries an empty list rather than a missing field, so a
		// lens can read it without a second shape to handle.
		const loose = (await shelf()).find((i) => i.work?.id === freeWorkId);
		expect(loose?.work?.releases).toEqual([]);
	});

	it("never advertises a draft Project through a saved Work's release list", async () => {
		// A released Work can sit in a Project its creator has not published. The Work is
		// the stranger's to keep; the draft is not the stranger's to see.
		expect((await save({ workId: draftTrack })).status).toBe(201);
		const entry = (await shelf()).find((i) => i.work?.id === draftTrack);
		expect(entry?.work?.releases).toEqual([]);
	});

	it("reports a saved Project's music count beside its whole member count", async () => {
		// A Project is savable in its own right, so the music lens draws the release whole
		// rather than as the tracks the user happened to save separately.
		expect((await save({ projectId: musicProject.id })).status).toBe(201);
		const entry = (await shelf()).find(
			(i) => i.kind === "project" && i.project?.id === musicProject.id,
		);
		expect(entry?.project).toMatchObject({ trackCount: 3, musicCount: 2, audioCount: 1 });
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

	it("saves a post into the same shelf as a Work — a keep is a keep", async () => {
		const postId = await makePost(`Saved post ${id}`);
		expect((await save({ postId })).status).toBe(201);

		const entry = (await shelf()).find((i) => i.kind === "post" && i.post?.id === postId);
		expect(entry, "the post should be on the shelf").toBeTruthy();
		expect(entry?.post?.title).toBe(`Saved post ${id}`);
		expect(entry?.post?.excerpt).toContain(`Saved post ${id} body`);
		// The card reads a post like a post: its own opening and the person who wrote it.
		expect(entry?.post?.creator?.handle).toBe(creatorHandle);
		expect(entry?.purchased).toBe(false);

		// Idempotent, and removable like any free keep.
		expect((await save({ postId })).status).toBe(201);
		expect((await shelf()).filter((i) => i.post?.id === postId)).toHaveLength(1);
		const remove = await req(`/api/content/library/${entry?.id}`, {
			method: "DELETE",
			headers: userAuth,
		});
		expect(remove.status).toBe(204);
		expect((await shelf()).some((i) => i.post?.id === postId)).toBe(false);
	});

	// ── Purchases are permanent ────────────────────────────────────────────────

	it("shows a purchase as purchased, derived from the purchase itself", async () => {
		// Nothing wrote a "this was bought" flag — `purchases` is read back on every
		// request, which is why a refund can release it with no sweep.
		const { saveOnPurchase } = await import("../services/library.js");
		await saveOnPurchase({ buyerId: userId, workId: boughtWorkId, type: "digital" });

		const entry = (await shelf()).find((i) => i.work?.id === boughtWorkId);
		expect(entry, "a completed purchase should be on the shelf").toBeTruthy();
		expect(entry?.purchased).toBe(true);
	});

	it("refuses to remove a purchased Work, and says what to do instead", async () => {
		const entry = (await shelf()).find((i) => i.work?.id === boughtWorkId);
		const res = await req(`/api/content/library/${entry?.id}`, {
			method: "DELETE",
			headers: userAuth,
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
			headers: userAuth,
			body: JSON.stringify({ hidden: true }),
		});
		expect(hide.status).toBe(200);

		expect((await shelf()).some((i) => i.work?.id === boughtWorkId)).toBe(false);
		// Hidden, never gone: the toggle finds it, which is what makes hiding safe.
		expect((await shelf({ hidden: true })).some((i) => i.work?.id === boughtWorkId)).toBe(true);

		const show = await req(`/api/content/library/${entry?.id}`, {
			method: "PATCH",
			headers: userAuth,
			body: JSON.stringify({ hidden: false }),
		});
		expect(show.status).toBe(200);
		expect((await shelf()).some((i) => i.work?.id === boughtWorkId)).toBe(true);
	});

	it("a refund releases the entry, because permanence was never stored", async () => {
		await db
			.update(purchases)
			.set({ status: "refunded" })
			.where(and(eq(purchases.buyerId, userId), eq(purchases.workId, boughtWorkId)));

		const entry = (await shelf()).find((i) => i.work?.id === boughtWorkId);
		expect(entry?.purchased, "a refunded purchase is no longer permanent").toBe(false);

		const res = await req(`/api/content/library/${entry?.id}`, {
			method: "DELETE",
			headers: userAuth,
		});
		expect(res.status).toBe(204);

		// Put it back for anything that runs after.
		await db
			.update(purchases)
			.set({ status: "completed" })
			.where(and(eq(purchases.buyerId, userId), eq(purchases.workId, boughtWorkId)));
	});

	// ── Removing what you merely saved ─────────────────────────────────────────

	it("removes a freely-saved Work outright — there is nothing to protect", async () => {
		const entry = (await shelf()).find((i) => i.work?.id === freeWorkId);
		const res = await req(`/api/content/library/${entry?.id}`, {
			method: "DELETE",
			headers: userAuth,
		});
		expect(res.status).toBe(204);
		expect((await shelf()).some((i) => i.work?.id === freeWorkId)).toBe(false);
	});

	it("saving something you had hidden brings it back rather than doing nothing", async () => {
		await save({ workId: freeWorkId });
		const entry = (await shelf()).find((i) => i.work?.id === freeWorkId);
		await req(`/api/content/library/${entry?.id}`, {
			method: "PATCH",
			headers: userAuth,
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

		await db.update(works).set({ access: GATED }).where(eq(works.id, laterGated));

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
			.where(eq(libraryItems.userId, userId));
		const mineIds = new Set(mine.map((m) => m.id));
		expect(items.every((i) => !mineIds.has(i.id))).toBe(true);
	});
});
