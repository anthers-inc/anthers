// SPDX-License-Identifier: Apache-2.0
/**
 * Terms acceptance when an account is finished, and the data-rights intake.
 *
 * **Acceptance is the one that matters most**, because it is what turns the 13+ floor
 * from a wish into a term. Before this, "you must be 13 or older" lived in a document
 * no user had ever seen — 62.03's whole minors posture rests on that one assertion,
 * and an unaccepted assertion is not one. So it is enforced at the API and not only in
 * the form: a client that omits it must be refused, because the form is a courtesy and
 * the boundary is the guarantee.
 *
 * The rights intake exists because **a deadline nobody can see is not a mechanism.**
 * Privacy Policy promises a response within 30 days; requests arriving as email into one
 * person's inbox is a hope. `dueAt` is stamped at creation so the commitment is fixed
 * when it is made and cannot move if the policy later changes the window.
 */
import { describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { rightsRequests, users } from "@anthers/db/schema";
import { RIGHTS_RESPONSE_DAYS } from "@anthers/shared/rights";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";
const id = crypto.randomUUID().slice(0, 8);

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

/** Accept the terms as a fixture account, with whatever body is given. */
function acceptTerms(cookie: string, body: Record<string, unknown>) {
	return req("/api/auth/onboarding/accept-terms", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify(body),
	});
}

/** The account's termsAcceptedAt, which stays null until acceptance has succeeded. */
async function termsAcceptedAtOf(userId: number) {
	const [row] = await db
		.select({ termsAcceptedAt: users.termsAcceptedAt })
		.from(users)
		.where(eq(users.id, userId));
	return row?.termsAcceptedAt ?? null;
}

// Terms are accepted where an account is finished — onboarding's `/welcome` — which
// is the step every signup door passes through.
describe("nobody gets an account without accepting the terms", () => {
	it("refuses a request that omits acceptance, and records nothing", async () => {
		const account = await createAccount(`rt_omit_${id}`);
		const res = await acceptTerms(account.cookie, {});
		expect(res.status).toBe(400);
		// A 400 that still counted as acceptance would be the worst of both.
		expect(await termsAcceptedAtOf(account.userId)).toBeNull();
	});

	it("refuses an explicit refusal rather than recording it", async () => {
		// `false` is not a value to store, it is a request that cannot be granted.
		const account = await createAccount(`rt_false_${id}`);
		expect((await acceptTerms(account.cookie, { acceptTerms: false })).status).toBe(400);
		expect(await termsAcceptedAtOf(account.userId)).toBeNull();
	});

	it("accepts a request that accepts", async () => {
		const account = await createAccount(`rt_ok_${id}`);
		const res = await acceptTerms(account.cookie, { acceptTerms: true });
		expect(res.status).toBe(200);
		expect(await termsAcceptedAtOf(account.userId)).not.toBeNull();
	});
});


describe("data-rights requests", () => {
	it("stamps a 30-day deadline at creation and acknowledges it", async () => {
		const name = `rt_req_${id}`;
		await db.execute(sql`DELETE FROM users WHERE email = ${name + '@example.com'}`);
		const { cookie } = await createAccount(name);

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
		await db.execute(sql`DELETE FROM users WHERE email = ${name + '@example.com'}`);
		const { cookie } = await createAccount(name);

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
