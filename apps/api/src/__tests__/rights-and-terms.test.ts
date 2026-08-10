// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Terms acceptance at signup, and the data-rights intake.
 *
 * **Acceptance is the one that matters most**, because it is what turns the 13+ floor
 * from a wish into a term. Before this, "you must be 13 or older" lived in a document
 * no user had ever seen — 62.03's whole minors posture rests on that one assertion,
 * and an unaccepted assertion is not one. So it is enforced at the API and not only in
 * the form: a client that omits it must be refused, because the form is a courtesy and
 * the boundary is the guarantee.
 *
 * The rights intake exists because **a deadline nobody can see is not a mechanism.**
 * 51.05 promises a response within 30 days; requests arriving as email into one
 * person's inbox is a hope. `dueAt` is stamped at creation so the commitment is fixed
 * when it is made and cannot move if the policy later changes the window.
 */
import { describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { rightsRequests, users } from "@anthers/db/schema";
import { RIGHTS_RESPONSE_DAYS } from "@anthers/shared/rights";
import { eq, sql } from "drizzle-orm";
import app from "../index";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";
const id = crypto.randomUUID().slice(0, 8);

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

function signUpBody(username: string, extra: Record<string, unknown>) {
	return {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({
			username,
			email: `${username}@example.com`,
			password: "testpass123",
			...extra,
		}),
	};
}

describe("nobody gets an account without accepting the terms", () => {
	it("refuses a signup that omits acceptance", async () => {
		const name = `rt_omit_${id}`;
		await db.execute(sql`DELETE FROM users WHERE username = ${name}`);
		const res = await req("/api/auth/sign-up", signUpBody(name, {}));
		expect(res.status).toBe(400);

		// And no account was created — a 400 that still writes the row would be the
		// worst of both.
		const rows = await db.select().from(users).where(eq(users.username, name));
		expect(rows).toEqual([]);
	});

	it("refuses an explicit refusal rather than recording it", async () => {
		// `false` is not a value to store, it is a request that cannot be granted.
		const name = `rt_false_${id}`;
		await db.execute(sql`DELETE FROM users WHERE username = ${name}`);
		expect((await req("/api/auth/sign-up", signUpBody(name, { acceptTerms: false }))).status).toBe(
			400,
		);
		expect(await db.select().from(users).where(eq(users.username, name))).toEqual([]);
	});

	it("accepts a signup that accepts", async () => {
		const name = `rt_ok_${id}`;
		await db.execute(sql`DELETE FROM users WHERE username = ${name}`);
		const res = await req("/api/auth/sign-up", signUpBody(name, { acceptTerms: true }));
		expect(res.status).toBe(201);
	});
});

describe("data-rights requests", () => {
	it("stamps a 30-day deadline at creation and acknowledges it", async () => {
		const name = `rt_req_${id}`;
		await db.execute(sql`DELETE FROM users WHERE username = ${name}`);
		const signUp = await req("/api/auth/sign-up", signUpBody(name, { acceptTerms: true }));
		expect(signUp.status).toBe(201);
		const cookie = signUp.headers.get("Set-Cookie")!.split(";")[0];

		const before = Date.now();
		const res = await req("/api/accounts/me/rights-requests", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({ kind: "rectification", details: `please fix ${id}` }),
		});
		expect(res.status).toBe(201);

		const [row] = await db
			.select()
			.from(rightsRequests)
			.where(eq(rightsRequests.details, `please fix ${id}`));
		expect(row).toBeDefined();
		expect(row.status).toBe("open");
		// The commitment is fixed when it is made, not computed at read time — so a
		// later change to the window cannot quietly move a deadline already promised.
		const days = (new Date(row.dueAt).getTime() - before) / 86_400_000;
		expect(Math.round(days)).toBe(RIGHTS_RESPONSE_DAYS);
		// Email captured at request time: the account may be deleted before this is
		// answered, and an unanswerable request is worse than a slow one.
		expect(row.email).toBe(`${name}@example.com`);

		// Acknowledged in writing — a request vanishing into a queue with no reply is
		// what people file complaints about, and the notification is also our evidence.
		const notes = await req("/api/accounts/me/notifications", { headers: { Cookie: cookie } });
		const data = (await notes.json()) as { notifications: { kind: string }[] };
		expect(data.notifications.some((n) => n.kind === "rights_request_received")).toBe(true);
	});

	it("rejects an unknown kind rather than storing it", async () => {
		const name = `rt_bad_${id}`;
		await db.execute(sql`DELETE FROM users WHERE username = ${name}`);
		const signUp = await req("/api/auth/sign-up", signUpBody(name, { acceptTerms: true }));
		const cookie = signUp.headers.get("Set-Cookie")!.split(";")[0];

		const res = await req("/api/accounts/me/rights-requests", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({ kind: "make-me-a-sandwich" }),
		});
		expect(res.status).toBe(400);
	});

	it("requires a session", async () => {
		const res = await req("/api/accounts/me/rights-requests", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ kind: "access" }),
		});
		expect(res.status).toBe(401);
	});
});
