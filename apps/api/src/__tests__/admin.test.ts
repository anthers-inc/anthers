// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin / ops console API — gating + response shape.
 *
 * The security-critical behavior is the gate: unauthenticated → 401, a signed-in
 * NON-admin → 404 (the surface is not advertised — requireAdmin masks existence,
 * it doesn't 403), an admin → 200 with data. Also asserts the activity + jobs
 * payloads have the shape the console renders.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { sql } from "drizzle-orm";
import app from "../index";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

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

const id = crypto.randomUUID().slice(0, 8);
const adminName = `admin_${id}`;
const plainName = `plain_${id}`;

describe("Admin / ops console API", () => {
	let adminCookie: string;
	let plainCookie: string;

	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username IN (${adminName}, ${plainName})`);
		adminCookie = await signUp(adminName);
		plainCookie = await signUp(plainName);
		// Promote one — admin is an out-of-band flag, never self-serve.
		await db.execute(sql`UPDATE users SET is_admin = true WHERE username = ${adminName}`);
	}, DB_SETUP_TIMEOUT);

	// ── Gating ────────────────────────────────────────────────────────────────
	it("rejects unauthenticated requests with 401", async () => {
		const res = await req("/api/admin/activity");
		expect(res.status).toBe(401);
	});

	it("hides the surface from a signed-in non-admin (404, not 403)", async () => {
		const res = await req("/api/admin/activity", { headers: { Cookie: plainCookie } });
		expect(res.status).toBe(404);
	});

	it("also gates /jobs behind admin", async () => {
		expect((await req("/api/admin/jobs")).status).toBe(401);
		expect((await req("/api/admin/jobs", { headers: { Cookie: plainCookie } })).status).toBe(404);
	});

	// ── Activity ────────────────────────────────────────────────────────────────
	it("returns activity data to an admin", async () => {
		const res = await req("/api/admin/activity", { headers: { Cookie: adminCookie } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			users: { total: number; creators: number; admins: number; new24h: number; new7d: number };
			posts: { total: number; published: number };
			comments: { new24h: number };
			uploads: { total: number };
			series: { date: string; signups: number; posts: number }[];
		};
		// The two accounts we just created exist; at least one admin is counted.
		expect(body.users.total).toBeGreaterThanOrEqual(2);
		expect(body.users.admins).toBeGreaterThanOrEqual(1);
		expect(typeof body.posts.total).toBe("number");
		expect(typeof body.uploads.total).toBe("number");
		// 14-day series is fully materialized (no gaps) with numeric cells.
		expect(body.series).toHaveLength(14);
		expect(typeof body.series[0].date).toBe("string");
		expect(typeof body.series[0].signups).toBe("number");
	});

	// ── Jobs ────────────────────────────────────────────────────────────────────
	it("returns queue health to an admin (all known queues enumerated)", async () => {
		const res = await req("/api/admin/jobs", { headers: { Cookie: adminCookie } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			pgboss: {
				available: boolean;
				queues: { name: string; failed: number; active: number }[];
				failures: unknown[];
			};
			transcodes: { counts: Record<string, number>; problems: unknown[] };
		};
		// Known queues are seeded from the QUEUES constant, so they appear even
		// when idle (completed jobs get pruned). transcode-video is one of them.
		const names = body.pgboss.queues.map((q) => q.name);
		expect(names).toContain("transcode-video");
		expect(Array.isArray(body.pgboss.failures)).toBe(true);
		expect(Array.isArray(body.transcodes.problems)).toBe(true);
	});
});
