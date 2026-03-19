import { describe, it, expect, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@anthers/db/client";
import { users, verificationTokens } from "@anthers/db/schema";
import app from "../index";

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

	// ── Sign Up ──────────────────────────────────────────────────────────────

	describe("sign-up", () => {
		it("creates user with valid input", async () => {
			const res = await jsonPost("/api/auth/sign-up", { username, email, password });
			expect(res.status).toBe(201);
			const data = await res.json();
			expect(data.user.username).toBe(username);
			expect(data.user.email).toBe(email);
			expect(data.user.emailVerified).toBe(false);

			sessionCookie = res.headers.get("Set-Cookie")!.split(";")[0];
		});

		it("rejects duplicate username", async () => {
			const res = await jsonPost("/api/auth/sign-up", {
				username,
				email: `other_${testId}@example.com`,
				password,
			});
			expect(res.status).toBe(409);
			const data = await res.json();
			expect(data.error).toContain("Username");
		});

		it("rejects duplicate email", async () => {
			const res = await jsonPost("/api/auth/sign-up", {
				username: `other_${testId}`,
				email,
				password,
			});
			expect(res.status).toBe(409);
			const data = await res.json();
			expect(data.error).toContain("Email");
		});

		it("validates username format", async () => {
			const res = await jsonPost("/api/auth/sign-up", {
				username: "bad user name!",
				email: "valid@email.com",
				password,
			});
			expect(res.status).toBe(400);
		});

		it("validates password length", async () => {
			const res = await jsonPost("/api/auth/sign-up", {
				username: "validname",
				email: "valid@email.com",
				password: "short",
			});
			expect(res.status).toBe(400);
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

			// Get the verification token from the database (created during sign-up)
			const tokens = await db
				.select()
				.from(verificationTokens)
				.where(eq(verificationTokens.userId, userRow.id));

			const tokenRow = tokens.find((t) => t.type === "email_verify");
			expect(tokenRow).toBeTruthy();

			const res = await jsonPost("/api/auth/verify-email", { token: tokenRow!.token });
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
		const newPassword = "newSecurePass456";

		it("request-password-reset always returns success (prevents enumeration)", async () => {
			// Real email
			const res1 = await jsonPost("/api/auth/request-password-reset", { email });
			expect(res1.status).toBe(200);

			// Fake email
			const res2 = await jsonPost("/api/auth/request-password-reset", {
				email: "fake@fake.com",
			});
			expect(res2.status).toBe(200);
		});

		it("resets password with valid token", async () => {
			// Get the reset token from DB
			const [tokenRow] = await db
				.select()
				.from(verificationTokens)
				.where(eq(verificationTokens.type, "password_reset"))
				.limit(1);

			expect(tokenRow).toBeTruthy();

			const res = await jsonPost("/api/auth/reset-password", {
				token: tokenRow.token,
				password: newPassword,
			});
			expect(res.status).toBe(200);

			// Old session should be invalidated
			const meRes = await makeRequest("/api/auth/me", {
				headers: { Cookie: sessionCookie },
			});
			const meData = await meRes.json();
			expect(meData.user).toBeNull();
		});

		it("can sign in with new password", async () => {
			const res = await jsonPost("/api/auth/sign-in", {
				login: username,
				password: newPassword,
			});
			expect(res.status).toBe(200);
			sessionCookie = res.headers.get("Set-Cookie")!.split(";")[0];
		});

		it("rejects invalid reset token", async () => {
			const res = await jsonPost("/api/auth/reset-password", {
				token: "invalidtoken",
				password: "newpass123",
			});
			expect(res.status).toBe(400);
		});
	});

	// ── Change Password ──────────────────────────────────────────────────────

	describe("change password", () => {
		it("requires authentication", async () => {
			const res = await jsonPost("/api/auth/change-password", {
				currentPassword: "newSecurePass456",
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
					currentPassword: "newSecurePass456",
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
