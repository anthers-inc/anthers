// SPDX-License-Identifier: Apache-2.0
/**
 * Admin accounts and signing in to the admin app.
 *
 * The properties pinned here are the ones with no visible symptom when they break: that nothing
 * which opens an Anthers account opens the admin app (the site's session cookie, a bearer token,
 * a main-site sign-in code), that the routes answer only on the admin host and only to the admin
 * origin, that the cookie is the one that does not travel to other hosts, and that the last
 * super-admin cannot be removed. Each would fail open silently, and the admin app is where every
 * legal queue on the platform will live.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "@anthers/db/client";
import {
	adminAccountEvents,
	adminAccounts,
	adminSessions,
	adminSignInCodes,
	signupCodes,
} from "@anthers/db/schema";
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import app from "../index.js";
import {
	ADMIN_SESSION_TTL_MS,
	AdminAccountError,
	changeAdminEmail,
	createAdminAccount,
	createAdminSession,
	deactivateAdminAccount,
	deleteExpiredAdminSessions,
	deleteExpiredAdminSignInCodes,
	hashAdminSessionToken,
	issueAdminSignInCode,
	reactivateAdminAccount,
	setSuperAdmin,
	validateAdminSession,
} from "../services/admin-accounts.js";
import { issueSignInCode } from "../services/signup-codes.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

const RUN = `adm${Date.now()}${Math.floor(Math.random() * 1000)}`;
const addr = (tag: string) => `${RUN}-${tag}@example.com`;

const ADMIN_HOST = "http://admin.anthers.test";
const SITE_HOST = "http://anthers.test";

let savedAdminUrl: string | undefined;

beforeAll(() => {
	savedAdminUrl = process.env.ADMIN_URL;
	process.env.ADMIN_URL = ADMIN_HOST;
});

afterAll(async () => {
	if (savedAdminUrl === undefined) delete process.env.ADMIN_URL;
	else process.env.ADMIN_URL = savedAdminUrl;

	const mine = await db
		.select({ id: adminAccounts.id })
		.from(adminAccounts)
		.where(like(adminAccounts.email, `${RUN}-%`));
	const ids = mine.map((row) => row.id);
	if (ids.length > 0) {
		await db.delete(adminAccountEvents).where(inArray(adminAccountEvents.accountId, ids));
		await db.delete(adminSessions).where(inArray(adminSessions.accountId, ids));
		await db.delete(adminAccounts).where(inArray(adminAccounts.id, ids));
	}
	await db.delete(adminSignInCodes).where(like(adminSignInCodes.email, `${RUN}-%`));
	await db.delete(signupCodes).where(like(signupCodes.email, `${RUN}-%`));
});

function call(
	host: string,
	path: string,
	init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
	return app.request(`${host}${path}`, {
		method: init.method ?? "GET",
		headers: {
			...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
			...(init.method && init.method !== "GET" ? { Origin: ADMIN_HOST } : {}),
			...init.headers,
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
}

/** Sign an account in through the routes, returning the `Cookie` header value for it. */
async function signIn(email: string): Promise<string> {
	const { code } = await issueAdminSignInCode(email);
	if (!code) throw new Error(`no code was issued for ${email}`);
	const res = await call(ADMIN_HOST, "/api/admin/auth/signin/verify", {
		method: "POST",
		body: { email, code },
	});
	expect(res.status).toBe(200);
	const cookie = res.headers.get("set-cookie") ?? "";
	return cookie.split(";")[0];
}

describe("the admin host", () => {
	test("the sign-in routes answer 404 on any other host", async () => {
		const start = await call(SITE_HOST, "/api/admin/auth/signin/start", {
			method: "POST",
			body: { email: addr("nobody") },
		});
		expect(start.status).toBe(404);
		expect((await call(SITE_HOST, "/api/admin/auth/me")).status).toBe(404);
	});

	test("a public deployment with no ADMIN_URL has no admin host at all", async () => {
		const { isAdminHost } = await import("../lib/admin-host.js");
		expect(isAdminHost("admin.anthers.org", { FRONTEND_URL: "https://anthers.org" })).toBe(false);
		expect(isAdminHost("anthers.org", { FRONTEND_URL: "https://anthers.org" })).toBe(false);
		expect(
			isAdminHost("admin.anthers.org", {
				FRONTEND_URL: "https://anthers.org",
				ADMIN_URL: "https://admin.anthers.org",
			}),
		).toBe(true);
	});

	test("a mutation from the site's origin, or with no origin, is refused", async () => {
		const fromSite = await call(ADMIN_HOST, "/api/admin/auth/signin/start", {
			method: "POST",
			body: { email: addr("nobody") },
			headers: { Origin: "http://localhost:3000" },
		});
		expect(fromSite.status).toBe(403);

		const noOrigin = await app.request(`${ADMIN_HOST}/api/admin/auth/signin/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: addr("nobody") }),
		});
		expect(noOrigin.status).toBe(403);
	});
});

describe("asking for a code", () => {
	let active: string;
	let deactivated: string;

	beforeAll(async () => {
		active = addr("asker");
		deactivated = addr("gone");
		await createAdminAccount({ email: active, displayName: "Asker" }, null);
		const gone = await createAdminAccount({ email: deactivated, displayName: "Gone" }, null);
		await deactivateAdminAccount(gone.id, null);
	});

	test("answers identically for an admin account, a deactivated one and a stranger", async () => {
		const bodies = [];
		for (const email of [active, deactivated, addr("stranger")]) {
			const res = await call(ADMIN_HOST, "/api/admin/auth/signin/start", {
				method: "POST",
				body: { email },
			});
			expect(res.status).toBe(200);
			bodies.push(await res.text());
		}
		expect(new Set(bodies).size).toBe(1);
	});

	test("leaves a live code only for the active account", async () => {
		const rows = await db
			.select({ email: adminSignInCodes.email })
			.from(adminSignInCodes)
			.where(like(adminSignInCodes.email, `${RUN}-%`));
		expect(rows.map((r) => r.email)).toEqual([active]);
	});
});

describe("signing in", () => {
	let email: string;
	let accountId: number;

	beforeAll(async () => {
		email = addr("signer");
		accountId = (await createAdminAccount({ email, displayName: "Signer" }, null)).id;
	});

	test("sets a host-only, strict, secure cookie that matches the session's lifetime", async () => {
		const { code } = await issueAdminSignInCode(email);
		const res = await call(ADMIN_HOST, "/api/admin/auth/signin/verify", {
			method: "POST",
			body: { email, code },
		});
		expect(res.status).toBe(200);
		const cookie = res.headers.get("set-cookie") ?? "";
		expect(cookie).toStartWith("__Host-admin_session=");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).toContain("Path=/");
		expect(cookie).toContain(`Max-Age=${ADMIN_SESSION_TTL_MS / 1000}`);
		expect(cookie.toLowerCase()).not.toContain("domain=");
	});

	test("stores a digest of the session token, never the token", async () => {
		const cookie = await signIn(email);
		const token = cookie.split("=")[1];
		const rows = await db
			.select({ tokenHash: adminSessions.tokenHash })
			.from(adminSessions)
			.where(eq(adminSessions.accountId, accountId));
		expect(rows.map((r) => r.tokenHash)).toContain(hashAdminSessionToken(token));
		expect(rows.map((r) => r.tokenHash)).not.toContain(token);
	});

	test("the session opens /me, and signing out ends it", async () => {
		const cookie = await signIn(email);
		const me = await call(ADMIN_HOST, "/api/admin/auth/me", { headers: { Cookie: cookie } });
		expect(me.status).toBe(200);
		expect(((await me.json()) as { account: { email: string } }).account.email).toBe(email);

		const out = await call(ADMIN_HOST, "/api/admin/auth/sign-out", {
			method: "POST",
			headers: { Cookie: cookie },
		});
		expect(out.status).toBe(200);
		const after = await call(ADMIN_HOST, "/api/admin/auth/me", { headers: { Cookie: cookie } });
		expect(after.status).toBe(401);
	});

	test("a bearer credential is refused even alongside a valid admin cookie", async () => {
		const cookie = await signIn(email);
		const res = await call(ADMIN_HOST, "/api/admin/auth/me", {
			headers: { Cookie: cookie, Authorization: "Bearer not_a_real_token" },
		});
		expect(res.status).toBe(404);
	});

	test("a wrong code is refused and signs nobody in", async () => {
		await issueAdminSignInCode(email, new Date(Date.now() + 120_000));
		const res = await call(ADMIN_HOST, "/api/admin/auth/signin/verify", {
			method: "POST",
			body: { email, code: "ZZZZZZ" },
		});
		expect(res.status).toBe(400);
		expect(res.headers.get("set-cookie")).toBeNull();
	});
});

describe("nothing that opens an Anthers account opens the admin app", () => {
	let email: string;
	let siteCookie: string;

	beforeAll(async () => {
		email = addr("both");
		await createAdminAccount({ email, displayName: "Both" }, null);
		siteCookie = (await createAccount(`both${Date.now().toString(36)}`, { email })).cookie;
	});

	test("the site's session cookie does not reach /me", async () => {
		const res = await call(ADMIN_HOST, "/api/admin/auth/me", { headers: { Cookie: siteCookie } });
		expect(res.status).toBe(401);
	});

	test("an admin code does not sign the same mailbox into Anthers", async () => {
		const { code } = await issueAdminSignInCode(email);
		const res = await app.request("/api/auth/signin/verify", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
			body: JSON.stringify({ email, code }),
		});
		expect(res.status).toBe(400);
	});

	test("an Anthers code does not sign the same mailbox into the admin app", async () => {
		const { code } = await issueSignInCode(email, new Date(Date.now() + 180_000));
		expect(code).not.toBeNull();
		const res = await call(ADMIN_HOST, "/api/admin/auth/signin/verify", {
			method: "POST",
			body: { email, code },
		});
		expect(res.status).toBe(400);
	});
});

describe("managing accounts", () => {
	test("the last active super-admin cannot be demoted or deactivated", async () => {
		const others = await db
			.select({ id: adminAccounts.id })
			.from(adminAccounts)
			.where(and(eq(adminAccounts.isSuperAdmin, true), isNull(adminAccounts.deactivatedAt)));
		// The rule is about the whole table, so a super-admin this suite did not make would change
		// the answer. A test session's database starts empty, which is what this asserts.
		expect(others).toHaveLength(0);

		const first = await createAdminAccount(
			{ email: addr("super1"), displayName: "First", isSuperAdmin: true },
			null,
		);
		const second = await createAdminAccount(
			{ email: addr("super2"), displayName: "Second", isSuperAdmin: true },
			null,
		);

		await setSuperAdmin(first.id, false, second.id);
		await expect(setSuperAdmin(second.id, false, second.id)).rejects.toThrow(AdminAccountError);
		await expect(deactivateAdminAccount(second.id, null)).rejects.toThrow("last_super_admin");

		const events = await db
			.select({ kind: adminAccountEvents.kind, actorId: adminAccountEvents.actorId })
			.from(adminAccountEvents)
			.where(eq(adminAccountEvents.accountId, first.id));
		expect(events).toContainEqual({ kind: "super_admin_revoked", actorId: second.id });
	});

	test("deactivating an account ends its sessions and refuses its code", async () => {
		const email = addr("deact");
		const account = await createAdminAccount({ email, displayName: "Deact" }, null);
		const token = await createAdminSession(account.id);
		const { code } = await issueAdminSignInCode(email);

		await deactivateAdminAccount(account.id, null);
		expect(await validateAdminSession(token)).toBeNull();
		const res = await call(ADMIN_HOST, "/api/admin/auth/signin/verify", {
			method: "POST",
			body: { email, code },
		});
		expect(res.status).toBe(400);

		// Reactivating does not bring the old session back.
		await reactivateAdminAccount(account.id, null);
		expect(await validateAdminSession(token)).toBeNull();
	});

	test("changing the address ends every session and records both addresses", async () => {
		const from = addr("moving");
		const to = addr("moved");
		const account = await createAdminAccount({ email: from, displayName: "Mover" }, null);
		const token = await createAdminSession(account.id);

		await changeAdminEmail(account.id, to.toUpperCase(), null);
		expect(await validateAdminSession(token)).toBeNull();

		const [event] = await db
			.select({ detail: adminAccountEvents.detail })
			.from(adminAccountEvents)
			.where(
				and(
					eq(adminAccountEvents.accountId, account.id),
					eq(adminAccountEvents.kind, "email_changed"),
				),
			);
		expect(event.detail).toEqual({ from, to });
	});

	test("an address already in use is refused", async () => {
		const email = addr("taken");
		await createAdminAccount({ email, displayName: "Taken" }, null);
		await expect(createAdminAccount({ email, displayName: "Again" }, null)).rejects.toThrow(
			"email_taken",
		);
	});
});

describe("pruning", () => {
	test("removes expired admin sessions and codes, and a live session survives", async () => {
		const email = addr("prune");
		const account = await createAdminAccount({ email, displayName: "Prune" }, null);
		const past = new Date(Date.now() - 2 * ADMIN_SESSION_TTL_MS);
		const expired = await createAdminSession(account.id, null, null, past);
		const live = await createAdminSession(account.id);
		await issueAdminSignInCode(email, new Date(Date.now() - 60 * 60 * 1000));

		expect(await deleteExpiredAdminSessions()).toBeGreaterThanOrEqual(1);
		expect(await deleteExpiredAdminSignInCodes()).toBeGreaterThanOrEqual(1);

		const sessions = await db
			.select({ tokenHash: adminSessions.tokenHash })
			.from(adminSessions)
			.where(eq(adminSessions.accountId, account.id));
		expect(sessions.map((s) => s.tokenHash)).toEqual([hashAdminSessionToken(live)]);
		expect(sessions.map((s) => s.tokenHash)).not.toContain(hashAdminSessionToken(expired));
	});
});
