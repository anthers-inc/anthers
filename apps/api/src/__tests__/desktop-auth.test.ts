// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Desktop auth — the bearer transport and the browser-handoff enrollment that mints it.
 *
 * These are the three things a packaged Tauri window breaks (`apps/api/src/middleware/bearer.ts`):
 * the session cookie is never sent from `tauri://localhost`, every mutation 403s on
 * the CSRF Origin check, and there was previously no way to hold a session except as
 * a cookie. So the suite drives requests the way the desktop app really will — bearer
 * header, NO cookie, NO Origin — and asserts the browser's CSRF posture is untouched.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { sql } from "drizzle-orm";
import app from "../index";
import { pkceChallenge } from "../services/auth";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

/** A request shaped like the desktop app's: bearer credential, no cookie, no Origin. */
function desktopReq(path: string, token: string, options: RequestInit = {}) {
	return req(path, {
		...options,
		headers: {
			...(options.headers as Record<string, string> | undefined),
			Authorization: `Bearer ${token}`,
		},
	});
}

function hex() {
	return (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
}

const id = crypto.randomUUID().slice(0, 8);
const userName = `desk_${id}`;

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

/** Run the whole browser-handoff enrollment, returning the minted desktop token. */
async function enroll(cookie: string, label: string) {
	const verifier = hex();
	const challenge = await pkceChallenge(verifier);

	// NO Origin header — the packaged app cannot send an allowed one, so sending one
	// here would test a request shape that never occurs in production.
	const start = await req("/api/auth/desktop/start", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ challenge, label }),
	});
	expect(start.status).toBe(201);

	const authorize = await req("/api/auth/desktop/authorize", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ challenge }),
	});
	expect(authorize.status).toBe(200);
	const { code } = await authorize.json();

	const exchange = await req("/api/auth/desktop/exchange", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code, verifier }),
	});
	expect(exchange.status).toBe(200);
	return { ...(await exchange.json()), verifier, challenge, code };
}

describe("Desktop auth", () => {
	let cookie: string;

	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username = ${userName}`);
		cookie = await signUp(userName);
	}, DB_SETUP_TIMEOUT);

	// ── Enrollment ────────────────────────────────────────────────────────────

	it("mints a desktop token through the browser handoff", async () => {
		const { token, user } = await enroll(cookie, "test-thinkpad");
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(user.username).toBe(userName);
	});

	it("shows the pending request's label to the authorize page, then 404s once used", async () => {
		const verifier = hex();
		const challenge = await pkceChallenge(verifier);
		await req("/api/auth/desktop/start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ challenge, label: "some-laptop" }),
		});

		const pending = await req(`/api/auth/desktop/pending/${challenge}`);
		expect(pending.status).toBe(200);
		expect((await pending.json()).label).toBe("some-laptop");

		const unknown = await req(`/api/auth/desktop/pending/${hex()}`);
		expect(unknown.status).toBe(404);
	});

	it("lets the app open and redeem an enrollment with NO Origin header at all", async () => {
		// Regression guard. Both endpoints are called BY the packaged app, which has no
		// allowed Origin (`tauri://localhost`) and no session yet — so if they are not
		// CSRF-exempt, enrollment 403s and the desktop app can never sign in. This was
		// missed once because the tests sent an Origin the real client cannot send.
		const verifier = hex();
		const challenge = await pkceChallenge(verifier);

		const start = await req("/api/auth/desktop/start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ challenge, label: "no-origin-device" }),
		});
		expect(start.status).toBe(201);

		const authorize = await req("/api/auth/desktop/authorize", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({ challenge }),
		});
		const { code } = await authorize.json();

		const exchange = await req("/api/auth/desktop/exchange", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code, verifier }),
		});
		expect(exchange.status).toBe(200);
	});

	it("still requires a real Origin on /desktop/authorize — the cookie-authed step", async () => {
		// The confirm click runs under the browser's cookie session, so it is exactly
		// the kind of request CSRF exists to protect. It must NOT be exempted alongside
		// the app-driven pair above.
		const challenge = await pkceChallenge(hex());
		await req("/api/auth/desktop/start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ challenge }),
		});

		const res = await req("/api/auth/desktop/authorize", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "https://evil.example.com",
				Cookie: cookie,
			},
			body: JSON.stringify({ challenge }),
		});
		expect(res.status).toBe(403);
	});

	it("refuses to authorize without a signed-in browser session", async () => {
		const challenge = await pkceChallenge(hex());
		await req("/api/auth/desktop/start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ challenge }),
		});

		const res = await req("/api/auth/desktop/authorize", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ challenge }),
		});
		expect(res.status).toBe(401);
	});

	// ── PKCE ─────────────────────────────────────────────────────────────────

	it("rejects a stolen code presented with the wrong verifier", async () => {
		const verifier = hex();
		const challenge = await pkceChallenge(verifier);
		await req("/api/auth/desktop/start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ challenge }),
		});
		const authorize = await req("/api/auth/desktop/authorize", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({ challenge }),
		});
		const { code } = await authorize.json();

		// A rogue app that hijacked the anthers:// scheme has the code but not the verifier.
		const stolen = await req("/api/auth/desktop/exchange", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code, verifier: hex() }),
		});
		expect(stolen.status).toBe(400);

		// And the code is burned by that attempt — the real app cannot redeem it either,
		// so a theft is a denial of service at worst, never an account takeover.
		const genuine = await req("/api/auth/desktop/exchange", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code, verifier }),
		});
		expect(genuine.status).toBe(400);
	});

	it("rejects a code replayed after a successful exchange", async () => {
		const { code, verifier } = await enroll(cookie, "replay-test");
		const replay = await req("/api/auth/desktop/exchange", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code, verifier }),
		});
		expect(replay.status).toBe(400);
	});

	// ── Bearer transport ─────────────────────────────────────────────────────

	it("authenticates a GET with no cookie and no Origin", async () => {
		const { token } = await enroll(cookie, "get-test");
		const res = await desktopReq("/api/auth/me", token);
		expect(res.status).toBe(200);
		expect((await res.json()).user.username).toBe(userName);
	});

	it("authenticates a MUTATION with no cookie and no Origin — the CSRF skip", async () => {
		const { token } = await enroll(cookie, "mutation-test");
		// Bio update via the accounts route: a plain authenticated PATCH, which under
		// cookie auth would need an allowed Origin.
		const res = await desktopReq("/api/accounts/me", token, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ bio: "written from the desktop app" }),
		});
		expect(res.status).toBe(200);
	});

	it("rejects a mutation carrying an expired/unknown bearer token — as 401, not 403", async () => {
		// The distinction matters: the desktop app sends no Origin, so a generic CSRF
		// 403 here would point an expired-token client at the wrong problem.
		const res = await desktopReq("/api/accounts/me", hex(), {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ bio: "nope" }),
		});
		expect(res.status).toBe(401);
	});

	it("still rejects a cookie-authenticated mutation from a bad Origin", async () => {
		// The browser's CSRF posture must be exactly as it was — the bearer path is
		// additive, not a loosening.
		const res = await req("/api/accounts/me", {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Origin: "https://evil.example.com",
				Cookie: cookie,
			},
			body: JSON.stringify({ bio: "csrf" }),
		});
		expect(res.status).toBe(403);
	});

	it("still rejects a cookie-authenticated mutation with no Origin at all", async () => {
		const res = await req("/api/accounts/me", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ bio: "csrf" }),
		});
		expect(res.status).toBe(403);
	});

	// ── Devices list + revocation ────────────────────────────────────────────

	it("lists desktop sessions beside browser ones, flagging the current one", async () => {
		const { token } = await enroll(cookie, "listed-device");

		const res = await desktopReq("/api/auth/sessions", token);
		expect(res.status).toBe(200);
		const { sessions } = await res.json();

		const mine = sessions.find((s: { current: boolean }) => s.current);
		expect(mine.kind).toBe("desktop");
		expect(mine.label).toBe("listed-device");
		// The browser session that authorized it is here too, and is not "current".
		expect(sessions.some((s: { kind: string }) => s.kind === "web")).toBe(true);
		// A revocation UI must never hand back the credentials it lists.
		expect(sessions.every((s: Record<string, unknown>) => !("token" in s))).toBe(true);
	});

	it("revokes a desktop session, killing that token and nothing else", async () => {
		const doomed = await enroll(cookie, "stolen-laptop");
		const keeper = await enroll(cookie, "home-desktop");

		const list = await desktopReq("/api/auth/sessions", keeper.token);
		const { sessions } = await list.json();
		const target = sessions.find((s: { label: string }) => s.label === "stolen-laptop");

		const revoke = await desktopReq(`/api/auth/sessions/${target.id}`, keeper.token, {
			method: "DELETE",
		});
		expect(revoke.status).toBe(200);

		// The revoked token is dead...
		const dead = await desktopReq("/api/auth/me", doomed.token);
		expect((await dead.json()).user).toBeNull();

		// ...and the browser session that enrolled it is untouched, which is the whole
		// point of minting a separate credential per device.
		const stillFine = await req("/api/auth/me", { headers: { Cookie: cookie } });
		expect((await stillFine.json()).user.username).toBe(userName);
		expect(keeper.token).toBeTruthy();
	});

	it("cannot revoke another user's session", async () => {
		const strangerName = `desk_other_${id}`;
		await db.execute(sql`DELETE FROM users WHERE username = ${strangerName}`);
		const strangerCookie = await signUp(strangerName);
		const stranger = await enroll(strangerCookie, "stranger-device");

		const mine = await enroll(cookie, "victim-device");
		const list = await desktopReq("/api/auth/sessions", mine.token);
		const target = (await list.json()).sessions.find(
			(s: { label: string }) => s.label === "victim-device",
		);

		const res = await desktopReq(`/api/auth/sessions/${target.id}`, stranger.token, {
			method: "DELETE",
		});
		expect(res.status).toBe(404);

		// Still alive.
		const alive = await desktopReq("/api/auth/me", mine.token);
		expect((await alive.json()).user.username).toBe(userName);
	});

	it("signs out the desktop session without touching the browser's", async () => {
		const { token } = await enroll(cookie, "signout-test");

		const out = await desktopReq("/api/auth/sign-out", token, { method: "POST" });
		expect(out.status).toBe(200);

		const dead = await desktopReq("/api/auth/me", token);
		expect((await dead.json()).user).toBeNull();

		const browser = await req("/api/auth/me", { headers: { Cookie: cookie } });
		expect((await browser.json()).user.username).toBe(userName);
	});
});
