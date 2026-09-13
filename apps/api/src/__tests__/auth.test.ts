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
	const username = `authtest_${testId}`;
	const email = `authtest_${testId}@example.com`;
	const password = "securepass123";

	// ── Accounts are made by the ceremony, never by a password form ─────────────

	describe("sign-up", () => {
		it("has no password sign-up route", async () => {
			// Signing up is the emailed-code ceremony (`/signup/*`). A route that made an account
			// and a session from a password skipped the code, so it is gone rather than hidden.
			const res = await jsonPost("/api/auth/sign-up", {
				username: `nosignup_${testId}`,
				email: `nosignup_${testId}@example.com`,
				password,
				acceptTerms: true,
			});
			expect(res.status).toBe(404);
			const rows = await db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.username, `nosignup_${testId}`));
			expect(rows).toEqual([]);
		});

		it("gives the fixture account a session", async () => {
			sessionCookie = (await createAccount(username, { email, password })).cookie;
			const me = await makeRequest("/api/auth/me", { headers: { Cookie: sessionCookie } });
			expect((await me.json()).user.emailVerified).toBe(false);
		});
	});

	// ── Sign In ──────────────────────────────────────────────────────────────

	describe("sign-in", () => {
		it("signs in with username", async () => {
			const res = await jsonPost("/api/auth/sign-in", { login: username, password });
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.user.username).toBe(username);
			expect(res.headers.get("Set-Cookie")).toBeTruthy();
		});

		it("signs in with email", async () => {
			const res = await jsonPost("/api/auth/sign-in", { login: email, password });
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.user.email).toBe(email);
		});

		it("rejects wrong password", async () => {
			const res = await jsonPost("/api/auth/sign-in", { login: username, password: "wrongpass" });
			expect(res.status).toBe(401);
			const data = await res.json();
			expect(data.error).toContain("Invalid");
		});

		it("rejects nonexistent user", async () => {
			const res = await jsonPost("/api/auth/sign-in", {
				login: "nonexistent",
				password: "whatever",
			});
			expect(res.status).toBe(401);
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
				.where(eq(users.username, username))
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

	// ── Password Reset ───────────────────────────────────────────────────────

	describe("password reset", () => {
		it("has no reset routes, because a forgotten password is recovered by signing in with a code", async () => {
			expect((await jsonPost("/api/auth/request-password-reset", { email })).status).toBe(404);
			expect(
				(await jsonPost("/api/auth/reset-password", { token: "anything", password: "newpass123" }))
					.status,
			).toBe(404);
		});
	});

	// ── Change Password ──────────────────────────────────────────────────────

	describe("change password", () => {
		it("requires authentication", async () => {
			const res = await jsonPost("/api/auth/change-password", {
				currentPassword: password,
				newPassword: "anotherpass789",
			});
			expect(res.status).toBe(401);
		});

		it("rejects wrong current password", async () => {
			const res = await makeRequest("/api/auth/change-password", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: "http://localhost:3000",
					Cookie: sessionCookie,
				},
				body: JSON.stringify({
					currentPassword: "wrongpassword",
					newPassword: "anotherpass789",
				}),
			});
			expect(res.status).toBe(401);
		});

		it("changes password with correct current password", async () => {
			const res = await makeRequest("/api/auth/change-password", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: "http://localhost:3000",
					Cookie: sessionCookie,
				},
				body: JSON.stringify({
					currentPassword: password,
					newPassword: "finalpass000",
				}),
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.success).toBe(true);
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
