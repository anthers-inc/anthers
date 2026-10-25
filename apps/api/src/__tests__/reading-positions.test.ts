// SPDX-License-Identifier: Apache-2.0
/**
 * Reading positions: where a reader got to, one row per account and Work.
 *
 * 🚨 **Only the caller's rows, ever.** These routes are the single place a person's
 * reading positions enter or leave the server, and the property that governs every
 * other property is that they are private consumption state — one user's positions are
 * invisible to another, invisible to the Work's creator, and (there being no share link
 * on any door) visible to exactly the account that made them.
 *
 * The rest is the three rules the upsert contract promises:
 *
 *   - **Newest-write-wins.** A second push replaces the row whole — resume means where
 *     the reader most recently actually was, never the high-water mark.
 *   - **Clamped, not refused.** A fraction a hair outside 0–1 (a reflow renderer's
 *     1.0000001) writes a clamped position rather than bouncing.
 *   - **Access-gated at the write.** You record a position only in a Work you can
 *     reach — the same shape the save-sync routes use.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { readingPositions } from "@anthers/db/schema";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { and, eq, sql } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { createBadgeRung } from "./badge-fixtures.js";
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
const creatorName = `rp_c_${id}`;
const userAName = `rp_a_${id}`;
const userBName = `rp_b_${id}`;

const FREE = [{ threshold: 0, allow: true, price: "0" }];
const GATED = [
	{ threshold: 0, allow: false, price: "0" },
	{ threshold: 2, allow: true, price: "0", badgeId: 0 },
];

let creatorAuth: Record<string, string>;
let aAuth: Record<string, string>;
let bCookie = "";
let userAId = 0;

let freeWorkId = 0;
let gatedWorkId = 0;
let privateWorkId = 0;

async function makeWork(title: string, access: unknown, released = true): Promise<number> {
	const created = await req("/api/content/works", {
		method: "POST",
		headers: creatorAuth,
		body: JSON.stringify({
			type: "audio",
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

function put(workId: number, body: Record<string, unknown>, cookies: Record<string, string>) {
	return req(`/api/content/reading-positions/${workId}`, {
		method: "PUT",
		headers: cookies,
		body: JSON.stringify(body),
	});
}

async function positionsOf(cookies: Record<string, string>) {
	const res = await req("/api/content/reading-positions", { headers: cookies });
	expect(res.status).toBe(200);
	return (await res.json()).positions as Array<{
		workId: number;
		progress: number;
		position: Record<string, unknown>;
		updatedAt: string;
	}>;
}

describe("reading positions", () => {
	beforeAll(async () => {
		const accounts = [creatorName, userAName, userBName];
		await db.execute(
			sql`DELETE FROM users WHERE email IN (${sql.join(
				accounts.map((n) => sql`${`${n}@example.com`}`),
				sql`, `,
			)})`,
		);
		const creator = await createAccount(creatorName);
		// Released Work needs payout setup behind it (the release gate this repo
		// carries), so the creator is made payable before the works are made.
		await enablePayouts(creatorName);
		const a = await createAccount(userAName);
		const b = await createAccount(userBName);
		userAId = a.userId as number;
		bCookie = b.cookie;
		creatorAuth = { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creator.cookie };
		aAuth = { "Content-Type": "application/json", Origin: ORIGIN, Cookie: a.cookie };
		GATED[1].badgeId = await createBadgeRung(creator.cookie, "2.00");

		freeWorkId = await makeWork(`Free ${id}`, FREE);
		gatedWorkId = await makeWork(`Gated ${id}`, GATED);
		privateWorkId = await makeWork(`Private ${id}`, FREE, false);
	}, DB_SETUP_TIMEOUT);

	it("refuses both doors without an account", async () => {
		const listed = await req("/api/content/reading-positions");
		expect(listed.status).toBe(401);
		const pushed = await put(
			freeWorkId,
			{ progress: 0.5, position: {} },
			{ "Content-Type": "application/json", Origin: ORIGIN },
		);
		expect(pushed.status).toBe(401);
	});

	it("writes a position and reads it back — and only that caller ever sees it", async () => {
		const pushed = await put(freeWorkId, { progress: 0.4, position: { page: 40 } }, aAuth);
		expect(pushed.status).toBe(200);
		const row = (await pushed.json()) as {
			workId: number;
			progress: number;
			position: Record<string, unknown>;
		};
		expect(row.workId).toBe(freeWorkId);
		expect(row.progress).toBe(0.4);
		expect(row.position).toEqual({ page: 40 });

		// The caller reads their own row…
		const mine = await positionsOf(aAuth);
		expect(mine.map((p) => p.workId)).toContain(freeWorkId);

		// …and a second account reads no trace of it — the privacy property the
		// whole module stands on, asked at the endpoint rather than the table.
		const theirs = await positionsOf({
			"Content-Type": "application/json",
			Origin: ORIGIN,
			Cookie: bCookie,
		});
		expect(theirs.map((p) => p.workId)).not.toContain(freeWorkId);
	});

	it("upserts one row per (user, Work), replaced whole by the newer write", async () => {
		await put(freeWorkId, { progress: 0.2, position: { page: 20 } }, aAuth);
		await put(freeWorkId, { progress: 0.6, position: { page: 60 } }, aAuth);

		const mine = await positionsOf(aAuth);
		const rows = mine.filter((p) => p.workId === freeWorkId);
		expect(rows).toHaveLength(1);
		expect(rows[0].progress).toBe(0.6);
		expect(rows[0].position).toEqual({ page: 60 });

		// The upsert is the writer's contract made direct: the table itself holds
		// exactly one row for the pair.
		const stored = await db
			.select()
			.from(readingPositions)
			.where(and(eq(readingPositions.userId, userAId), eq(readingPositions.workId, freeWorkId)));
		expect(stored).toHaveLength(1);
	});

	it("clamps an out-of-range fraction rather than refusing it", async () => {
		await put(freeWorkId, { progress: 1.0000001, position: {} }, aAuth);
		expect((await positionsOf(aAuth)).find((p) => p.workId === freeWorkId)?.progress).toBe(1);

		await put(freeWorkId, { progress: -0.5, position: {} }, aAuth);
		expect((await positionsOf(aAuth)).find((p) => p.workId === freeWorkId)?.progress).toBe(0);
	});

	it("bounds the opaque pointer at the write boundary", async () => {
		const bloat: Record<string, number> = {};
		for (let i = 0; i < 9; i += 1) bloat[`k${i}`] = i;
		expect((await put(freeWorkId, { progress: 0.5, position: bloat }, aAuth)).status).toBe(400);

		const wide: Record<string, number> = { fill: 1 };
		for (let i = 0; i < 400; i += 1) wide[`k${i}`] = i;
		expect((await put(freeWorkId, { progress: 0.5, position: wide }, aAuth)).status).toBe(400);

		// A pointer the readers actually write — pages, panels, a CFI — passes.
		expect(
			(await put(freeWorkId, { progress: 0.5, position: { page: 3, panel: 7 } }, aAuth)).status,
		).toBe(200);
		expect(
			(await put(freeWorkId, { progress: 0.5, position: { cfi: "epubcfi(/6/4)" } }, aAuth)).status,
		).toBe(200);
	});

	it("refuses a Work that does not exist", async () => {
		const pushed = await put(99999999, { progress: 0.5, position: {} }, aAuth);
		expect(pushed.status).toBe(404);
	});

	it("gates the write on access, like the save routes do", async () => {
		// The user has given nothing, so the gated Work has no door.
		const gated = await put(gatedWorkId, { progress: 0.5, position: {} }, aAuth);
		expect(gated.status).toBe(403);

		// An unreleased Work is nobody else's to position but its creator's — invisible
		// to the caller, and answered as invisible (the same 404 the Library's save names).
		const priv = await put(privateWorkId, { progress: 0.5, position: {} }, aAuth);
		expect(priv.status).toBe(404);
	});

	it("lists newest-touched first", async () => {
		const first = await put(freeWorkId, { progress: 0.3, position: {} }, aAuth);
		expect(first.status).toBe(200);
		// Two rows whose upserts would otherwise share a clock tick: the free Work's
		// row was rewritten above moments ago, so write a *second* distinct Work and
		// expect it to come home ahead of the first.
		const secondWork = await makeWork(`Order ${id}`, FREE);
		const second = await put(secondWork, { progress: 0.7, position: {} }, aAuth);
		expect(second.status).toBe(200);

		const mine = await positionsOf(aAuth);
		const order = mine.filter((p) => p.workId === freeWorkId || p.workId === secondWork);
		expect(order.length).toBe(2);
		expect(order[0].workId).toBe(secondWork);
	});
});
