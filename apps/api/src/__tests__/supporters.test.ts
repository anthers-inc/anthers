// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The supporters page, as the server serves it.
 *
 * 🚨 **Every assertion is about disclosure.** The page publishes names and an order; the
 * lifetime totals that produce that order are read, grouped on, and must never leave the
 * server. A unit test covers the grouping rules — this covers the query that feeds them,
 * which is where the amount is actually in scope and could escape.
 *
 * ⭐ **Eligibility is having EVER supported.** A query over live standing would drop
 * somebody the month they stopped giving, which is the opposite of what the page is for, so
 * the past-supporter case is asserted directly rather than assumed from the SQL.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { accountCycles, accounts, users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const req = (path: string, options?: RequestInit) =>
	app.fetch(new Request(`http://localhost${path}`, options));

const RUN = crypto.randomUUID().slice(0, 8);

async function signUp(username: string) {
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

async function idOf(username: string): Promise<number> {
	const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
	return row.id;
}

/** Somebody who gave `perCycle` for `cycles` months, and has now stopped. */
async function supporter(tag: string, perCycle: number, cycles: number, listed = true) {
	const username = `sup_${tag}_${RUN}`;
	const cookie = await signUp(username);
	const userId = await idOf(username);
	await db
		.insert(accounts)
		.values({ userId, anthersSupport: "0.00", isActive: true, listedAsSupporter: listed })
		.onConflictDoNothing();
	for (let i = 0; i < cycles; i++) {
		await db.insert(accountCycles).values({
			userId,
			billingCycle: `2029-${String(i + 1).padStart(2, "0")}-01`,
			anthersSupport: perCycle.toFixed(2),
		});
	}
	return { username, userId, cookie };
}

async function page() {
	const res = await req("/api/subscriptions/supporters");
	expect(res.status).toBe(200);
	return (await res.json()) as { groups: { username: string; displayName: string | null }[][] };
}

const flatNames = (groups: { username: string }[][]) => groups.flat().map((e) => e.username);

describe("the supporters page", () => {
	let stopped: { username: string };
	let optedOut: { username: string };

	beforeAll(async () => {
		// Three current supporters so a band is never smaller than the minimum, plus the two
		// cases under test.
		await supporter("a", 12, 6);
		await supporter("b", 12, 6);
		await supporter("c", 12, 6);
		// Gave for three months in the past and stopped: `accounts.anthersSupport` is 0.
		stopped = await supporter("stopped", 6, 3);
		optedOut = await supporter("out", 12, 6, false);
	}, DB_SETUP_TIMEOUT);

	it("🚨 publishes names and an order, and never an amount", async () => {
		const { groups } = await page();
		expect(groups.length).toBeGreaterThan(0);
		for (const group of groups) {
			for (const entry of group) {
				// The exact serialized shape — anything else here is money leaving the server.
				expect(Object.keys(entry).sort()).toEqual(["displayName", "username"]);
			}
		}
	});

	it("⭐ keeps somebody who supported in the past and has since stopped", async () => {
		// Their live standing is $0. Reading `accounts.anthers_support` instead of the cycle
		// record would drop them, which is the failure this page exists not to have.
		const [acct] = await db
			.select({ now: accounts.anthersSupport })
			.from(accounts)
			.where(eq(accounts.userId, await idOf(stopped.username)));
		expect(Number(acct.now)).toBe(0);
		expect(flatNames((await page()).groups)).toContain(stopped.username);
	});

	it("🚨 leaves out anybody who opted out", async () => {
		expect(flatNames((await page()).groups)).not.toContain(optedOut.username);
	});

	it("leaves out an account that has never given anything", async () => {
		const username = `sup_never_${RUN}`;
		await signUp(username);
		const userId = await idOf(username);
		await db
			.insert(accounts)
			.values({ userId, anthersSupport: "0.00", isActive: true })
			.onConflictDoNothing();
		expect(flatNames((await page()).groups)).not.toContain(username);
	});

	it("⭐ lists somebody by default, and lets them take themselves off", async () => {
		const person = await supporter("toggle", 12, 6);
		expect(flatNames((await page()).groups)).toContain(person.username);

		const off = await req("/api/subscriptions/supporters/listing", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: person.cookie },
			body: JSON.stringify({ listed: false }),
		});
		expect(off.status).toBe(200);
		expect((await off.json()).listed).toBe(false);
		expect(flatNames((await page()).groups)).not.toContain(person.username);

		// And back on, because a decision a person cannot reverse is not a preference.
		const on = await req("/api/subscriptions/supporters/listing", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: person.cookie },
			body: JSON.stringify({ listed: true }),
		});
		expect(on.status).toBe(200);
		expect(flatNames((await page()).groups)).toContain(person.username);
	});

	it("reports the current setting to the person it belongs to", async () => {
		const person = await supporter("reads", 3, 1);
		const res = await req("/api/subscriptions/supporters/listing", {
			headers: { Cookie: person.cookie },
		});
		expect(res.status).toBe(200);
		expect((await res.json()).listed).toBe(true);
	});

	it("needs a session to change, and the page itself needs none", async () => {
		const anonymous = await req("/api/subscriptions/supporters/listing", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ listed: false }),
		});
		expect(anonymous.status).toBe(401);
		// The page is public — a thank-you nobody can read is not a thank-you.
		expect((await req("/api/subscriptions/supporters")).status).toBe(200);
	});
});
