// SPDX-License-Identifier: Apache-2.0
/**
 * Resolving a data-rights request tells the person who made it, once, wherever they still are.
 *
 * 🚨 **The case this file exists for is the account that is gone.** Somebody who asks what Anthers
 * holds about them and then deletes their account is exactly the person most likely to be waiting
 * on an answer with no account to see it in, so without the address captured with the request,
 * resolving it would close it in silence. That makes the recipient the thing worth asserting: an
 * email to the right person, not merely an email.
 *
 * `sendEmail` refuses to send under the test runner, so it is spied on rather than trusted, and the
 * assertions read what it was asked to send. The live-account case pins the other direction —
 * exactly one email — because the obvious way to fix the gap, emailing the stored address every
 * time, would tell a person who still has an account twice.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { notifications, rightsRequests } from "@anthers/db/schema";
import { RIGHTS_RESPONSE_DAYS } from "@anthers/shared/rights";
import { and, eq, inArray } from "drizzle-orm";
import app from "../index";
import * as email from "../services/email.js";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const id = crypto.randomUUID().slice(0, 8);

/** A request row whose account is gone is `set null` rather than cascaded, so nothing else removes it. */
const requestIds: number[] = [];
afterAll(async () => {
	if (requestIds.length > 0) {
		await db.delete(rightsRequests).where(inArray(rightsRequests.id, requestIds));
	}
});

let adminCookie: string;
beforeAll(async () => {
	adminCookie = (await createAdminFixture("rights")).cookie;
}, DB_SETUP_TIMEOUT);

/** What `sendEmail` was asked to send, with the provider's answer set by the test. */
function spyOnSends(sent: boolean) {
	return spyOn(email, "sendEmail").mockImplementation(async () => ({
		sent,
		messageId: sent ? "EXAMPLE-message-id" : null,
	}));
}
afterEach(() => mock.restore());

async function openRequest(values: { userId: number | null; email: string }): Promise<number> {
	const [row] = await db
		.insert(rightsRequests)
		.values({
			...values,
			kind: "access",
			details: `what do you hold ${id}`,
			dueAt: new Date(Date.now() + RIGHTS_RESPONSE_DAYS * 86_400_000),
		})
		.returning({ id: rightsRequests.id });
	requestIds.push(row.id);
	return row.id;
}

async function resolve(requestId: number, note: string) {
	const res = await app.fetch(
		new Request(`http://localhost/api/admin/rights-requests/${requestId}/resolve`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: adminCookie },
			body: JSON.stringify({ note }),
		}),
	);
	expect(res.status).toBe(200);
	return (await res.json()) as { resolved: boolean; emailed: boolean };
}

describe("resolving a request whose account is gone", () => {
	it("emails the answer to the address the request was made from", async () => {
		const address = `gone-${id}@example.com`;
		const requestId = await openRequest({ userId: null, email: address });
		const sends = spyOnSends(true);

		const body = await resolve(requestId, "We hold your email address.\nNothing else.");

		expect(body).toEqual({ resolved: true, emailed: true });
		const recipients = sends.mock.calls.map(([args]) => args.to);
		expect(recipients, "the answer went nowhere, or somewhere else").toEqual([address]);
		// The note is the answer, since there is no account to read it in.
		expect(sends.mock.calls[0][0].html).toContain("We hold your email address.<br>Nothing else.");
	});

	it("tells the operator when the provider did not accept the email", async () => {
		const address = `unsent-${id}@example.com`;
		const requestId = await openRequest({ userId: null, email: address });
		const sends = spyOnSends(false);

		const body = await resolve(requestId, "Answered.");

		// Still resolved — the answer was given — but the one message that carries it did not go,
		// and the operator is the only person left who can send it another way. The send has to
		// have been attempted, or a route that never emails would satisfy this test too.
		expect(sends.mock.calls.map(([args]) => args.to)).toEqual([address]);
		expect(body).toEqual({ resolved: true, emailed: false });
	});
});

describe("resolving a request whose account still exists", () => {
	it("tells them in-app and emails them exactly once", async () => {
		const account = await createAccount(`rights_live_${id}`);
		const requestId = await openRequest({ userId: account.userId, email: account.email });
		const sends = spyOnSends(true);

		const body = await resolve(requestId, "Corrected.");

		expect(body).toEqual({ resolved: true, emailed: true });
		expect(
			sends.mock.calls.map(([args]) => args.to),
			"a person with an account was emailed more than once, or not at all",
		).toEqual([account.email]);
		const told = await db
			.select({ id: notifications.id })
			.from(notifications)
			.where(
				and(
					eq(notifications.userId, account.userId),
					eq(notifications.kind, "rights_request_resolved"),
				),
			);
		expect(told).toHaveLength(1);
	});
});
