// SPDX-License-Identifier: Apache-2.0
/**
 * Setup project for the User Gauntlet walk's OWN fixture instance: reset instance B
 * through its canonical script (`db:gauntlet --instance walk` — the same seeder instance
 * A's setup runs, pointed at the walk's own rows, never a reimplementation), sign the
 * walk's viewer in through the real sign-in route, and persist the resulting session as
 * the storageState the gauntlet project runs under.
 *
 * Instance B is the walk's private copy of the fixture (`walk-creator` / `walk-viewer`
 * accounts, `walk-gauntlet-` slugs — see `@anthers/db/gauntlet-walk`), so this setup and
 * the walk share a fixture with nobody: the `authed` project runs on instance A, whose
 * rows this never touches, which is why the two projects need no ordering between them.
 *
 * The storage state carries the one thing the walk needs before any app script runs:
 * the `session` cookie from the API's Set-Cookie.
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
import { WALK_VIEWER_EMAIL } from "@anthers/db/gauntlet-walk";
import { expect, test as setup } from "@playwright/test";
import { API_URL, emailedCode, WALK_AUTH_STATE_PATH, WEB_ORIGIN } from "./fixtures";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

setup("reset the walk's gauntlet fixture and sign its viewer in", async () => {
	// Canonical fixture reset, for instance B. --ensure-viewer creates walk-viewer on
	// first run and targets it thereafter, so the walk never touches the dev account
	// or instance A's gauntlet_viewer.
	execFileSync("bun", ["run", "db:gauntlet", "--instance", "walk", "--ensure-viewer"], {
		cwd: REPO_ROOT,
		stdio: "inherit",
	});
	// The GAUNTLET's media is deliberately NOT seeded here. The walk's own `beforeAll`
	// resets the fixture again — which deletes the content items, and with them any media
	// attached now — and then re-attaches it. Generating it here meant running ffmpeg twice
	// per CI run and throwing the first result away. What this step must leave behind is the
	// viewer, so the sign-in below has an account to authenticate.

	// 🚨 The MEDIA FIXTURE (`db:media-fixture`) is deliberately NOT seeded here either —
	// that is instance A's setup's job. It seeds creators (`media_fixture`, the gauntlet
	// creator's Works) that the `authed` specs depend on, and seeding it here a second
	// time would buy nothing: the walk's media is its own gauntlet media, attached by
	// `db:gauntlet:media --instance walk` in the walk's `beforeAll`.

	// Sign in by the emailed code, because that is the only way in: ask the signin pair
	// for one, read it out of the session's mail catcher, spend it for the Set-Cookie.
	await fetch(`${API_URL}/api/auth/signin/start`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN }, // CSRF checks Origin
		body: JSON.stringify({ email: WALK_VIEWER_EMAIL }),
	});
	const code = await emailedCode(WALK_VIEWER_EMAIL);
	const res = await fetch(`${API_URL}/api/auth/signin/verify`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN },
		body: JSON.stringify({ email: WALK_VIEWER_EMAIL, code }),
	});
	expect(res.ok, `sign-in failed: ${res.status} ${await res.text().catch(() => "")}`).toBe(true);

	const setCookie = res.headers.get("set-cookie") ?? "";
	const token = /(?:^|\s)session=([^;]+)/.exec(setCookie)?.[1];
	expect(token, `no session cookie in Set-Cookie: "${setCookie}"`).toBeTruthy();

	// The storage state, by hand (see the gotcha above): the session cookie for the API
	// host, which is the whole of the viewer's state now that the pre-launch gate is gone.
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
	};
	mkdirSync(dirname(WALK_AUTH_STATE_PATH), { recursive: true });
	writeFileSync(WALK_AUTH_STATE_PATH, JSON.stringify(state, null, "\t"));
});
