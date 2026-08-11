// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Studio is a SECTION of this app, not a separate origin.
 *
 * `apps/studio-web` served it from `studio.anthers.org` until 2026-08-11, for cross-origin
 * isolation that turned out to be dormant (`@ffmpeg/core-mt` hangs at pthread spawn
 * in-browser) and never to have required a second origin anyway — isolation is a
 * per-DOCUMENT property. It is `/studio` here now.
 *
 * 🚨 **These run in the `gauntlet` project because they need a real session.** Signed out,
 * every route on this app renders the same marketing page, so a `chromium`-project version
 * of these assertions passes whether or not the routes exist — which is a test that proves
 * nothing while looking green. That version was written, confirmed vacuous, and deleted.
 *
 * What they pin:
 *
 *   - **That `/studio` resolves to the Studio at all**, rather than to the `/:username`
 *     catch-all. The gauntlet viewer is NOT a creator, so the creator gate redirects them
 *     to `/settings`; that redirect is the observable proof the Studio route matched,
 *     because a `/:username` match would have rendered a profile instead.
 *
 *     ⚠️ These do NOT pin route ORDER, and an earlier version of this comment claimed they
 *     did. Moving the `/studio` block below the catch-all was tried and every test still
 *     passed: React Router v6 ranks matches by specificity, so a static segment beats a
 *     dynamic one wherever it is registered. Worth knowing before someone "fixes" an
 *     ordering bug that cannot exist — and worth remembering that the sabotage is what
 *     found this, not the green run.
 *   - **The legacy `/dashboard/*` tree** still lands somewhere sensible. It used to
 *     hard-navigate across origins; it is an in-app redirect now.
 */
import { GAUNTLET_CREATOR_PASSWORD, GAUNTLET_CREATOR_USERNAME } from "@anthers/db/gauntlet";
import { expect, test } from "@playwright/test";
import { API_URL, WEB_ORIGIN } from "./fixtures";

test("/studio resolves to the Studio and its creator gate, not the /:username catch-all", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));

	await page.goto("/studio");

	// Signed in but not a creator → the gate sends us to account settings, in-app.
	await expect(page).toHaveURL(/\/settings$/);
	expect(errors).toEqual([]);
});

test("legacy /dashboard paths redirect into /studio", async ({ page }) => {
	await page.goto("/dashboard/analytics");
	// StudioRedirect strips /dashboard → /studio/analytics, then the creator gate applies.
	// Landing on /settings proves both hops ran; a dead-end would have stayed put.
	await expect(page).toHaveURL(/\/settings$/);
});

test("a creator reaches the Studio itself", async ({ page, context }) => {
	// Plain `fetch` + an explicit cookie, exactly as gauntlet.setup.ts does it. Not
	// `page.request.post` — that threw an opaque `"/api/auth/sign-in" cannot be parsed as
	// a URL` even when handed an absolute URL, and the setup file's approach is the one
	// already proven against this API.
	const res = await fetch(`${API_URL}/api/auth/sign-in`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN }, // CSRF checks Origin
		body: JSON.stringify({
			login: GAUNTLET_CREATOR_USERNAME,
			password: GAUNTLET_CREATOR_PASSWORD,
		}),
	});
	expect(res.ok, `creator sign-in failed: ${res.status}`).toBe(true);

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

	await page.goto("/studio");
	// Past the gate: the Studio shell renders rather than bouncing to /login or /settings.
	await expect(page).toHaveURL(/\/studio$/);
	await expect(page.getByRole("navigation").getByText("Dashboard")).toBeVisible();
});
