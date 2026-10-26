// SPDX-License-Identifier: Apache-2.0
/**
 * Setup project for the User Gauntlet walk: reset the fixture through its canonical
 * script (the same one `make gauntlet-reset` runs — never a reimplementation), sign the
 * harness's user in through the real sign-in route, and persist the resulting session
 * as the storageState the gauntlet project runs under.
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

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "@anthers/db/client";
import { GAUNTLET_CREATOR_EMAIL, GAUNTLET_WALKER_EMAIL } from "@anthers/db/gauntlet";
import { stripeAccounts, users } from "@anthers/db/schema";
import { expect, test as setup } from "@playwright/test";
import { eq } from "drizzle-orm";
import { API_URL, AUTH_STATE_PATH, emailedCode, leashedExecFileSync, WEB_ORIGIN } from "./fixtures";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

setup("reset the gauntlet fixture and sign the user in", async () => {
	// Canonical fixture reset. --ensure-walker creates gauntlet_walker on first run and
	// targets it thereafter, so the walk never touches the dev account.
	leashedExecFileSync("bun", ["run", "db:gauntlet", "--ensure-walker"], {
		cwd: REPO_ROOT,
		stdio: "inherit",
	});

	// 🚨 **The fixture creator is given completed payout setup here, once.**
	//
	// A creator is creator mode plus completed setup (`services/creator-standing`), and the
	// seed leaves the creator at mode only when `GAUNTLET_STRIPE_ACCOUNT` is unset, which is
	// every CI run and every fresh clone. Creator search and Discovery's creator listing read
	// standing, so without this row those specs pass only when some other spec's `beforeAll`
	// connected Stripe first — a race under `fullyParallel`, and the reason
	// `search-bar.authed.e2e.ts` and `feed-grid.authed.e2e.ts` failed in rotating sets
	// locally while CI's retries absorbed them.
	//
	// The shared fixture's state has one owner, and it is this project — the same reasoning
	// the media fixture above carries. The walk owns instance B and keeps its connect-less
	// posture, because this writes instance A's creator only.
	const [fixtureCreator] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, GAUNTLET_CREATOR_EMAIL))
		.limit(1);
	expect(fixtureCreator, "the gauntlet fixture creator exists").toBeTruthy();
	await db
		.insert(stripeAccounts)
		.values({
			userId: fixtureCreator!.id,
			// A local run with a real test-mode account keeps using it; everywhere else a
			// test-shaped id, which is what every authed spec that needs standing writes.
			stripeAccountId:
				process.env.GAUNTLET_STRIPE_ACCOUNT?.trim() ||
				`acct_test_${fixtureCreator!.id}_${crypto.randomUUID().slice(0, 8)}`,
			onboardingComplete: true,
			payoutsEnabled: true,
			chargesEnabled: true,
		})
		.onConflictDoUpdate({
			target: stripeAccounts.userId,
			set: { onboardingComplete: true, payoutsEnabled: true, chargesEnabled: true },
		});
	// The GAUNTLET's media is deliberately NOT seeded here. The walk's own `beforeAll`
	// resets the fixture again — which deletes the content items, and with them any media
	// attached now — and then re-attaches it. Generating it here meant running ffmpeg twice
	// per CI run and throwing the first result away. What this step must leave behind is the
	// user, so the sign-in below has an account to authenticate.

	// The MEDIA FIXTURE is the opposite case and does belong here: nothing in the run resets
	// it, so it is seeded once into the session's fresh database and every spec shares it.
	//
	// 🚨 It is seeded ONCE, here, rather than in each spec's `beforeAll` — which is where it
	// started, and which broke a spec in a different file. Three specs in the `authed`
	// project each spawning `bun run db:media-fixture` meant three concurrent Bun processes
	// opening database connections against the same dev Postgres, and the contention showed
	// up as an unrelated Studio modal timing out on save. A fixture that several specs share
	// wants one owner, and the setup project is it.
	leashedExecFileSync("bun", ["run", "db:media-fixture"], { cwd: REPO_ROOT, stdio: "inherit" });

	// Sign in by the emailed code, because that is the only way in: ask the signin pair
	// for one, read it out of the session's mail catcher, spend it for the Set-Cookie.
	await fetch(`${API_URL}/api/auth/signin/start`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN }, // CSRF checks Origin
		body: JSON.stringify({ email: GAUNTLET_WALKER_EMAIL }),
	});
	const code = await emailedCode(GAUNTLET_WALKER_EMAIL);
	const res = await fetch(`${API_URL}/api/auth/signin/verify`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN },
		body: JSON.stringify({ email: GAUNTLET_WALKER_EMAIL, code }),
	});
	expect(res.ok, `sign-in failed: ${res.status} ${await res.text().catch(() => "")}`).toBe(true);

	const setCookie = res.headers.get("set-cookie") ?? "";
	const token = /(?:^|\s)session=([^;]+)/.exec(setCookie)?.[1];
	expect(token, `no session cookie in Set-Cookie: "${setCookie}"`).toBeTruthy();

	// The storage state, by hand (see the gotcha above): the session cookie for the API
	// host, which is the whole of the user's state now that the pre-launch gate is gone.
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
	mkdirSync(dirname(AUTH_STATE_PATH), { recursive: true });
	writeFileSync(AUTH_STATE_PATH, JSON.stringify(state, null, "\t"));
});
