// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { createEmailVerificationToken } from "../services/auth";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;

function makeRequest(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

function jsonPost(path: string, body: object, headers: Record<string, string> = {}) {
	return makeRequest(path, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: "http://localhost:3000",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

const testId = crypto.randomUUID().slice(0, 8);

describe("Auth System", () => {
	let sessionCookie: string;
	const atproto_handle = `authtest_${testId}`;
	const email = `authtest_${testId}@example.com`;

	// ── Accounts are made by the ceremony, never by a password form ─────────────

	describe("sign-up", () => {
		it("has no password sign-up route", async () => {
			// Signing up is the emailed-code ceremony (`/signup/*`). A route that made an account
			// and a session from a password skipped the code, so it is gone rather than hidden.
			const res = await jsonPost("/api/auth/sign-up", {
				username: `nosignup_${testId}`,
				email: `nosignup_${testId}@example.com`,
				password: "securepass123",
				acceptTerms: true,
			});
			expect(res.status).toBe(404);
			const rows = await db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.atprotoHandle, `nosignup_${testId}`));
			expect(rows).toEqual([]);
		});

		it("gives the fixture account a session", async () => {
			sessionCookie = (await createAccount(username, { email })).cookie;
			const me = await makeRequest("/api/auth/me", { headers: { Cookie: sessionCookie } });
			expect((await me.json()).user.emailVerified).toBe(false);
		});
	});

	// ── Sign In ──────────────────────────────────────────────────────────────

	describe("sign-in", () => {
		it("has no password sign-in route — the emailed code is the only way in", async () => {
			for (const body of [
				{ login: username, password: "securepass123" },
				{ login: email, password: "securepass123" },
				{ login: "nonexistent", password: "whatever" },
			]) {
				const res = await jsonPost("/api/auth/sign-in", body);
				expect(res.status).toBe(404);
			}
		});
	});

	// ── Session ──────────────────────────────────────────────────────────────

	describe("session", () => {
		it("/me returns user when authenticated", async () => {
			const res = await makeRequest("/api/auth/me", {
				headers: { Cookie: sessionCookie },
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.user).toBeTruthy();
			expect(data.user.username).toBe(username);
			expect(data.user.createdAt).toBeTruthy();
		});

		it("/me returns null when unauthenticated", async () => {
			const res = await makeRequest("/api/auth/me");
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.user).toBeNull();
		});

		it("/me returns null with invalid cookie", async () => {
			const res = await makeRequest("/api/auth/me", {
				headers: { Cookie: "session=invalidtoken123" },
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.user).toBeNull();
		});
	});

	// ── Email Verification ───────────────────────────────────────────────────

	describe("email verification", () => {
		it("verifies email with valid token", async () => {
			// Get this user's ID first
			const [userRow] = await db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.atprotoHandle, username))
				.limit(1);

			// The token a verification email would carry, minted the way the resend route mints it.
			const token = await createEmailVerificationToken(userRow.id);

			const res = await jsonPost("/api/auth/verify-email", { token });
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.success).toBe(true);

			// Verify user is now marked as verified
			const meRes = await makeRequest("/api/auth/me", {
				headers: { Cookie: sessionCookie },
			});
			const meData = await meRes.json();
			expect(meData.user.emailVerified).toBe(true);
		});

		it("rejects invalid verification token", async () => {
			const res = await jsonPost("/api/auth/verify-email", { token: "invalidtoken" });
			expect(res.status).toBe(400);
		});

		it("resend-verification requires auth", async () => {
			const res = await jsonPost("/api/auth/resend-verification", {});
			expect(res.status).toBe(401);
		});

		it("resend-verification rejects already verified", async () => {
			const res = await makeRequest("/api/auth/resend-verification", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: "http://localhost:3000",
					Cookie: sessionCookie,
				},
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
			const data = await res.json();
			expect(data.error).toContain("already verified");
		});
	});

	// ── Passwords are gone, not resettable ─────────────────────────────────────

	describe("passwords", () => {
		it("has no password routes at all — sign-in is the emailed code", async () => {
			expect((await jsonPost("/api/auth/request-password-reset", { email })).status).toBe(404);
			expect(
				(await jsonPost("/api/auth/reset-password", { token: "anything", password: "newpass123" }))
					.status,
			).toBe(404);
			// Authenticated, and still 404: the route is gone, not gated.
			const changeRes = await makeRequest("/api/auth/change-password", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: "http://localhost:3000",
					Cookie: sessionCookie,
				},
				body: JSON.stringify({ currentPassword: "whatever", newPassword: "anotherpass789" }),
			});
			expect(changeRes.status).toBe(404);
			const [row] = await db.select().from(users).where(eq(users.username, username)).limit(1);
			expect("passwordHash" in row).toBe(false);
		});
	});

	// ── Sign Out ─────────────────────────────────────────────────────────────

	describe("sign-out", () => {
		it("clears session and cookie", async () => {
			const res = await makeRequest("/api/auth/sign-out", {
				method: "POST",
				headers: { Cookie: sessionCookie, Origin: "http://localhost:3000" },
			});
			expect(res.status).toBe(200);

			// Session should be invalid now
			const meRes = await makeRequest("/api/auth/me", {
				headers: { Cookie: sessionCookie },
			});
			const data = await meRes.json();
			expect(data.user).toBeNull();
		});

		it("sign-out without session is a no-op (200)", async () => {
			const res = await makeRequest("/api/auth/sign-out", {
				method: "POST",
				headers: { Origin: "http://localhost:3000" },
			});
			expect(res.status).toBe(200);
		});
	});
});
