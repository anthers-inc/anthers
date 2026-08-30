// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A creator releasing a Work, walked in a browser.
 *
 * This is the path everything else in the Catalog rests on, and until 2026-08-13 it did
 * not exist: a Work is born `private` with an access table that admits nobody
 * (`defaultSeedAccess()`), and the Studio had no control for either. So a creator could
 * upload a complete catalog and publish exactly none of it, with nothing anywhere
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
import { MEDIA_FIXTURE_PASSWORD, MEDIA_FIXTURE_USERNAME } from "@anthers/db/media-fixture";
import type { BrowserContext } from "@playwright/test";
import { API_URL, expect, test, WEB_ORIGIN } from "./fixtures";

/**
 * Unique per run, so a leftover row from a crashed run can never satisfy an assertion.
 *
 * The prefix is what the stale-Work sweep below keys on — a failed run leaves a `Release
 * walk %` Work behind on the shared `media_fixture` account, and the next run would find
 * it by title and could pass assertions it did not earn. The sweep deletes every Work
 * whose title matches the prefix before this run creates its own.
 */
const TITLE = `Release walk ${Date.now()}`;
const TITLE_PREFIX = "Release walk ";

/** The fields of a Work this walk reads back off the public Catalog. */
interface PublicWork {
	title: string;
	publicAccess?: boolean;
	authoredAt?: string | null;
	authoredPrecision?: string | null;
}

/** The fields of a Work as the creator's own listing returns it (used for the sweep). */
interface OwnedWork {
	id: number;
	title: string;
}

test.describe.configure({ mode: "serial" });

/**
 * 🚨 **This walk borrows `media_fixture`, and not owning the creator is what it must not
 * do.** It used to create its own account, and that could not work.
 *
 * `StudioAuthGate.tsx` redirects a signed-in non-creator to `/settings`, and `PATCH
 * /api/accounts/me` refuses `isCreator: true` unless `emailVerified` (routes/accounts.ts),
 * which a spec cannot satisfy without receiving an email. So an account the spec signs up
 * is a user the Studio bounces to /settings — the Studio never renders, and every
 * assertion below fails at the first `goto("/studio/catalog")`. The handoff that tried it
 * landed on that redirect, which reads as a Studio bug and is a test-harness one.
 *
 * The earlier cause was the opposite mistake — borrowing `gauntlet_creator`. The
 * `gauntlet` project's `beforeAll` runs `deleteGauntletPosts`, which removes **every Work
 * owned by the gauntlet creator** (matched on the creator, not a slug prefix, because
 * "everything it owns is fixture data by definition"), and locally it runs **concurrently
 * with `authed`** (`workers` is unset outside CI). The reset deleted this walk's Work
 * mid-test, and the failure landed wherever the walk happened to be: a Catalog read that
 * found nothing (`Received: null`, not `false`), or a modal that never closed. Both read
 * as product bugs. ⚠️ **CI could never see it**: `workers: 1` in CI serializes the
 * projects, so the two never overlap there — green on every PR, red about one local
 * `make verify` in three.
 *
 * `media_fixture` is the resolution: `isCreator: true` and `emailVerified: true` (seeded
 * by `seed-media-fixture.ts`), owned by nobody else's reset, and idempotent (seeded once
 * in the `setup` project that `authed` depends on). The one assertion that names it —
 * `music-player.authed.e2e.ts:52`, `toHaveCount(MEDIA_FIXTURE_TRACKS.length)` — is scoped
 * to the album Project page, and a `service` Work titled "Release walk …" is not in that
 * Project. The shared-ownership rule still holds in the direction that matters: this spec
 * must clean up after itself, which the sweep at the top of the test does.
 */
const CREATOR = MEDIA_FIXTURE_USERNAME;

/**
 * Sign in as `media_fixture` and plant the session cookie, the way `gauntlet.setup.ts` and
 * `studio-routes.authed.e2e.ts` both do it. Not `page.request.post` — that throws an
 * opaque `"/api/auth/sign-in" cannot be parsed as a URL` even given an absolute one.
 *
 * The account is seeded by the `setup` project (via `bun run db:media-fixture`) before
 * this project runs, so the sign-in always has an account to reach.
 */
async function signInAsCreator(context: BrowserContext): Promise<string> {
	const res = await fetch(`${API_URL}/api/auth/sign-in`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN }, // CSRF checks Origin
		body: JSON.stringify({ login: CREATOR, password: MEDIA_FIXTURE_PASSWORD }),
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
const cardFor = (page: import("@playwright_test").Page) =>
	page.locator(".card").filter({ hasText: TITLE });

/**
 * Delete every Work owned by the signed-in creator whose title starts with the Release-walk
 * prefix. Used twice: once before the run (sweep a crashed prior run's litter) and once
 * after (sweep this run's own Work). A failed run between two `make verify` calls would
 * otherwise leave a `Release walk %` row on the shared `media_fixture` account, and the
 * next run's `find(w => w.title === TITLE)` is keyed on a *different* `Date.now()`, so it
 * would not collide — but a stale row muddies the Catalog view the walk reads, and a
 * shared fixture must clean up after itself.
 *
 * Through the API rather than the UI: the delete dialog is another surface's business, and
 * a failed assertion must not leave a row behind that outlives this run.
 */
async function sweepReleaseWalkWorks(session: string): Promise<void> {
	const mine = await fetch(`${API_URL}/api/content/works`, {
		headers: { Cookie: `session=${session}` },
	}).then((r) => r.json() as Promise<{ works: OwnedWork[] }>);
	for (const w of mine.works.filter((w) => w.title.startsWith(TITLE_PREFIX))) {
		await fetch(`${API_URL}/api/content/works/${w.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
}

test("a creator creates, releases and re-gates a Work from the Studio", async ({
	page,
	context,
}) => {
	const session = await signInAsCreator(context);

	// ── Sweep ───────────────────────────────────────────────────────────────
	// A previous run that crashed after Create leaves a `Release walk %` Work on the shared
	// `media_fixture` account. Clean it up before this run creates its own, so the Catalog
	// view the walk reads starts from a known state — and so a shared fixture does not
	// accumulate litter across failed local runs. See `sweepReleaseWalkWorks` above.
	await sweepReleaseWalkWorks(session);

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
	// catalog, which is what a creator arriving with years of work actually does.
	await modal.getByRole("combobox").last().selectOption("year");
	await modal.locator('input[type="number"][min="1900"]').fill("2015");

	await page.getByRole("button", { name: /create content/i }).click();
	// ⚠️ A longer wait than the 5s default, here and at Save below — both are a modal
	// closing on the far side of a write, and this suite shares its Postgres with the unit
	// suites. Headroom only: it is NOT the explanation for the flakiness this spec was
	// famous for, which was the fixture deletion described above. An earlier pass attributed
	// the modal timeouts to a loaded machine, which was plausible, unverified and wrong.
	// Playwright still waits only as long as it needs, and a modal that never closes fails.
	await expect(modal).toBeHidden({ timeout: 15_000 });

	// Born private. Not a detail — it is why a Release control has to exist at all.
	await expect(cardFor(page)).toContainText("Private");

	// ── Unrated, and therefore unreleasable ─────────────────────────────────
	// A Work is born `unrated` and the server refuses to release one (`maturity_undeclared`),
	// so the card refuses the click rather than earning the error. Asserted here rather than
	// only in the API suite because the whole point of the card control is releasing a back
	// catalog thirty at a time, and thirty identical 409s is the failure this prevents.
	await expect(cardFor(page)).toContainText("Needs a rating");
	await expect(cardFor(page).getByRole("button", { name: "Release" })).toBeDisabled();

	// ── Rate it ─────────────────────────────────────────────────────────────
	await cardFor(page).getByRole("button", { name: "Edit" }).click();
	await expect(modal).toBeVisible();
	await modal.getByRole("radio", { name: "General" }).check();
	await page.getByRole("button", { name: /save & close/i }).click();
	await expect(modal).toBeHidden({ timeout: 15_000 });

	// ── Release ─────────────────────────────────────────────────────────────
	await cardFor(page).getByRole("button", { name: "Release" }).click();

	// The editor proposes an allowed baseline at $0, so releasing lands in the commons.
	await expect(cardFor(page)).toContainText("Public Access");

	// And the reader-facing endpoint agrees, which is the assertion that matters: the badge
	// is derived in the browser while `publicAccess` is derived on the server, from
	// `resolveAccessSync`. Two derivations of one idea — this is where they have to meet.
	//
	// **POLLED, not read once, because those two derivations are also two clocks** — the card
	// can show its new state a moment before this endpoint reflects it. Polling changes
	// nothing about what is asserted: if the server never agrees this still fails, with the
	// same message.
	//
	// ⚠️ **On its own this was the wrong fix, and the way it failed is the useful part.**
	// Polling was tried first against the flakiness, on the reasoning above, and the next run
	// failed with `Received: null` — not `false`. A Work a fetch has not caught up with reads
	// as `false`; one that has been DELETED reads as `null`, and five seconds of polling
	// could not conjure it back. **The distinction between "not yet" and "not there" is what
	// pointed at the gauntlet reset**, which is the actual cause and is fixed above. A less
	// specific assertion would have retried its way to the same red with nothing to learn
	// from it.
	const catalogWork = () =>
		fetch(`${API_URL}/api/content/catalog/${CREATOR}`)
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
	// Same helper as the opening sweep: delete every Release-walk Work this creator owns,
	// which includes the one this run just created. A failed assertion above must not leave
	// a row behind that outlives this run — and a shared fixture must come back to empty.
	await sweepReleaseWalkWorks(session);
});
