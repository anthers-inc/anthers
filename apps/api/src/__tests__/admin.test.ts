// SPDX-License-Identifier: Apache-2.0
/**
 * Admin / ops console API — gating + response shape.
 *
 * The security-critical behavior is the gate: no admin session → 401, including a
 * request carrying a signed-in Anthers account's `session` cookie, because an Anthers
 * account opens nothing here; a bearer credential → 404, because the desktop Studio's
 * transport must not even learn the surface exists; an admin session → 200 with data.
 * Also asserts the activity + jobs payloads have the shape the console renders.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { sql } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const testFetch = app.fetch;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const id = crypto.randomUUID().slice(0, 8);
const plainName = `plain_${id}`;

describe("Admin / ops console API", () => {
	let adminCookie: string;
	let plainCookie: string;
	let plainToken: string;

	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE email = ${plainName + '@example.com'}`);
		const plain = await createAccount(plainName);
		plainCookie = plain.cookie;
		plainToken = plain.token;
		// An operator is an admin account, which is a separate identity from any Anthers
		// account and is never self-serve.
		adminCookie = (await createAdminFixture("console")).cookie;
	}, DB_SETUP_TIMEOUT);

	// ── Gating ────────────────────────────────────────────────────────────────
	it("rejects unauthenticated requests with 401", async () => {
		const res = await req("/api/admin/activity");
		expect(res.status).toBe(401);
	});

	it("refuses a signed-in Anthers account, whose session cookie is not an admin session", async () => {
		const res = await req("/api/admin/activity", { headers: { Cookie: plainCookie } });
		expect(res.status).toBe(401);
	});

	it("does not advertise the surface to a bearer credential (404, not 401)", async () => {
		const res = await req("/api/admin/activity", {
			headers: { Authorization: `Bearer ${plainToken}` },
		});
		expect(res.status).toBe(404);
	});

	it("also gates /jobs behind an admin session", async () => {
		expect((await req("/api/admin/jobs")).status).toBe(401);
		expect((await req("/api/admin/jobs", { headers: { Cookie: plainCookie } })).status).toBe(401);
	});

	// ── Activity ────────────────────────────────────────────────────────────────
	it("returns activity data to an admin", async () => {
		const res = await req("/api/admin/activity", { headers: { Cookie: adminCookie } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			admins: number;
			users: { total: number; creators: number; new24h: number; new7d: number };
			posts: { total: number; published: number };
			comments: { new24h: number };
			uploads: { total: number };
			series: { date: string; signups: number; posts: number }[];
		};
		// The account we just created exists, and the admin account signed in is counted —
		// beside `users` rather than inside it, because it is not an Anthers account.
		expect(body.users.total).toBeGreaterThanOrEqual(1);
		expect(body.admins).toBeGreaterThanOrEqual(1);
		expect(body.users).not.toHaveProperty("admins");
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
