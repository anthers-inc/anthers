// SPDX-License-Identifier: Apache-2.0

import {
	type ExecFileSyncOptions,
	type ExecFileSyncOptionsWithStringEncoding,
	execFileSync,
} from "node:child_process";
import { fileURLToPath } from "node:url";
import { GAUNTLET_CREATOR_EMAIL } from "@anthers/db/gauntlet";
import { MEDIA_FIXTURE_EMAIL } from "@anthers/db/media-fixture";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { withSignInLock } from "./signin-lock";

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
 * Where the setup project writes the signed-in user's storage state (the session
 * cookie). The gauntlet project loads it via its `use.storageState`.
 */
export const AUTH_STATE_PATH = fileURLToPath(
	new URL("./.auth/gauntlet-walker.json", import.meta.url),
);

/**
 * Where the walk setup project (`gauntlet-walk.setup.ts`) writes its own user's storage
 * state — the gauntlet walk project's session, over its OWN fixture instance
 * (`walk-walker`, instance B). Deliberately a different file from
 * `AUTH_STATE_PATH`: the two projects' sessions must not share state, which is the same
 * isolation the walk's separate fixture rows buy.
 */
export const WALK_AUTH_STATE_PATH = fileURLToPath(
	new URL("./.auth/gauntlet-walk-walker.json", import.meta.url),
);

/**
 * One `created` credit for a Work the spec is going to release. Release refuses a Work whose
 * credits name no human (`credits_creator_required`), so a spec that releases without one is
 * testing the gate rather than its own subject. Include this in the create POST body of any
 * Work the walk will release or schedule; leave it out only when the gate itself is on test.
 */
export const CREATED_CREDIT = [
	{ role: "Everything", contributor: "The Creator", types: ["created"] },
];

// The `page` fixture used to extend Playwright's to seed the pre-launch gate's
// localStorage flag before any app script ran; the gate is gone and the fixture is
// the plain Playwright one now, re-exported so specs keep importing it from here.
export { test };

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
 * One emailed-code sign-in per address at a time, across every worker the run is using.
 *
 * The API keeps **one live code per address** and a re-request replaces it — a security
 * property, not something a test may widen; the reasoning, the two abandoned-lock
 * reaps and the staleness-vs-deadline lesson live in `./signin-lock`, which holds the
 * mechanism and its unit test (also under `bun test`, in `src/signin-lock.test.ts`).
 */

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
	return withSignInLock(email, async () => {
		const startedAt = Date.now();
		const start = await fetch(`${API_URL}/api/auth/signin/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN }, // CSRF checks Origin
			body: JSON.stringify({ email }),
		});
		expect(start.ok, `asking for a sign-in code for ${email} failed: ${start.status}`).toBe(true);

		/*
		 * A throttled `start` sends nothing: the API keeps one live code per address and
		 * re-issues it no often than once a minute, answering 200 either way so the timing
		 * cannot be told apart. Between two sign-ins that lands the second caller reading
		 * the FIRST caller's still-warm email — which is a code that verify spends and
		 * burns, and the read arrives too late. When nothing new shows up quickly, the
		 * honest wait is the throttle window and another start, so the code being read is
		 * always one *this* sign-in minted.
		 */
		const code = await emailedCode(email, 3_000, startedAt).catch(async () => {
			await new Promise((resolve) => setTimeout(resolve, 61_000));
			const againStartedAt = Date.now();
			const again = await fetch(`${API_URL}/api/auth/signin/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN },
				body: JSON.stringify({ email }),
			});
			expect(again.ok, `re-asking for a sign-in code for ${email} failed: ${again.status}`).toBe(
				true,
			);
			return emailedCode(email, 15_000, againStartedAt);
		});
		const res = await fetch(`${API_URL}/api/auth/signin/verify`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN },
			body: JSON.stringify({ email, code }),
		});
		expect(
			res.ok,
			`sign-in as ${email} failed (${res.status}): ${await res
				.clone()
				.text()
				.catch(() => "")} — code tried: ${code}`,
		).toBe(true);

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
	});
}

/**
 * Sign in as the gauntlet CREATOR.
 *
 * The `authed` project's stored state belongs to the gauntlet *user*, who is not a creator —
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
 *
 * `sentAtOrAfter` narrows the read to mail that exists *because of this request*: any older
 * message in the inbox is another send's leftover or another sign-in's, and reading it picks
 * up a code that has already been spent.
 */
export async function emailedCode(
	address: string,
	timeoutMs = 15_000,
	sentAtOrAfter?: number,
): Promise<string> {
	if (!MAIL_CATCHER_URL) {
		throw new Error("no MAIL_CATCHER_URL — run the browser suite in a session (make test-e2e)");
	}
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const res = await fetch(
			`${MAIL_CATCHER_URL}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
		);
		const body = (await res.json()) as {
			messages?: { Subject: string; Date?: string; Created?: string | number; ID?: string }[];
		};
		// The FIRST one the search hands back, which is the newest: Mailpit's search answers
		// ordered by the millisecond the message arrived (`m.Created DESC`), so it is already
		// the order the API itself meant. Sorting it again by the email's own `Date` header —
		// seconds only — is what used to pick the wrong one when two sign-ins landed in the
		// same second and made this read an already-replaced code.
		const newest = body.messages;
		const arrivedAt = (m: { Created?: string | number }) =>
			m.Created == null
				? 0
				: typeof m.Created === "number"
					? m.Created
					: new Date(m.Created).getTime();
		const fresh = (newest ?? []).filter((m) =>
			sentAtOrAfter === undefined ? true : arrivedAt(m) >= sentAtOrAfter,
		);
		const code = fresh
			.map((message) => message.Subject.match(/^([A-Z0-9]{6}) is your Anthers/)?.[1])
			.find(Boolean);
		if (code) return code;
		if (Date.now() > deadline) throw new Error(`no code arrived for ${address}`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

/**
 * A leashed blocking spawn for the fixture's child processes.
 *
 * 🚨 Every fixture-side child spawn is synchronous (`execFileSync`), and a synchronous
 * spawn that hangs wedges the worker it runs in: a blocked event loop fires **no timer
 * the runner owns** — not the test timeout, not a hook's, not the reporter's — so the
 * whole run sits silently until the job's `timeout-minutes` ceiling kills it with
 * nothing examined. That is the exact 2026-10-14 stall, twice over the same day: both
 * Playwright CI jobs ran their fast openings (about eighty tests in under three
 * minutes) and then produced nothing for ten-plus minutes before eating their budget,
 * with the gauntlet walk's hop child (a `db:` script that never returned) the visible
 * last act on the media side. A child that hangs has to die at the leash — the
 * sync-spawn timeout fires natively inside the blocked wait (`spawnSync sleep
 * ETIMEDOUT`, proven locally) — and the test fails with the child's real error instead.
 *
 * 300s is the default leash: the heaviest legitimate child (the media fixture's ffmpeg
 * seeds) finishes well inside it even on CI's slow runners, and a hung child dies long
 * after its work could not possibly still be pending.
 */
export function leashedExecFileSync(
	cmd: string,
	args: readonly string[],
	opts: ExecFileSyncOptions,
): Buffer;
export function leashedExecFileSync(
	cmd: string,
	args: readonly string[],
	opts: ExecFileSyncOptionsWithStringEncoding,
): string;
export function leashedExecFileSync(
	cmd: string,
	args: readonly string[],
	opts: ExecFileSyncOptions = {},
	timeoutMs = 300_000,
): string | Buffer {
	return execFileSync(cmd, args, { timeout: timeoutMs, ...opts }) as string | Buffer;
}
