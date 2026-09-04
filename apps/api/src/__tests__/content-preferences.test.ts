// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Adulthood verification by the funding type of the card on file.
 *
 * 🚨 **The assertion this suite exists for is that `unknown` does NOT pass.** Stripe returns
 * `credit`, `debit`, `prepaid` or `unknown`, and `unknown` is common on international cards —
 * so it is the value somebody will one day be tempted to read generously, and the moment it
 * passes, the one method Anthers has that carries an age signal quietly stops carrying one
 * for a whole population while every surface keeps describing it as effective. A test that
 * only checked `credit` passing and `debit` failing would be green through that change.
 *
 * ⚠️ **The refusals are asserted as separate values rather than as "it failed"**, because
 * each has a different remedy and one of them has none. Telling somebody whose only card is
 * debit to try again is the single worst thing this endpoint could say, and it is what a
 * collapsed error would produce.
 *
 * ⭐ **What is NOT stored is asserted too.** The whole privacy argument for this method is
 * that no date of birth crosses our boundary and nothing about the card is kept — so the row
 * is read back column by column and checked for the absence, since nothing else in the
 * repository could tell that a brand or a last4 had crept in.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { accounts, users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import app from "../index";
import { getStripe, setStripeClient } from "../lib/stripe";
import { purgeAccountsCreatedHere } from "./cleanup";
import { purgeFixtureAccounts } from "./cleanup.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const run = crypto.randomUUID().slice(0, 8);
const personName = `adult_${run}`;

/**
 * A Stripe whose card list this suite sets per test.
 *
 * `listCalls` is what proves re-enabling does not re-verify — an assertion about something
 * NOT happening, which needs a counter because no state change would show it.
 */
function fakeStripe(fundings: string[]) {
	const state = { fundings, listCalls: 0 };
	const client = {
		paymentMethods: {
			list: () => {
				state.listCalls += 1;
				return Promise.resolve({
					data: state.fundings.map((funding, i) => ({
						id: `pm_fake_${i}`,
						card: { funding, brand: "visa", last4: "4242" },
					})),
				});
			},
		},
	} as unknown as Stripe;
	return { client, state };
}

let realClient: Stripe | null;
let cookie: string;
let userId: number;

async function signUp(username: string): Promise<string> {
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
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

function get() {
	return req("/api/accounts/me/adult-access", { headers: { Cookie: cookie, Origin: ORIGIN } });
}

function enable() {
	return req("/api/accounts/me/adult-access", {
		method: "POST",
		headers: { Cookie: cookie, Origin: ORIGIN },
	});
}

function disable() {
	return req("/api/accounts/me/adult-access", {
		method: "DELETE",
		headers: { Cookie: cookie, Origin: ORIGIN },
	});
}

/**
 * Put the account back to "never verified, opted out", so each test starts from the door.
 *
 * ⚠️ Inserts the row if it is missing, because **signing up does not create one** — an
 * `accounts` row appears on first payment. That is also why `no_card` is the honest answer
 * for somebody who has never paid: no account row means no Stripe customer means no card to
 * read, and the three states collapse to the same true sentence.
 */
async function reset(opts: { customerId: string }) {
	const set = {
		adultOptIn: false,
		adultVerifiedAt: null,
		adultVerifiedMethod: null,
		stripeCustomerId: opts.customerId,
	};
	const updated = await db
		.update(accounts)
		.set(set)
		.where(eq(accounts.userId, userId))
		.returning({ id: accounts.id });
	if (updated.length === 0) await db.insert(accounts).values({ userId, ...set });
}

async function accountRow() {
	const [row] = await db.select().from(accounts).where(eq(accounts.userId, userId));
	return row;
}

/** Point the app at a Stripe holding exactly these funding types. */
function withCards(fundings: string[]) {
	const fake = fakeStripe(fundings);
	setStripeClient(fake.client);
	return fake;
}

describe("adulthood verification by card funding", () => {
	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username = ${personName}`);
		realClient = getStripe();
		cookie = await signUp(personName);
		const [row] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, personName));
		userId = row!.id;
	}, DB_SETUP_TIMEOUT);

	// In `afterAll` so it runs on a bail as well as a pass, and the Stripe client is put
	// back either way — leaving a fake installed would make every suite that runs after
	// this one talk to it.
	afterAll(async () => {
		setStripeClient(realClient);
		await purgeFixtureAccounts([personName]);
	});

	describe("an account that has not enabled it", () => {
		it("cannot reach Adult work, and says so with both facts", async () => {
			await reset({ customerId: "" });
			const body = await (await get()).json();
			expect(body.canReach).toBe(false);
			expect(body.optIn).toBe(false);
			expect(body.verifiedAt).toBeNull();
		});
	});

	describe("what the funding type decides", () => {
		it("passes a credit card, and records the verdict, the moment and the method", async () => {
			await reset({ customerId: "cus_fake" });
			withCards(["credit"]);

			const res = await enable();
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.canReach).toBe(true);
			expect(body.optIn).toBe(true);
			expect(body.method).toBe("card_funding");
			expect(body.verifiedAt).not.toBeNull();
		});

		it("refuses a debit card, and the refusal names its own reason", async () => {
			// Debit has no age floor at all — teen debit programs clear an undifferentiated
			// paywall — which is the entire reason the funding type is read rather than the
			// fact of payment.
			await reset({ customerId: "cus_fake" });
			withCards(["debit"]);

			const res = await enable();
			expect(res.status).toBe(409);
			const body = await res.json();
			expect(body.code).toBe("funding_not_credit");
			// ⭐ Says plainly that nothing routes around it. The wiki's *Content Standards* is explicit that the
			// exclusion is real and unmitigated, and that gesturing at a path which does not
			// exist would be worse than the exclusion itself.
			expect(body.error).toContain("credit card");
			expect(body.error).not.toContain("try again");
		});

		it("refuses a prepaid card", async () => {
			await reset({ customerId: "cus_fake" });
			withCards(["prepaid"]);
			expect((await (await enable()).json()).code).toBe("funding_not_credit");
		});

		it("🚨 refuses `unknown` funding, and does not read it generously", async () => {
			// The assertion this suite exists for. `unknown` is common on international
			// cards, so reading it as a pass is the change that would quietly turn the age
			// signal off for a whole population while every surface kept claiming it was on.
			await reset({ customerId: "cus_fake" });
			withCards(["unknown"]);
			expect((await (await enable()).json()).code).toBe("funding_not_credit");
			expect((await accountRow()).adultVerifiedAt).toBeNull();
		});

		it("passes when one of several cards is credit, whatever order they arrive in", async () => {
			// The question is whether this accountholder holds a credit line at all, and
			// holding one is not undone by also having a debit card. Reading only the newest
			// card would make the answer depend on the order somebody added them.
			await reset({ customerId: "cus_fake" });
			withCards(["debit", "credit"]);
			expect((await enable()).status).toBe(200);

			await reset({ customerId: "cus_fake" });
			withCards(["credit", "debit"]);
			expect((await enable()).status).toBe(200);
		});

		it("refuses when there is no card at all, and says something different", async () => {
			// A different remedy from the debit case: this person CAN get in, by adding a
			// card. Collapsing the two would tell them the opposite of the truth.
			await reset({ customerId: "" });
			withCards(["credit"]);

			const res = await enable();
			expect(res.status).toBe(409);
			expect((await res.json()).code).toBe("no_card");
		});
	});

	describe("what is kept, and what is never kept", () => {
		it("stores a boolean, a timestamp and a method, and nothing about the card", async () => {
			// 🚨 The privacy property the whole method rests on, asserted rather than
			// assumed. No date of birth crosses our boundary and nothing about the card is
			// retained — not the brand, not the last four, not the funding value just read.
			// Nothing else in the repository could tell that one had crept in.
			await reset({ customerId: "cus_fake" });
			withCards(["credit"]);
			await enable();

			const row = await accountRow();
			expect(row.adultOptIn).toBe(true);
			expect(row.adultVerifiedAt).not.toBeNull();
			expect(row.adultVerifiedMethod).toBe("card_funding");

			const stored = JSON.stringify(row);
			expect(stored).not.toContain("4242");
			expect(stored).not.toContain("visa");
			expect(stored).not.toContain("credit");
			// And no column learned to hold a birthday.
			expect(Object.keys(row).join(" ").toLowerCase()).not.toContain("birth");
		});

		it("writes nothing at all when the funding type refuses", async () => {
			await reset({ customerId: "cus_fake" });
			withCards(["debit"]);
			await enable();

			const row = await accountRow();
			expect(row.adultOptIn).toBe(false);
			expect(row.adultVerifiedAt).toBeNull();
			expect(row.adultVerifiedMethod).toBeNull();
		});
	});

	describe("turning it off and on again", () => {
		it("clears the opt-in and keeps the verification", async () => {
			// 🚨 The opposite of what a privacy instinct suggests, and the right way round.
			// What is stored is that this account was shown to belong to an adult — a fact
			// that does not expire and says nothing identifying. Clearing it would make
			// somebody re-prove adulthood every time they changed their mind about what they
			// want to see.
			await reset({ customerId: "cus_fake" });
			withCards(["credit"]);
			await enable();

			const res = await disable();
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.optIn).toBe(false);
			expect(body.canReach).toBe(false);
			expect(body.verifiedAt).not.toBeNull();
		});

		it("does not re-verify an account that already has, even if the cards would now fail", async () => {
			// Verification is once, at enablement. Re-reading the cards would make the gate
			// fail for an adult who has since canceled the credit card that verified them,
			// which is a worse outcome than the one it would be protecting against.
			await reset({ customerId: "cus_fake" });
			withCards(["credit"]);
			await enable();
			await disable();

			const fake = withCards(["debit"]);
			const res = await enable();
			expect(res.status).toBe(200);
			expect((await res.json()).canReach).toBe(true);
			// The counter is what proves it: no state change would have shown that Stripe
			// was never asked.
			expect(fake.state.listCalls).toBe(0);
		});
	});

	describe("who may ask", () => {
		it("refuses a signed-out visitor on all three verbs", async () => {
			for (const method of ["GET", "POST", "DELETE"]) {
				const res = await req("/api/accounts/me/adult-access", {
					method,
					headers: { Origin: ORIGIN },
				});
				expect(res.status, method).toBe(401);
			}
		});
	});
});
