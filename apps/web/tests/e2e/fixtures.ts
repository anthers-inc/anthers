// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "node:url";
import { GAUNTLET_CREATOR_EMAIL } from "@anthers/db/gauntlet";
import { MEDIA_FIXTURE_EMAIL } from "@anthers/db/media-fixture";
import { type BrowserContext, test as base, expect, type Page } from "@playwright/test";

/**
 * The static preview the browser loads (playwright.config.ts webServer #1), on the port the
 * browser session picked. Every run takes free ports, so two runs and a `make dev` coexist.
 */
export const WEB_ORIGIN = `http://localhost:${process.env.PREVIEW_PORT ?? 4173}`;
/** The admin app's preview, a separate origin from the site, as admin.anthers.org is in production. */
export const ADMIN_ORIGIN = `http://localhost:${process.env.ADMIN_PREVIEW_PORT ?? 4174}`;
/**
 * The real API (webServer #2). The preview server tells the page which port this is, so pages
 * reach it directly with no proxy — see `rpc.ts`.
 */
export const API_URL = `http://localhost:${process.env.API_PORT ?? 8000}`;
/**
 * Where the setup project writes the signed-in viewer's storage state (session cookie +
 * SiteGate flag). The gauntlet project loads it via its `use.storageState`.
 */
export const AUTH_STATE_PATH = fileURLToPath(
	new URL("./.auth/gauntlet-viewer.json", import.meta.url),
);

// The whole app is wrapped in SiteGate (the pre-launch "Team access" wall),
// which is authorized purely by the `anthers_site_access` localStorage flag.
// Seed it before any app script runs so every test lands on the real app
// instead of the gate — the standard way to walk an e2e harness past a
// client-side access wall. If SiteGate's storage key changes, update it here
// AND in the storageState the setup project writes.
export const test = base.extend({
	page: async ({ page }, use) => {
		await page.addInitScript(() => {
			try {
				localStorage.setItem("anthers_site_access", "true");
			} catch {}
		});
		await use(page);
	},
});

/**
 * Strict console/page-error tracking for the authenticated specs.
 *
 * Deliberately unlike the calculators' tracker, which filters `/api/` and `auth/me`
 * failures out as *expected* — correct for a static preview with no backend, but exactly
 * the failures an authenticated walk exists to catch. Here every page error and console
 * error counts unless it matches an explicitly passed, documented allowance.
 */
export function trackErrorsStrict(page: Page, allow: RegExp[] = []): string[] {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
	page.on("console", (m) => {
		if (m.type() !== "error") return;
		const text = m.text();
		if (allow.some((re) => re.test(text))) return;
		errors.push(`console: ${text}`);
	});
	return errors;
}

/**
 * Sign an account in and put the session on `context`.
 *
 * By the emailed code, because that is the only way anybody signs in: the fixture's address
 * is posted to `/auth/signin/start`, the code is read back out of the session's mail catcher
 * (where a person would read it), and `/auth/signin/verify` answers with the same
 * Set-Cookie a real sign-in returns. Plain `fetch` plus an explicit cookie, exactly as
 * `gauntlet.setup.ts` does it, and deliberately not `page.request.post`: that threw an
 * opaque `"/api/auth/sign-in" cannot be parsed as a URL` even when handed an absolute one,
 * and the setup file's approach is the one already proven against this API.
 *
 * Returns the raw token so a test can call the API as that account — cleanup, mostly — without
 * driving the browser.
 */
async function signInAs(context: BrowserContext, email: string): Promise<string> {
	const start = await fetch(`${API_URL}/api/auth/signin/start`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN }, // CSRF checks Origin
		body: JSON.stringify({ email }),
	});
	expect(start.ok, `asking for a sign-in code for ${email} failed: ${start.status}`).toBe(true);

	const code = await emailedCode(email);
	const res = await fetch(`${API_URL}/api/auth/signin/verify`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN },
		body: JSON.stringify({ email, code }),
	});
	expect(res.ok, `sign-in as ${email} failed: ${res.status}`).toBe(true);

	const token = /(?:^|\s)session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
	expect(token, "no session cookie returned").toBeTruthy();
	await context.addCookies([
		{
			name: "session",
			value: token as string,
			domain: "localhost",
			path: "/",
			expires: Math.floor(Date.now() / 1000) + 3600,
			httpOnly: true,
			secure: false,
			sameSite: "Lax" as const,
		},
	]);
	return token as string;
}

/**
 * Sign in as the gauntlet CREATOR.
 *
 * The `authed` project's stored state belongs to the gauntlet *viewer*, who is not a creator —
 * so anything behind the Studio's creator gate needs this instead.
 */
export function signInAsCreator(context: BrowserContext): Promise<string> {
	return signInAs(context, GAUNTLET_CREATOR_EMAIL);
}

/**
 * Sign in as `media_fixture`, a creator whose Works no other project resets.
 *
 * 🚨 **A spec that creates Works and walks them across several pages belongs here rather than on
 * the gauntlet creator.** The `gauntlet` project's reset deletes every Work the gauntlet creator
 * owns, matched on the creator, so a Work a walk made there can vanish partway through it and
 * the failure lands wherever the walk happened to be. `media_fixture` is a creator with verified
 * email (seeded by `seed-media-fixture.ts` in `setup`) that nothing else resets, which also makes
 * cleaning up after itself each spec's own job.
 */
export function signInAsMediaFixture(context: BrowserContext): Promise<string> {
	return signInAs(context, MEDIA_FIXTURE_EMAIL);
}

export { expect };

/** The browser session's mail catcher, where every email the API sends lands. */
export const MAIL_CATCHER_URL = process.env.MAIL_CATCHER_URL ?? "";

/**
 * The code in the newest email sent to `address`, read from the session's mail catcher.
 *
 * ⭐ **This is what lets a spec finish a ceremony rather than stop at the code field.** The code is
 * hashed at rest, and an endpoint that handed it back would be a door nobody should have, so the
 * only honest way to read one is where a person reads it — the inbox. Waits, because the API posts
 * the email after answering the request that asked for it.
 */
export async function emailedCode(address: string, timeoutMs = 15_000): Promise<string> {
	if (!MAIL_CATCHER_URL) {
		throw new Error("no MAIL_CATCHER_URL — run the browser suite in a session (make test-e2e)");
	}
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const res = await fetch(
			`${MAIL_CATCHER_URL}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
		);
		const body = (await res.json()) as { messages?: { Subject: string; Date?: string }[] };
		// The NEWEST one, not the first: identical subject lines from repeated sign-ins and
		// re-sends share the query, and under load the fresh email can take a moment to land
		// while the search is already answering. Reading an earlier message spends a code
		// that has since been replaced, and the verify refuses it — flaky by construction.
		const newest = body.messages
			?.slice()
			.sort((a, b) => new Date(b.Date ?? 0).getTime() - new Date(a.Date ?? 0).getTime());
		const code = newest
			?.map((message) => message.Subject.match(/^([A-Z0-9]{6}) is your Anthers/)?.[1])
			.find(Boolean);
		if (code) return code;
		if (Date.now() > deadline) throw new Error(`no code arrived for ${address}`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}
