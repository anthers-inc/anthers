// SPDX-License-Identifier: Apache-2.0
/**
 * The Works a Badge opens — the Badge Maker's Perks tab reads this, and its inline
 * "Stop opening" control writes it.
 *
 * 🚨 **The list is not "every Work that names this rung".** A Work is opened by a Badge only
 * when the rung's row allows at $0 and the Everyone row does not already make the Work
 * Public Access; a priced rung is a purchase door rather than a gate the Badge clears. The
 * exclusion is the whole reason this endpoint exists instead of the editor filtering the
 * full Works payload.
 *
 * ⚠️ **Stopping a gate keeps the row and clears `allow`.** The Access table is one row per
 * rung, and the Studio's editor re-materializes it; deleting the row would come back as the
 * same row with the same false flag on the next save.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { badges, users, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const RUN = crypto.randomUUID().slice(0, 8);
const creatorName = `bg_creator_${RUN}`;
const otherName = `bg_other_${RUN}`;

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

let creatorCookie: string;
let creatorId = 0;
let badgeId = 0;
let gatedWorkId = 0;

beforeAll(async () => {
	creatorCookie = (await createAccount(creatorName)).cookie;
	await createAccount(otherName);

	const [creator] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, `${creatorName}@example.com`));
	creatorId = creator.id;

	const created = await req("/api/subscriptions/badges", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
		body: JSON.stringify({ threshold: "5.00", label: `Gates ${RUN}` }),
	});
	expect(created.status).toBe(201);
	badgeId = ((await created.json()) as { badge: { id: number } }).badge.id;

	// The one that IS opened: Everyone is locked, the rung allows at $0.
	const gated = await insertWork({
		creatorId,
		type: "text",
		title: "Opened by the Badge",
		access: [
			{ threshold: 0, allow: false, price: "0" },
			{ threshold: 5, badgeId, allow: true, price: "0" },
		],
	});
	gatedWorkId = gated.id;

	// Public Access, so the rung is redundant rather than the thing opening it.
	await insertWork({
		creatorId,
		type: "text",
		title: "Already free",
		access: [
			{ threshold: 0, allow: true, price: "0" },
			{ threshold: 5, badgeId, allow: true, price: "0" },
		],
	});

	// The rung allows, but at a price: a purchase door, not a gate the Badge clears.
	await insertWork({
		creatorId,
		type: "text",
		title: "Still costs money",
		access: [
			{ threshold: 0, allow: false, price: "0" },
			{ threshold: 5, badgeId, allow: true, price: "2.00" },
		],
	});
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	await db.delete(badges).where(eq(badges.id, badgeId));
});

describe("the Works a Badge opens", () => {
	it("lists only the Works the rung actually opens", async () => {
		const res = await req(`/api/content/badge-gates/${badgeId}`, {
			headers: { Cookie: creatorCookie },
		});
		expect(res.status).toBe(200);

		const body = (await res.json()) as { works: { id: number; title: string }[] };
		expect(body.works.map((w) => w.title)).toEqual(["Opened by the Badge"]);
		expect(body.works[0]?.id).toBe(gatedWorkId);
	});

	it("is 404 for a Badge the caller does not own", async () => {
		const other = await createAccount(`${otherName}_probe`);
		const res = await req(`/api/content/badge-gates/${badgeId}`, {
			headers: { Cookie: other.cookie },
		});
		expect(res.status).toBe(404);
	});

	it("stops the gate by clearing allow rather than deleting the row", async () => {
		const res = await req(`/api/content/badge-gates/${badgeId}/${gatedWorkId}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: creatorCookie },
		});
		expect(res.status).toBe(204);

		const list = await req(`/api/content/badge-gates/${badgeId}`, {
			headers: { Cookie: creatorCookie },
		});
		expect(((await list.json()) as { works: unknown[] }).works).toEqual([]);

		const [row] = await db
			.select({ access: works.access })
			.from(works)
			.where(eq(works.id, gatedWorkId));
		const rung = row?.access?.find((entry) => entry.badgeId === badgeId);
		expect(rung?.allow).toBe(false);
		expect(rung?.price).toBe("0");
	});
});
