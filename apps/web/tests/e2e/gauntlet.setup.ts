// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Setup project for the User Gauntlet walk: reset the fixture through its canonical
 * script (the same one `make gauntlet-reset` runs — never a reimplementation), sign the
 * harness's viewer in through the real sign-in route, and persist the resulting session
 * as the storageState the gauntlet project runs under.
 *
 * The storage state carries two things the walk needs before any app script runs:
 * the `session` cookie (from the API's Set-Cookie) and the SiteGate localStorage flag
 * for the preview origin — the same flag `fixtures.ts` seeds for anonymous specs.
 *
 * GOTCHA (Playwright under Bun): any `request`/`page.request` call whose response
 * carries a Set-Cookie header crashes in Playwright's cookie parser (it receives the
 * path where Node hands it the full URL — `new URL("/api/auth/sign-in")` throws). So
 * the sign-in here uses plain `fetch` and builds the storageState JSON by hand. The
 * walk itself is unaffected: none of the endpoints it calls set cookies.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GAUNTLET_VIEWER_PASSWORD, GAUNTLET_VIEWER_USERNAME } from "@anthers/db/gauntlet";
import { expect, test as setup } from "@playwright/test";
import { API_URL, AUTH_STATE_PATH, WEB_ORIGIN } from "./fixtures";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

setup("reset the gauntlet fixture and sign the viewer in", async () => {
	// Canonical fixture reset. --ensure-viewer creates gauntlet_viewer on first run and
	// targets it thereafter, so the walk never touches the dev account.
	execFileSync("bun", ["run", "db:gauntlet", "--ensure-viewer"], {
		cwd: REPO_ROOT,
		stdio: "inherit",
	});

	// Sign in exactly as the SPA would: same route, same Origin, real Set-Cookie.
	const res = await fetch(`${API_URL}/api/auth/sign-in`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN }, // CSRF checks Origin
		body: JSON.stringify({
			login: GAUNTLET_VIEWER_USERNAME,
			password: GAUNTLET_VIEWER_PASSWORD,
		}),
	});
	expect(res.ok, `sign-in failed: ${res.status} ${await res.text().catch(() => "")}`).toBe(true);

	const setCookie = res.headers.get("set-cookie") ?? "";
	const token = /(?:^|\s)session=([^;]+)/.exec(setCookie)?.[1];
	expect(token, `no session cookie in Set-Cookie: "${setCookie}"`).toBeTruthy();

	// The storage state, by hand (see the gotcha above): the session cookie for the API
	// host plus the SiteGate flag for the preview origin.
	const state = {
		cookies: [
			{
				name: "session",
				value: token as string,
				domain: "localhost",
				path: "/",
				expires: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
				httpOnly: true,
				secure: false,
				sameSite: "Lax" as const,
			},
		],
		origins: [
			{
				origin: WEB_ORIGIN,
				localStorage: [{ name: "anthers_site_access", value: "true" }],
			},
		],
	};
	mkdirSync(dirname(AUTH_STATE_PATH), { recursive: true });
	writeFileSync(AUTH_STATE_PATH, JSON.stringify(state, null, "\t"));
});
