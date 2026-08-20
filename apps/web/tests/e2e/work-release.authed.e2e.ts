// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A creator releasing a Work, walked in a browser.
 *
 * This is the path everything else in the Catalog rests on, and until 2026-08-13 it did
 * not exist: a Work is born `private` with an access table that admits nobody
 * (`defaultSeedAccess()`), and the Studio had no control for either. So a creator could
 * upload a complete catalogue and publish exactly none of it, with nothing anywhere
 * saying so.
 *
 * 🚨 **The state this guards hardest is `locked`** — released, but with no access row
 * allowing anyone in. It is reachable in one click, it is what the server's own default
 * produces, and it is invisible from the creator's side because a creator can always open
 * their own work. That is the "plausible value rather than an error" shape: the Work looks
 * published, its page loads for the person checking, and no reader can get in.
 *
 * Runs in the `authed` project. A signed-out version of these assertions would pass
 * whether or not any of it works — see the note at the top of `studio-routes.authed.e2e.ts`
 * for why that vacuity is worth avoiding rather than tolerating.
 *
 * Uses a `service` Work throughout: it needs no media, so nothing here waits on ffmpeg or
 * on pg-boss, and the release-readiness gate (which applies only to processed types) stays
 * out of the way of the thing being tested.
 */
import { GAUNTLET_CREATOR_PASSWORD, GAUNTLET_CREATOR_USERNAME } from "@anthers/db/gauntlet";
import type { BrowserContext } from "@playwright/test";
import { API_URL, expect, test, WEB_ORIGIN } from "./fixtures";

/** Unique per run, so a leftover row from a crashed run can never satisfy an assertion. */
const TITLE = `Release walk ${Date.now()}`;

/** The fields of a Work this walk reads back off the public Catalog. */
interface PublicWork {
	title: string;
	publicAccess?: boolean;
	authoredAt?: string | null;
	authoredPrecision?: string | null;
}

test.describe.configure({ mode: "serial" });

/**
 * Sign in and plant the session cookie, the way `gauntlet.setup.ts` and
 * `studio-routes.authed.e2e.ts` both do it. Not `page.request.post` — that throws an
 * opaque `"/api/auth/sign-in" cannot be parsed as a URL` even given an absolute one.
 */
async function signInAsCreator(context: BrowserContext): Promise<string> {
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
	return token as string;
}

/** The card for our Work, found by its unique title rather than by position in the grid. */
const cardFor = (page: import("@playwright/test").Page) =>
	page.locator(".card").filter({ hasText: TITLE });

test("a creator creates, releases and re-gates a Work from the Studio", async ({
	page,
	context,
}) => {
	const session = await signInAsCreator(context);

	// ── Create ──────────────────────────────────────────────────────────────
	await page.goto("/studio/catalog");
	await expect(page.getByRole("heading", { name: "Catalog", exact: true })).toBeVisible();

	await page
		.getByRole("button", { name: /upload content/i })
		.first()
		.click();
	const modal = page.locator(".modal-box");
	await expect(modal).toBeVisible();

	await modal.locator("select").first().selectOption("service");
	await modal.locator('input[type="text"]').first().fill(TITLE);

	// The Created date, at year precision. Its whole reason for existing is back-dating a
	// catalogue, which is what a creator arriving with years of work actually does.
	await modal.getByRole("combobox").last().selectOption("year");
	await modal.locator('input[type="number"][min="1900"]').fill("2015");

	await page.getByRole("button", { name: /create content/i }).click();
	// ⚠️ A longer wait than the 5s default, and only here and at Save below, because both
	// are a modal closing on the far side of a write. On a machine that has just run the
	// unit suites against the same Postgres that round trip genuinely exceeds five seconds
	// sometimes — this is the other face of the race documented at the Catalog read. It
	// does not weaken the assertion: Playwright waits only as long as it needs to, and a
	// modal that never closes still fails.
	await expect(modal).toBeHidden({ timeout: 15_000 });

	// Born private. Not a detail — it is why a Release control has to exist at all.
	await expect(cardFor(page)).toContainText("Private");

	// ── Release ─────────────────────────────────────────────────────────────
	await cardFor(page).getByRole("button", { name: "Release" }).click();

	// The editor proposes an allowed baseline at $0, so releasing lands in the commons.
	await expect(cardFor(page)).toContainText("Public Access");

	// And the reader-facing endpoint agrees, which is the assertion that matters: the badge
	// is derived in the browser while `publicAccess` is derived on the server, from
	// `resolveAccessSync`. Two derivations of one idea — this is where they have to meet.
	//
	// 🚨 **POLLED, not read once, because those two derivations are also two CLOCKS.** The
	// card above can show its new state before this endpoint reflects it, and a single-shot
	// fetch then reports a Work that is a few milliseconds behind as one that was never
	// released at all. That made this the flakiest spec in the suite — it failed three
	// pre-push runs on 2026-08-20, on a loaded machine, under two different messages
	// ("missing from the public Catalog" here, and the modal timeout below), and both read
	// like a product bug rather than a race. Polling changes nothing about what is asserted:
	// if the server never agrees this still fails, with the same message.
	const catalogWork = () =>
		fetch(`${API_URL}/api/content/catalog/${GAUNTLET_CREATOR_USERNAME}`)
			.then((r) => r.json() as Promise<{ works: PublicWork[] }>)
			.then((cat) => cat.works.find((w) => w.title === TITLE));

	await expect
		.poll(async () => (await catalogWork())?.publicAccess ?? null, {
			message: "the released Work never became Public Access in the public Catalog",
		})
		.toBe(true);
	const published = await catalogWork();

	/**
	 * The Created date survived the form.
	 *
	 * ⚠️ Added after a sabotage run: stubbing `authoredAt` to `null` in the editor left this
	 * spec green, because filling a field in is not the same as asserting it was sent. The
	 * unit tests cover the UTC conversion; nothing covered the wiring, which is the half
	 * that actually breaks when someone reshuffles the request body.
	 */
	expect(published?.authoredAt).toBe("2015-01-01T00:00:00.000Z");
	expect(published?.authoredPrecision).toBe("year");

	// ── The locked state ────────────────────────────────────────────────────
	await cardFor(page).getByRole("button", { name: "Edit" }).click();
	await expect(modal).toBeVisible();

	// Warning first, while the change is still only in the form — a creator should be told
	// before they save, not discover it from a reader.
	await modal.locator("table").getByRole("checkbox").first().uncheck();
	await expect(modal.getByText(/nobody can open this/i)).toBeVisible();

	await page.getByRole("button", { name: /save & close/i }).click();
	await expect(modal).toBeHidden({ timeout: 15_000 });
	await expect(cardFor(page)).toContainText("Nobody can open");

	// Still released, and now genuinely shut: the server drops it from what a reader sees.
	// Polled for the same reason as the read after Release — and note this direction was
	// already tolerant of the race by accident, since `find(...)?.publicAccess` on a Work
	// the fetch has not caught up with is `undefined`, which is falsy and passes. A read
	// that cannot fail from being early also cannot prove the change landed.
	await expect
		.poll(async () => Boolean((await catalogWork())?.publicAccess), {
			message: "the locked Work is still Public Access to a reader",
		})
		.toBe(false);

	// ── Clean up ────────────────────────────────────────────────────────────
	// Through the API rather than the UI: the delete dialog is another surface's business,
	// and a failed assertion above must not leave a row behind that outlives this run.
	const mine = await fetch(`${API_URL}/api/content/works`, {
		headers: { Cookie: `session=${session}` },
	}).then((r) => r.json() as Promise<{ works: { id: number; title: string }[] }>);
	for (const w of mine.works.filter((w) => w.title === TITLE)) {
		await fetch(`${API_URL}/api/content/works/${w.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
});
