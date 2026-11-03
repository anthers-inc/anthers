// SPDX-License-Identifier: Apache-2.0
/**
 * The cost an unauthenticated caller can make the API pay.
 *
 * Every door here mints or checks a short secret with argon2id, and every one of them answers
 * before anybody is signed in. The properties pinned are the ones with no visible symptom:
 * a cap that a burst walks straight through, a throttle two concurrent requests both win, and
 * a refusal that is cheaper — or a different shape — for the address that has an account.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "@anthers/db/client";
import { adminSignInCodes, signupCodes } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index.js";
import { createAdminAccount, issueAdminSignInCode } from "../services/admin-accounts.js";
import {
	checkSignupCode,
	issueSignupCode,
	SIGNUP_CODE_MAX_ATTEMPTS,
} from "../services/signup-codes.js";
import { purgeAdminAccountsCreatedHere } from "./cleanup.js";

const RUN = `cost${Date.now()}${Math.floor(Math.random() * 1000)}`;
const addr = (tag: string) => `${RUN}-${tag}@example.com`;

const ADMIN_HOST = "http://admin.anthers.test";
let savedAdminUrl: string | undefined;

beforeAll(() => {
	savedAdminUrl = process.env.ADMIN_URL;
	process.env.ADMIN_URL = ADMIN_HOST;
});

afterAll(async () => {
	if (savedAdminUrl === undefined) delete process.env.ADMIN_URL;
	else process.env.ADMIN_URL = savedAdminUrl;
});

purgeAdminAccountsCreatedHere();

/** Run `work` with the limiter's test-session opt-out removed, and put it back however it ends. */
async function withLiveLimits<T>(work: () => Promise<T>): Promise<T> {
	const knob = process.env.RATE_LIMITS_DISABLED;
	delete process.env.RATE_LIMITS_DISABLED;
	try {
		return await work();
	} finally {
		if (knob !== undefined) process.env.RATE_LIMITS_DISABLED = knob;
	}
}

describe("the emailed-code attempt cap under a burst", () => {
	test("concurrent wrong guesses cannot spend more than the cap", async () => {
		const email = addr("burst");
		const issued = await issueSignupCode(email);
		expect(issued.code).not.toBeNull();

		// Ten at once, all reading the same pre-increment counter if the claim is not atomic.
		const attempts = await Promise.all(
			Array.from({ length: SIGNUP_CODE_MAX_ATTEMPTS * 2 }, () => checkSignupCode(email, "ZZZZZZ")),
		);
		const compared = attempts.filter(
			(a) => !a.ok && (a as { reason: string }).reason === "wrong_code",
		);

		// 🚨 Only a winner of the atomic claim reaches the hash comparison; the rest are
		// refused as spent before their code is ever looked at.
		expect(compared).toHaveLength(SIGNUP_CODE_MAX_ATTEMPTS);
		const [stored] = await db
			.select({ attempts: signupCodes.attempts })
			.from(signupCodes)
			.where(eq(signupCodes.email, email));
		expect(stored?.attempts).toBe(SIGNUP_CODE_MAX_ATTEMPTS);
	});
});

describe("the resend throttle under a burst", () => {
	test("concurrent requests mint exactly one code", async () => {
		const email = addr("mint");
		const issued = await Promise.all(Array.from({ length: 5 }, () => issueSignupCode(email)));
		expect(issued.filter((r) => r.code !== null)).toHaveLength(1);
		expect(issued.filter((r) => r.throttled)).toHaveLength(4);
	});
});

describe("the doors that hash before anybody signs in", () => {
	test("/signup/begin refuses a burst per address", async () => {
		const ip = "203.0.113.41";
		const body = JSON.stringify({
			picks: { badge: null, follow: [], badges: [] },
			pow: { id: 1, nonce: 0 },
		});
		const statuses = await withLiveLimits(async () => {
			await db.execute(
				sql`DELETE FROM rate_limits WHERE door = 'auth-signup-begin' AND ip = ${ip}`,
			);
			const out: number[] = [];
			for (let i = 0; i < 12; i++) {
				const res = await app.request("/api/auth/signup/begin", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost:3000",
						"X-Forwarded-For": ip,
					},
					body,
				});
				out.push(res.status);
			}
			return out;
		});
		expect(statuses.filter((s) => s === 429)).toHaveLength(2);
		expect(statuses.slice(0, 10)).not.toContain(429);
	});

	test("/admin/auth/signin/start refuses a burst per address", async () => {
		const ip = "203.0.113.42";
		const statuses = await withLiveLimits(async () => {
			await db.execute(sql`DELETE FROM rate_limits WHERE door = 'admin-code-send' AND ip = ${ip}`);
			const out: number[] = [];
			for (let i = 0; i < 12; i++) {
				const res = await app.request(`${ADMIN_HOST}/api/admin/auth/signin/start`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: ADMIN_HOST,
						"X-Forwarded-For": ip,
					},
					body: JSON.stringify({ email: addr(`send${i}`) }),
				});
				out.push(res.status);
			}
			return out;
		});
		expect(statuses.filter((s) => s === 429)).toHaveLength(2);
	});
});

describe("an admin sign-in refusal tells the caller nothing", () => {
	const call = (path: string, body: unknown, ip: string) =>
		app.request(`${ADMIN_HOST}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ADMIN_HOST,
				// A door of its own per case, so a suite sharing this process's live limiter
				// (rate-limit.test.ts removes the opt-out for the whole run) does not measure
				// another case's spent window.
				"X-Forwarded-For": ip,
			},
			body: JSON.stringify(body),
		});

	async function medianVerify(email: string, ip: string): Promise<number> {
		const times: number[] = [];
		for (let i = 0; i < 5; i++) {
			const start = performance.now();
			const res = await call("/api/admin/auth/signin/verify", { email, code: "ZZZZZZ" }, ip);
			expect(res.status).toBe(400);
			times.push(performance.now() - start);
		}
		times.sort((a, b) => a - b);
		return times[2];
	}

	test("the status, body and cost of a wrong code are the same either way", async () => {
		const admin = addr("admin");
		await createAdminAccount({ email: admin, displayName: "Cost Admin" }, null);
		await issueAdminSignInCode(admin);

		const stranger = addr("stranger");
		const adminRes = await call(
			"/api/admin/auth/signin/verify",
			{ email: admin, code: "ZZZZZZ" },
			"203.0.113.61",
		);
		const strangerRes = await call(
			"/api/admin/auth/signin/verify",
			{ email: stranger, code: "ZZZZZZ" },
			"203.0.113.60",
		);

		expect(adminRes.status).toBe(strangerRes.status);
		expect(await adminRes.text()).toBe(await strangerRes.text());

		// A miss spends the same argon2 comparison a hit does, so the clock cannot say which
		// address has an admin account. The bound is loose because a shared runner is noisy;
		// the bug it catches is a miss that returns in microseconds rather than in tens of
		// milliseconds, which is a difference of two orders of magnitude, not thirty percent.
		await medianVerify(stranger, "203.0.113.60");
		const adminMs = await medianVerify(admin, "203.0.113.61");
		const strangerMs = await medianVerify(stranger, "203.0.113.60");
		const ratio = Math.max(adminMs, strangerMs) / Math.min(adminMs, strangerMs);
		expect(ratio).toBeLessThan(3);
	});

	test("an exhausted code answers with the one refusal, not a distinguisher", async () => {
		const email = addr("exhaust");
		await createAdminAccount({ email, displayName: "Exhausted Admin" }, null);
		await issueAdminSignInCode(email);

		// Spend the cap.
		const ip = "203.0.113.62";
		for (let i = 0; i < SIGNUP_CODE_MAX_ATTEMPTS; i++) {
			await call("/api/admin/auth/signin/verify", { email, code: "ZZZZZZ" }, ip);
		}
		const exhausted = await call("/api/admin/auth/signin/verify", { email, code: "ZZZZZZ" }, ip);
		const stranger = await call(
			"/api/admin/auth/signin/verify",
			{ email: addr("nobody"), code: "ZZZZZZ" },
			ip,
		);

		expect(exhausted.status).toBe(400);
		expect(exhausted.status).toBe(stranger.status);
		expect(await exhausted.text()).toBe(await stranger.text());
		const [row] = await db
			.select({ attempts: adminSignInCodes.attempts })
			.from(adminSignInCodes)
			.where(eq(adminSignInCodes.email, email));
		expect(row?.attempts).toBe(SIGNUP_CODE_MAX_ATTEMPTS);
	});
});
