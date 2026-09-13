// SPDX-License-Identifier: Apache-2.0
/**
 * Storing and reading back a creator's Studio Dashboard layout.
 *
 * 🚨 **The assertion this suite exists for is that the endpoint NARROWS what it stores.** The
 * column is `jsonb` and will hold anything, and the thing that reads it back is a renderer
 * that has never heard of a panel name we retired — so a client typo accepted here is stored
 * forever and surfaces as a missing box rather than as an error. Validating only in the
 * browser would leave a second client free to seed one.
 *
 * ⭐ **The other assertion is an absence, and nothing else in the repository could make it.**
 * The Dashboard's worklist — payout setup, a released Work nobody can open, a failed encode —
 * is composed by the client and must never become storable, because a warning a creator can
 * remove is one that will be removed by exactly the person it was for. So this suite checks
 * that a layout naming a worklist item is refused the same way a typo is.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { studioPreferences, users } from "@anthers/db/schema";
import { DEFAULT_STUDIO_PANELS } from "@anthers/shared/studio-panels";
import { eq } from "drizzle-orm";
import app from "../index";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";
const run = crypto.randomUUID().slice(0, 8);
const username = `panels_${run}`;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

let cookie: string;
let userId: number;

beforeAll(async () => {
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
	cookie = res.headers.get("Set-Cookie")!.split(";")[0];
	const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
	userId = row.id;
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	// The preferences row cascades with the account, which `purgeAccountsCreatedHere` takes —
	// but delete it explicitly rather than trusting the cascade, since "ask what does NOT
	// cascade" is the rule and a wrong answer here would litter a shared database.
	await db.delete(studioPreferences).where(eq(studioPreferences.userId, userId));
});

const read = () =>
	req("/api/accounts/me/studio-panels", { headers: { Cookie: cookie, Origin: ORIGIN } });

const write = (panels: unknown) =>
	req("/api/accounts/me/studio-panels", {
		method: "PATCH",
		headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
		body: JSON.stringify({ panels }),
	});

describe("GET /me/studio-panels", () => {
	it("gives the defaults to a creator who has never arranged anything", async () => {
		const res = await read();
		expect(res.status).toBe(200);
		expect((await res.json()).panels).toEqual(DEFAULT_STUDIO_PANELS);
	});

	it("refuses a signed-out caller", async () => {
		const res = await req("/api/accounts/me/studio-panels", { headers: { Origin: ORIGIN } });
		expect(res.status).toBe(401);
	});
});

describe("PATCH /me/studio-panels", () => {
	it("stores an order and reads it back unchanged", async () => {
		const res = await write(["posts", "earnings"]);
		expect(res.status).toBe(200);
		expect((await res.json()).panels).toEqual(["posts", "earnings"]);
		expect((await (await read()).json()).panels).toEqual(["posts", "earnings"]);
	});

	it("keeps an empty layout empty rather than restoring the defaults", async () => {
		// Hiding every panel is a thing a creator may do, and it must not read back as
		// "never arranged" — which is what a column that cannot tell null from [] would give.
		await write([]);
		expect((await (await read()).json()).panels).toEqual([]);

		const [row] = await db
			.select({ panels: studioPreferences.panels })
			.from(studioPreferences)
			.where(eq(studioPreferences.userId, userId));
		expect(row.panels).toEqual([]);
	});

	it("drops a name that is not a panel instead of storing it", async () => {
		// 🚨 The core of this suite. `jsonb` would hold this happily and the browser would
		// render a gap for it, with nothing anywhere reporting a problem.
		const res = await write(["earnings", "not-a-real-panel", "catalog"]);
		expect((await res.json()).panels).toEqual(["earnings", "catalog"]);
		expect((await (await read()).json()).panels).toEqual(["earnings", "catalog"]);
	});

	it("refuses to store a worklist item as a panel", async () => {
		// The attention items are never hideable and never stored. Naming one here must be
		// treated as the typo it is, not quietly accepted into a layout.
		const res = await write(["payouts", "locked", "earnings"]);
		expect((await res.json()).panels).toEqual(["earnings"]);
	});

	it("collapses a repeat rather than storing the panel twice", async () => {
		const res = await write(["catalog", "catalog", "earnings"]);
		expect((await res.json()).panels).toEqual(["catalog", "earnings"]);
	});

	it("refuses a signed-out writer", async () => {
		const res = await req("/api/accounts/me/studio-panels", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ panels: ["earnings"] }),
		});
		expect(res.status).toBe(401);
	});
});
