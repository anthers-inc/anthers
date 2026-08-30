// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `POST /api/subscriptions/self-hosting` is closed, and this pins that it stays closed.
 *
 * 🚨 **The category being closed is "a money input asserted rather than observed".** The
 * endpoint set `accounts.is_self_hosting` to whatever an authenticated caller asked for,
 * with nothing anywhere checking that the caller hosts anything. It is not being deferred
 * for lack of a verifier: the eventual flag is **derived** from origin registration —
 * milestone 1 of Creator-Hosted Delivery — at which point there is no setter to guard.
 * Building a verification mechanism now would be building something that gets deleted.
 *
 * ⚠️ Closing it also removes a footgun rather than withholding a feature, because the
 * flag's one live effect is **inverted**: `SELF_HOST_FEE` is `0`, so a claimant's modeled
 * hosting cost is zero, so `calculate-crf`'s `earnings.gte(hostingCost)` passes for
 * everyone and books them a zero subsidy. Setting the flag costs a creator money. The
 * arithmetic side of that is pinned in `packages/shared/src/economics.test.ts`.
 *
 * A test rather than a comment because the failure mode of re-opening this is silent: no
 * UI calls the endpoint, so nothing would look broken either way.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { sql } from "drizzle-orm";
import app from "../index";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

const id = crypto.randomUUID().slice(0, 8);
const username = `shc_${id}`;
let cookie: string;

beforeAll(async () => {
	await db.execute(sql`DELETE FROM users WHERE username = ${username}`);
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
	cookie = res.headers.get("Set-Cookie")?.split(";")[0] ?? "";
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	await db.execute(sql`DELETE FROM users WHERE username = ${username}`);
});

describe("the self-hosting flag cannot be set by request", () => {
	const headers = () => ({ "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie });

	it("refuses to enable it, and says why rather than 404ing", async () => {
		const res = await req("/api/subscriptions/self-hosting", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ enabled: true }),
		});
		expect(res.status).toBe(503);
		expect((await res.json()).error).toMatch(/registered origin/i);
	});

	it("refuses to disable it too — the column is not writable from here at all", async () => {
		// Worth its own case: a guard that only blocked `true` would leave a caller able to
		// clear a flag set out-of-band, which is the same "claim, not observation" problem
		// pointed the other way.
		const res = await req("/api/subscriptions/self-hosting", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ enabled: false }),
		});
		expect(res.status).toBe(503);
	});

	it("writes nothing — the account's flag is untouched after a refused call", async () => {
		// 🚨 The assertion that actually matters. A route can return 503 *after* having
		// mutated, which is exactly the shape of the `/cancel` bug recorded in
		// `routes/subscriptions.ts`: it recorded a cancellation locally that never reached
		// Stripe. Checking the status code alone would not have caught that one either.
		//
		// ⚠️ It issues its OWN enable rather than leaning on the cases above, and that is
		// the difference between this proving something and proving nothing. Run after the
		// disable case, a working setter would have left the flag `false` — so the check
		// would pass against the exact regression it exists to catch. Verified by sabotage:
		// in the leaning version, restoring the setter failed 2 of 3 here, not 3.
		await req("/api/subscriptions/self-hosting", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ enabled: true }),
		});
		const rows = await db.execute(
			sql`SELECT a.is_self_hosting FROM accounts a
			    JOIN users u ON u.id = a.user_id WHERE u.username = ${username}`,
		);
		// Either no account row was created, or it exists and the flag is still false.
		for (const row of rows) expect(row.is_self_hosting).toBeFalsy();
	});
});
