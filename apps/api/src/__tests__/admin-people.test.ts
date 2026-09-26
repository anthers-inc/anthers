// SPDX-License-Identifier: Apache-2.0
/**
 * The People surface of the admin API: the account list, the detail with its payout
 * review, and the conclusion of that review.
 *
 * What this guards, in order of how badly its absence would read:
 *
 * 1. **The list is not a directory.** An account with no suspension and no open reports
 *    is absent from the bare list, and present only when named by a search. The queue's
 *    People filter holds this line for reports; the People page holds it for accounts.
 * 2. **The detail carries everything an operator reads before acting on a person** —
 *    the suspension state, the recorded actions, and the payout hold with its window.
 * 3. **A concluded review is recorded**, so the finding does not vanish: a
 *    `payout_review` row lands in `moderation_actions` naming who concluded it and what
 *    (if anything) they found tainted. Before this surface shipped, the finding was
 *    accepted by the service and written nowhere.
 *
 * ⚠️ Reports are inserted directly rather than through the public intake — this suite
 * tests the operator's half, and `fileReport`'s escalation path is not what it exercises.
 * No `abuse` reason is used, so nothing here writes a row a cron job escalates.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { moderationActions, moderationReports } from "@anthers/db/schema";
import { and, eq } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const testFetch = app.fetch;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const run = crypto.randomUUID().slice(0, 8);
const made: number[] = [];

afterAll(async () => {
	// The shared account purge takes reports filed by these accounts and reports filed
	// about them, but a `moderation_actions` row whose subject is a `user` survives both
	// purges — its actor is an admin account, and the log's `set null` columns are the
	// design working. This suite's rows are fixture noise rather than record, so they go
	// by subject here, before the account purge runs and the subject stops being findable.
	for (const userId of made) {
		await db
			.delete(moderationActions)
			.where(
				and(eq(moderationActions.subjectType, "user"), eq(moderationActions.subjectId, userId)),
			);
	}
});

describe("Admin People surface", () => {
	let adminCookie: string;
	/** An ordinary account, unreported and unsuspended — the directory-line fixture. */
	let quietId: number;
	let quietHandle: string;
	/** A reported account — in the bare list through its open report. */
	let reportedId: number;
	/** A suspended creator — in the bare list, with an open payout review. */
	let suspendedCreatorId: number;

	beforeAll(async () => {
		adminCookie = (await createAdminFixture("people")).cookie;

		const quiet = await createAccount(`people_quiet_${run}`);
		quietId = quiet.userId;
		quietHandle = quiet.handle; // the issued handle, not the typed name — names are normalized
		made.push(quiet.userId);

		const reported = await createAccount(`people_reported_${run}`);
		reportedId = reported.userId;
		made.push(reported.userId);

		const suspender = await createAccount(`people_suspended_${run}`);
		suspendedCreatorId = suspender.userId;
		made.push(suspender.userId);

		// One open report naming the reported account, from the quiet account. `spam` is
		// not a legal reason, so nothing here escalates anything anywhere.
		await db.insert(moderationReports).values({
			subjectType: "user",
			subjectId: reportedId,
			reporterId: quietId,
			reason: "spam",
			details: `people fixture ${run}`,
		});

		// Suspended by the service, the way the console's Suspend action reaches it.
		const { suspendAccount } = await import("../services/moderation.js");
		const operator = await createAdminFixture("people-suspend-op");
		await suspendAccount({
			userId: suspendedCreatorId,
			adminId: operator.id,
			reason: "spam",
			note: `people fixture ${run}`,
		});
	}, DB_SETUP_TIMEOUT);

	it("lists no account that is neither suspended nor reported", async () => {
		const res = await req("/api/admin/people", { headers: { Cookie: adminCookie } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { people: { id: number }[] };
		expect(body.people.map((p) => p.id)).not.toContain(quietId);
	});

	it("lists the reported account and the suspended one", async () => {
		const res = await req("/api/admin/people", { headers: { Cookie: adminCookie } });
		const body = (await res.json()) as {
			people: { id: number; openReports: number; suspendedAt: string | null }[];
		};
		const ids = body.people.map((p) => p.id);
		expect(ids).toContain(reportedId);
		expect(ids).toContain(suspendedCreatorId);
		const reported = body.people.find((p) => p.id === reportedId)!;
		expect(reported.openReports).toBe(1);
		expect(reported.suspendedAt).toBeNull();
		const suspended = body.people.find((p) => p.id === suspendedCreatorId)!;
		expect(suspended.suspendedAt).not.toBeNull();
	});

	it(
		"finds a quiet account only when the search names it",
		async () => {
			const res = await req(`/api/admin/people?q=${encodeURIComponent(quietHandle)}`, {
				headers: { Cookie: adminCookie },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { people: { id: number }[] };
			const ids = body.people.map((p) => p.id);
			expect(ids).toContain(quietId);
			// And the search is the only way it appears: the bare list already excluded it.
		},
		DB_SETUP_TIMEOUT,
	);

	it("answers 401 without an admin session", async () => {
		const res = await req("/api/admin/people");
		expect(res.status).toBe(401);
	});

	it("gives the detail: person, actions, and an open payout review for a suspended creator", async () => {
		const res = await req(`/api/admin/people/${suspendedCreatorId}`, {
			headers: { Cookie: adminCookie },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			person: { id: number; suspendedAt: string; suspendedUntil: string | null };
			actions: { action: string }[];
			payout: { heldAmount: string; resolvedAt: string | null; releasesAt: string } | null;
		};
		expect(body.person.id).toBe(suspendedCreatorId);
		expect(body.person.suspendedUntil).toBeNull();
		// The suspension is in the log the detail renders.
		expect(body.actions.map((a) => a.action)).toContain("suspend");
		// The payout read is for the same account the detail is about.
		expect(body.payout).not.toBeNull();
		expect(body.payout!.resolvedAt).toBeNull();
		expect(typeof body.payout!.releasesAt).toBe("string");
	});

	it("answers a detail with a null payout for an account never held", async () => {
		const res = await req(`/api/admin/people/${reportedId}`, {
			headers: { Cookie: adminCookie },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { payout: unknown };
		expect(body.payout).toBeNull();
	});

	it("answers 404 for an id that names nobody", async () => {
		const res = await req("/api/admin/people/999999999", { headers: { Cookie: adminCookie } });
		expect(res.status).toBe(404);
	});

	it(
		"concludes a review with a finding, and the finding is recorded in the log",
		async () => {
			const res = await req(`/api/admin/people/${suspendedCreatorId}/payout-review`, {
				method: "POST",
				headers: {
					Cookie: adminCookie,
					"Content-Type": "application/json",
					Origin: "http://localhost:3000",
				},
				body: JSON.stringify({ taintedAmount: "12.50", note: `finding fixture ${run}` }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { released: boolean };
			expect(body.released).toBe(true);

			// The record: a payout_review row in the log, naming the operator and the amount.
			const rows = await db
				.select({ action: moderationActions.action, note: moderationActions.note })
				.from(moderationActions)
				.where(eq(moderationActions.subjectId, suspendedCreatorId));
			const review = rows.find((r) => r.action === "payout_review");
			expect(review).toBeDefined();
			expect(review!.note).toContain("12.50");
			expect(review!.note).toContain("earned by the violation");
		},
		DB_SETUP_TIMEOUT,
	);

	it("refuses to conclude a review twice, and says why in a sentence the operator reads", async () => {
		const res = await req(`/api/admin/people/${suspendedCreatorId}/payout-review`, {
			method: "POST",
			headers: {
				Cookie: adminCookie,
				"Content-Type": "application/json",
				Origin: "http://localhost:3000",
			},
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string; code: string };
		expect(body.code).toBe("no_open_review");
		expect(body.error).toContain("no open payout review");
	});

	it("refuses a malformed tainted amount at the edge rather than as a 500", async () => {
		const res = await req(`/api/admin/people/${reportedId}/payout-review`, {
			method: "POST",
			headers: {
				Cookie: adminCookie,
				"Content-Type": "application/json",
				Origin: "http://localhost:3000",
			},
			body: JSON.stringify({ taintedAmount: "twelve dollars" }),
		});
		expect(res.status).toBe(400);
	});
});
