// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Releasing a Work requires completed payout setup.
 *
 * 🚨 **The Creator Terms claimed this for months and the code did not do it** — *"a
 * completed payment setup with Stripe before you can publish anything"* — while `/parents`
 * had grown a whole paragraph describing the gap as a gap. Three documents, two of them
 * user-facing, and only a reader comparing all three could tell which was true. That is
 * exactly the shape `about-claims.test.ts` was written for, arriving from the other side:
 * a promise with nothing exercising it rots as quietly as an absence does.
 *
 * **Why the gate exists** (Parker, 2026-08-28), because a future reader will meet it as an
 * obstacle and needs both halves:
 *
 *   1. It is the **only** structural check making every creator here an adult. Stripe runs
 *      identity verification and will not verify a minor; Anthers deliberately holds no
 *      date of birth and no ID.
 *   2. It means **no released Work is payout-ineligible**. Ungated work earns from the Time
 *      Pool by the time people spend with it, so releasing without a way to be paid books a
 *      debt to somebody we cannot settle.
 *
 * ⚠️ **The case that is easiest to get wrong is the one that must NOT be gated.** Stripe can
 * hold an account at any time, long after release. If that re-closed an already-live Work's
 * edits, a creator whose account went under review would lose the ability to fix a typo, to
 * correct a rating, or to take the Work down — punishing them for something Stripe did. The
 * gate asks only about the moment of release.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { stripeAccounts, users, works } from "@anthers/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import { purgeFixtureAccounts } from "./cleanup.js";
import { enablePayoutsFor } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

const ORIGIN = "http://localhost:3000";
const req = (path: string, options?: RequestInit) =>
	app.fetch(new Request(`http://localhost${path}`, options));

const id = crypto.randomUUID().slice(0, 8);
/** One account per payout state, so no test has to mutate another's. */
const noneName = `paynone_${id}`;
const heldName = `payheld_${id}`;
const readyName = `payready_${id}`;

async function signUp(username: string): Promise<{ cookie: string; userId: number }> {
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
	const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
	return { cookie: res.headers.get("Set-Cookie")!.split(";")[0], userId: row!.id };
}

describe("releasing requires payout setup", () => {
	let none: { cookie: string; userId: number };
	let held: { cookie: string; userId: number };
	let ready: { cookie: string; userId: number };
	const created: number[] = [];

	beforeAll(async () => {
		await db.execute(
			sql`DELETE FROM users WHERE username IN (${noneName}, ${heldName}, ${readyName})`,
		);
		none = await signUp(noneName);
		held = await signUp(heldName);
		ready = await signUp(readyName);

		// Onboarding finished, but Stripe will not send money — under review, a missing
		// document, a restricted country. The state that proves the gate reads BOTH flags:
		// an implementation checking only `onboardingComplete` passes every other test here
		// and lets this creator through.
		await db.insert(stripeAccounts).values({
			userId: held.userId,
			stripeAccountId: `acct_test_held_${id}`,
			onboardingComplete: true,
			payoutsEnabled: false,
			chargesEnabled: false,
		});
		await enablePayoutsFor(ready.userId);
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		if (created.length > 0) await db.delete(works).where(inArray(works.id, created));
		await purgeFixtureAccounts([noneName, heldName, readyName]);
	});

	/** A private, rated text Work — so the only thing standing between it and release is payouts. */
	async function makeWork(cookie: string): Promise<number> {
		const res = await req("/api/content/works", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({
				type: "text",
				title: `Payout fixture ${id}`,
				body: "A short thing.",
				maturity: "general",
			}),
		});
		expect(res.status).toBe(201);
		const { work } = await res.json();
		created.push(work.id);
		return work.id;
	}

	const patch = (workId: number, body: Record<string, unknown>, cookie: string) =>
		req(`/api/content/works/${workId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify(body),
		});

	async function reload(workId: number) {
		const [row] = await db.select().from(works).where(eq(works.id, workId));
		return row;
	}

	it("refuses a creator who has never connected an account, and leaves the Work private", async () => {
		const workId = await makeWork(none.cookie);
		const res = await patch(workId, { visibility: "released" }, none.cookie);
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.code).toBe("payouts_required");
		// The Studio needs to tell "start setup" from "wait for Stripe" without guessing.
		expect(body.connected).toBe(false);
		expect((await reload(workId)).visibility).toBe("private");
	});

	it("refuses a creator Stripe is holding, even though onboarding finished", async () => {
		const workId = await makeWork(held.cookie);
		const res = await patch(workId, { visibility: "released" }, held.cookie);
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.code).toBe("payouts_required");
		expect(body.connected).toBe(true);
		// A different message, because a different person has to do something next.
		expect(body.error).toContain("Stripe still needs something from you");
		expect((await reload(workId)).visibility).toBe("private");
	});

	it("releases once payouts are ready", async () => {
		const workId = await makeWork(ready.cookie);
		const res = await patch(workId, { visibility: "released" }, ready.cookie);
		expect(res.status).toBe(200);
		expect((await reload(workId)).visibility).toBe("released");
	});

	// The same rule every other readiness refusal follows: a creator who declares a rating
	// and ticks release in one request must not lose the declaration to the refusal.
	it("keeps a rating declared in the refused request", async () => {
		const workId = await makeWork(none.cookie);
		const res = await patch(
			workId,
			{ maturity: "mature", maturityNotes: ["violence"], visibility: "released" },
			none.cookie,
		);
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("payouts_required");
		const row = await reload(workId);
		expect(row.visibility).toBe("private");
		expect(row.maturity).toBe("mature");
		expect(row.maturityNotes).toEqual(["violence"]);
	});

	// 🚨 The half that must stay open. See the note at the top of this file: a creator whose
	// account is held after release keeps every ordinary power over their own Work.
	it("still lets a creator edit a live Work after their payouts lapse", async () => {
		const workId = await makeWork(ready.cookie);
		expect((await patch(workId, { visibility: "released" }, ready.cookie)).status).toBe(200);

		await db
			.update(stripeAccounts)
			.set({ payoutsEnabled: false })
			.where(eq(stripeAccounts.userId, ready.userId));
		try {
			const res = await patch(workId, { title: `Edited ${id}` }, ready.cookie);
			expect(res.status).toBe(200);
			expect((await reload(workId)).title).toBe(`Edited ${id}`);

			// And taking it down is still theirs to do.
			expect((await patch(workId, { visibility: "private" }, ready.cookie)).status).toBe(200);

			// But re-releasing is gated again, because that is a release.
			const again = await patch(workId, { visibility: "released" }, ready.cookie);
			expect(again.status).toBe(409);
			expect((await again.json()).code).toBe("payouts_required");
		} finally {
			await enablePayoutsFor(ready.userId);
		}
	});
});
