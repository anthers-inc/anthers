// SPDX-License-Identifier: Apache-2.0
/**
 * A gate is a Badge rung or a price, and nothing else (Parker, 2026-10-23).
 *
 * The retired third shape was a gate at a monthly amount no rung occupied. It was
 * authorable only through the API — the Studio renders the access table as the Everyone
 * baseline plus one row per rung — and invisible once stored, because that table has no
 * row to show it in and the next save wrote it away.
 *
 * What these pin:
 * - A rung row names the creator's own Badge, and the server stamps the rung's amount
 *   rather than trusting the number the client sent.
 * - A row at an amount with no rung is refused, and so is a row that names another
 *   creator's Badge.
 * - A repriced rung takes its gates with it.
 * - A rung a Work still gates on cannot be deleted out from under it.
 * - The baseline row stays exactly what it was: Public Access at $0, or a purchase price.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere, purgeWorkIds } from "./cleanup";
import { insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const workIds: number[] = [];

let creator: FixtureAccount;
let stranger: FixtureAccount;
let workId = 0;
let lowRungId = 0;
let highRungId = 0;

const LOW_RUNG = 3;
const HIGH_RUNG = 6;

function call(method: string, path: string, cookie: string, body?: unknown) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				Cookie: cookie,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: "manual",
		}),
	);
}

async function storedAccess() {
	const [row] = await db.select({ access: works.access }).from(works).where(eq(works.id, workId));
	return row?.access ?? [];
}

const baseline = { threshold: 0, allow: false, price: "0" };

async function createRung(cookie: string, threshold: string, label: string) {
	const res = await call("POST", "/api/subscriptions/badges", cookie, { threshold, label });
	expect(res.status).toBe(201);
	const body = (await res.json()) as { badge: { id: number } };
	return body.badge.id;
}

beforeAll(async () => {
	creator = await createAccount("gate-creator");
	stranger = await createAccount("gate-stranger");
	const work = await insertWork({ creatorId: creator.userId, type: "text", title: "Gated Work" });
	workId = work.id;
	workIds.push(work.id);
	lowRungId = await createRung(creator.cookie, "3.00", "Low");
	highRungId = await createRung(creator.cookie, "6.00", "High");
});

afterAll(async () => {
	await purgeWorkIds(workIds);
});

describe("a gate must sit on one of the creator's rungs", () => {
	it("refuses an amount no rung occupies, with or without a rung named", async () => {
		const orphaned = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			access: [baseline, { threshold: 7, allow: true, price: "0" }],
		});
		expect(orphaned.status).toBe(400);

		// The exact amount of a real rung is still not enough on its own: the row names the
		// rung, so a client cannot invent an amount that happens to match one.
		const unnamed = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			access: [baseline, { threshold: LOW_RUNG, allow: true, price: "0" }],
		});
		expect(unnamed.status).toBe(400);
	});

	it("refuses another creator's rung", async () => {
		const foreignRung = await createRung(stranger.cookie, "3.00", "Theirs");
		const res = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			access: [baseline, { badgeId: foreignRung, threshold: 3, allow: true, price: "0" }],
		});
		expect(res.status).toBe(400);
	});

	it("stamps the rung's amount rather than the one the client sent", async () => {
		const res = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			access: [baseline, { badgeId: lowRungId, threshold: 999, allow: true, price: "0" }],
		});
		expect(res.status).toBe(200);

		const rows = await storedAccess();
		const gated = rows.find((r) => r.badgeId === lowRungId);
		expect(gated?.threshold).toBe(LOW_RUNG);
		expect(gated?.allow).toBe(true);
	});
});

describe("a rung and its gates move together", () => {
	it("moves a gate's amount when its rung is repriced", async () => {
		const res = await call("PATCH", `/api/subscriptions/badges/${lowRungId}`, creator.cookie, {
			threshold: "5.00",
		});
		expect(res.status).toBe(200);

		const rows = await storedAccess();
		expect(rows.find((r) => r.badgeId === lowRungId)?.threshold).toBe(5);
	});

	it("refuses to delete a rung a Work still gates on, then allows it once the gate moves", async () => {
		const refused = await call("DELETE", `/api/subscriptions/badges/${lowRungId}`, creator.cookie);
		expect(refused.status).toBe(409);
		const body = (await refused.json()) as { error: string };
		expect(body.error).toContain("gated");

		const moved = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			access: [baseline, { badgeId: highRungId, threshold: HIGH_RUNG, allow: true, price: "0" }],
		});
		expect(moved.status).toBe(200);

		const deleted = await call("DELETE", `/api/subscriptions/badges/${lowRungId}`, creator.cookie);
		expect(deleted.status).toBe(204);
	});
});

describe("the baseline row is still a price or Public Access", () => {
	it("saves a purchase price on the Everyone row with no rung at all", async () => {
		const res = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			access: [{ threshold: 0, allow: true, price: "12.00" }],
		});
		expect(res.status).toBe(200);

		const rows = await storedAccess();
		expect(rows).toEqual([{ threshold: 0, allow: true, price: "12.00" }]);
	});
});
