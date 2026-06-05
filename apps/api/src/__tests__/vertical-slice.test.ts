// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { sql } from "drizzle-orm";
import app from "../index";

// Use the app directly via .fetch() for testing (no network needed)
const testFetch = app.fetch;

function makeRequest(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

// Use unique identifiers per test run to avoid conflicts
const testId = crypto.randomUUID().slice(0, 8);
const testUsername = `test_${testId}`;
const testEmail = `test_${testId}@example.com`;

describe("Vertical Slice", () => {
	let sessionCookie: string;

	beforeAll(async () => {
		// Clean up any leftover test data from previous runs
		await db.run(sql`DELETE FROM projects WHERE slug = 'test-game-${sql.raw(testId)}'`);
	});

	it("health check returns ok", async () => {
		const res = await makeRequest("/health");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.status).toBe("ok");
	});

	it("sign-up creates a user and returns session cookie", async () => {
		const res = await makeRequest("/api/auth/sign-up", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "http://localhost:3000",
			},
			body: JSON.stringify({
				username: testUsername,
				email: testEmail,
				password: "testpass123",
			}),
		});
		expect(res.status).toBe(201);
		const data = await res.json();
		expect(data.user.username).toBe(testUsername);
		expect(data.user.email).toBe(testEmail);

		// Extract session cookie
		const setCookieHeader = res.headers.get("Set-Cookie");
		expect(setCookieHeader).toBeTruthy();
		sessionCookie = setCookieHeader!.split(";")[0];
	});

	it("get /me returns authenticated user with full profile", async () => {
		const res = await makeRequest("/api/auth/me", {
			headers: { Cookie: sessionCookie },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.user).toBeTruthy();
		expect(data.user!.username).toBe(testUsername);
		// Phase 2: /me now returns full profile
		expect(data.user!.email).toBe(testEmail);
		expect(data.user!.emailVerified).toBe(false);
		expect(data.user!.isCreator).toBe(false);
	});

	it("create project requires auth", async () => {
		const res = await makeRequest("/api/content/projects", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "http://localhost:3000",
			},
			body: JSON.stringify({
				title: "Unauthed Project",
				slug: "unauthed",
			}),
		});
		expect(res.status).toBe(401);
	});

	it("create project succeeds when authenticated", async () => {
		const slug = `test-game-${testId}`;
		const res = await makeRequest("/api/content/projects", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "http://localhost:3000",
				Cookie: sessionCookie,
			},
			body: JSON.stringify({
				title: "Test Game",
				slug,
				description: "A test project from the vertical slice",
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		const data = await res.json();
		expect(data.project.title).toBe("Test Game");
		expect(data.project.slug).toBe(slug);
		expect(data.project.creatorId).toBeGreaterThan(0);
	});

	it("list projects returns the created project", async () => {
		const res = await makeRequest("/api/content/projects");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.projects.length).toBeGreaterThan(0);
		expect(data.projects.some((p: any) => p.slug === `test-game-${testId}`)).toBe(true);
	});

	it("Zod validates project creation input", async () => {
		const res = await makeRequest("/api/content/projects", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "http://localhost:3000",
				Cookie: sessionCookie,
			},
			body: JSON.stringify({
				title: "", // empty, should fail min(1)
				slug: "INVALID SLUG", // should fail regex
			}),
		});
		expect(res.status).toBe(400);
	});

	it("sign-out clears session", async () => {
		const res = await makeRequest("/api/auth/sign-out", {
			method: "POST",
			headers: {
				Cookie: sessionCookie,
				Origin: "http://localhost:3000",
			},
		});
		expect(res.status).toBe(200);

		// Verify session is invalidated
		const meRes = await makeRequest("/api/auth/me", {
			headers: { Cookie: sessionCookie },
		});
		const data = await meRes.json();
		expect(data.user).toBeNull();
	});
});
