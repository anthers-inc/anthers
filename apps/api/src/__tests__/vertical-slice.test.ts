import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import app from "../index";

// Use the app directly via .fetch() for testing (no network needed)
const testFetch = app.fetch;

function makeRequest(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

describe("Vertical Slice", () => {
	let sessionCookie: string;

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
				username: "slicetest",
				email: "slice@test.com",
				password: "testpass123",
			}),
		});
		expect(res.status).toBe(201);
		const data = await res.json();
		expect(data.user.username).toBe("slicetest");
		expect(data.user.email).toBe("slice@test.com");

		// Extract session cookie
		const setCookieHeader = res.headers.get("Set-Cookie");
		expect(setCookieHeader).toBeTruthy();
		sessionCookie = setCookieHeader!.split(";")[0];
	});

	it("get /me returns authenticated user", async () => {
		const res = await makeRequest("/api/auth/me", {
			headers: { Cookie: sessionCookie },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.user).toBeTruthy();
		expect(data.user!.username).toBe("slicetest");
	});

	it("create project requires auth", async () => {
		const res = await makeRequest("/api/projects", {
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
		const res = await makeRequest("/api/projects", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "http://localhost:3000",
				Cookie: sessionCookie,
			},
			body: JSON.stringify({
				title: "Test Game",
				slug: "test-game",
				description: "A test project from the vertical slice",
			}),
		});
		expect(res.status).toBe(201);
		const data = await res.json();
		expect(data.project.title).toBe("Test Game");
		expect(data.project.slug).toBe("test-game");
		expect(data.project.creatorId).toBe(1);
	});

	it("list projects returns the created project", async () => {
		const res = await makeRequest("/api/projects");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.projects.length).toBeGreaterThan(0);
		expect(data.projects.some((p: any) => p.slug === "test-game")).toBe(true);
	});

	it("Zod validates project creation input", async () => {
		const res = await makeRequest("/api/projects", {
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
