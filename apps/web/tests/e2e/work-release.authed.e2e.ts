// SPDX-License-Identifier: Apache-2.0
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
 * published, its page loads for the person checking, and no user can get in.
 *
 * Runs in the `authed` project. A signed-out version of these assertions would pass
 * whether or not any of it works — see the note at the top of `studio-routes.authed.e2e.ts`
 * for why that vacuity is worth avoiding rather than tolerating.
 *
 * Uses a `service` Work throughout: it needs no media, so nothing here waits on ffmpeg or
 * on pg-boss, and the release-readiness gate (which applies only to processed types) stays
 * out of the way of the thing being tested.
 */
import { gauntletHandle } from "@anthers/db/gauntlet";
import { MEDIA_FIXTURE_USERNAME } from "@anthers/db/media-fixture";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

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
	originallyReleased?: string | null;
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
 * assertion below fails at the first `goto("/studio/works")`. The handoff that tried it
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
/** The creator's issued handle, which is what the public Catalog route keys on now. */
let creatorHandle = "";

/** The table row for our Work, found by its unique title rather than by position in the table. */
const rowsFor = (page: import("@playwright_test").Page) =>
	page.locator("tbody tr").filter({ hasText: TITLE });

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
	const session = await signInAsMediaFixture(context);
	creatorHandle = await gauntletHandle(API_URL, CREATOR);

	// ── Sweep ───────────────────────────────────────────────────────────────
	// A previous run that crashed after Create leaves a `Release walk %` Work on the shared
	// `media_fixture` account. Clean it up before this run creates its own, so the Catalog
	// view the walk reads starts from a known state — and so a shared fixture does not
	// accumulate litter across failed local runs. See `sweepReleaseWalkWorks` above.
	await sweepReleaseWalkWorks(session);

	// ── Create ──────────────────────────────────────────────────────────────
	//
	// ⭐ **Two pages, not one form** (2026-09-16). "New Work" opens the Upload page, which asks
	// for a type, a title and the file and nothing else, and creating lands on the Work's own
	// Edit page because everything else lives there — Release included, since `POST /works`
	// refuses `visibility: "released"` outright. The walk asserts on URLs between the steps
	// because each step is a page with an address, and "the right page opened" is the claim.
	await page.goto("/studio/works");
	await expect(page.getByRole("heading", { name: "Works", exact: true })).toBeVisible();

	await page
		.getByRole("link", { name: /new work/i })
		.first()
		.click();
	await expect(page).toHaveURL(/\/studio\/works\/new$/);
	await expect(page.getByRole("heading", { name: "Upload a Work" })).toBeVisible();

	// The Upload page asks for nothing past the three inputs, and this is the assertion for
	// it: Release, the rating and access are not rendered at all before the Work exists.
	for (const section of ["Release", "Rating", "Access"]) {
		await expect(page.getByRole("heading", { name: section })).toHaveCount(0);
	}

	// ⚠️ Located by position and placeholder, never by label: `FormField` renders its label as
	// a SIBLING of the input with no `htmlFor`, so `getByLabel` matches nothing on this form
	// whether or not the field exists — a locator that cannot fail. Same note as
	// `studio-routes.authed.e2e.ts`. The Release checkbox below is the exception and is
	// reached by role+name, because that input really is nested inside its `<label>`.
	await page.locator("select").first().selectOption("service");
	await page.getByPlaceholder("Work title").fill(TITLE);

	await page.getByRole("button", { name: /create work/i }).click();
	// ⚠️ A longer wait than the 5s default, here and at Save below — both are a navigation on
	// the far side of a write, and this suite shares its Postgres with the unit suites.
	// Headroom only: it is NOT the explanation for the flakiness this spec was famous for,
	// which was the fixture deletion described above. An earlier pass attributed the timeouts
	// to a loaded machine, which was plausible, unverified and wrong.
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/, { timeout: 15_000 });

	// Release appears on the far side of create, in the Details tab, at a URL that can
	// be linked to — the Work's own page is the editing surface (the kinds pass).
	await expect(page.getByRole("heading", { name: "Release", exact: true })).toBeVisible();
	// The tab leads with what the Work is and the tags that describe it, and puts when
	// it came out under them (Parker, 2026-10-19) — the creator's Details tab carries
	// those three sections.
	await expect(page.getByRole("tabpanel", { name: "Details" }).locator("h3")).toHaveText([
		"Description",
		"Tags",
		"Release",
	]);

	// ── Unrated, and therefore unreleasable ─────────────────────────────────
	// A Work is born `unrated` and the server refuses to release one (`maturity_undeclared`),
	// so the control refuses the click rather than earning the error. The release field's
	// edit state is where the checkbox lives now.
	await page.getByRole("button", { name: "Edit Release" }).click();
	await expect(
		page.getByRole("checkbox", { name: /released to my public catalog/i }),
	).toBeDisabled();
	await page.getByRole("button", { name: "Cancel editing Release" }).click();

	await page.goto("/studio/works");
	// Born private. Not a detail — it is why a Release control has to exist at all.
	await expect(rowsFor(page)).toContainText("Private");

	// The row says the same thing, because this listing is how a back catalog gets released
	// thirty at a time and thirty identical 409s is the failure this prevents. The acts
	// live behind the Release Date cell's pencil, the page's own affordance.
	await expect(rowsFor(page)).toContainText("Rate this");
	await rowsFor(page).getByRole("button", { name: "Edit Release Date" }).click();
	await expect(
		rowsFor(page).getByRole("button", { name: "Release now", exact: true }),
	).toBeDisabled();
	await rowsFor(page).getByRole("button", { name: "Cancel editing the release date" }).click();

	// The thumbnail opens the Work as the title does, since it is the biggest thing on the row
	// and the first thing a creator clicks. It is kept out of the accessibility tree because the
	// title already names the same link, so it is found by its place on the row, not by role.
	await rowsFor(page).locator('a[aria-hidden="true"]').click();
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/);
	await page.goto("/studio/works");

	// ── Rate it ─────────────────────────────────────────────────────────────
	// ⭐ The row's blocked-release hint is a LINK now rather than a tooltip. It could not be
	// one while the editor had no URL, which is the smallest concrete thing the page bought.
	await rowsFor(page).getByRole("link", { name: "Rate this" }).click();
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/, { timeout: 15_000 });
	// Rated through the table, in the tab itself (always open, Parker, 2026-10-16): every
	// row answered None is a General Work.
	await page.getByRole("tab", { name: "Rating" }).click();
	await page
		.getByRole("tabpanel", { name: "Rating" })
		.locator("table")
		.getByRole("button", { name: "None", exact: true })
		.click();
	await page.getByRole("button", { name: "Save Rating" }).click();
	// The Rating tab is the badge and the table, with no line explaining what a
	// General rating means (Parker, 2026-10-19) — neither the visitor's wording nor
	// the creator's shorter copy.
	await expect(page.getByText(/users see no rating on a General Work/i)).toHaveCount(0);
	// The credits, in the Credits tab's own field. Release refuses a Work whose credits
	// name no human (`credits_creator_required`), and the walk is through the UI rather
	// than around it: add a credit, tick its Created box, and name the person — the
	// shape every creator now meets before release.
	await page.getByRole("tab", { name: "Credits" }).click();
	await page.getByRole("button", { name: "Edit Credits" }).click();
	await page.getByRole("button", { name: "Add a credit" }).click();
	await page.getByRole("textbox", { name: "Credit 1 role" }).fill("Made by");
	await page.getByRole("checkbox", { name: "Credit 1 Created" }).check();
	const contributor = page.getByRole("textbox", { name: "Credit 1 contributors" });
	await contributor.fill(CREATOR);
	await contributor.press("Enter");
	await page.getByRole("button", { name: "Save Credits" }).click();

	// The original release date, in its own field beside Release. Its whole reason for
	// existing is back-dating a catalog, which is what a creator arriving with years of
	// work actually does.
	await page.getByRole("tab", { name: "Details" }).click();
	await page.getByRole("button", { name: "Edit Original release date" }).click();
	await page.getByRole("textbox", { name: "Original release date" }).fill("2015-01-15");
	await page.getByRole("button", { name: "Save Original release date" }).click();
	await page.goto("/studio/works");

	// ── Release ─────────────────────────────────────────────────────────────
	await rowsFor(page).getByRole("button", { name: "Edit Release Date" }).click();
	await rowsFor(page).getByRole("button", { name: "Release now", exact: true }).click();

	// The editor proposes an allowed baseline at $0, so releasing lands in the commons.
	await expect(rowsFor(page)).toContainText("Public Access");

	// And the user-facing endpoint agrees, which is the assertion that matters: the badge
	// is derived in the browser while `publicAccess` is derived on the server, from
	// `resolveAccessSync`. Two derivations of one idea — this is where they have to meet.
	//
	// **POLLED, not read once, because those two derivations are also two clocks** — the row
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
		fetch(`${API_URL}/api/content/catalog/${creatorHandle}`)
			.then((r) => r.json() as Promise<{ works: PublicWork[] }>)
			.then((cat) => cat.works.find((w) => w.title === TITLE));

	await expect
		.poll(async () => (await catalogWork())?.publicAccess ?? null, {
			message: "the released Work never became Public Access in the public Catalog",
		})
		.toBe(true);
	const published = await catalogWork();

	/**
	 * The original release date survived the form.
	 *
	 * ⚠️ Added after a sabotage run: stubbing the date to `null` in the editor left this
	 * spec green, because filling a field in is not the same as asserting it was sent. The
	 * wiring is the half that actually breaks when someone reshuffles the request body.
	 */
	expect(published?.originallyReleased).toBe("2015-01-15T00:00:00.000Z");

	// ── The locked state ────────────────────────────────────────────────────
	// The row's title is the Work's page, which is the editing surface for its creator —
	// the row has no Edit button of its own any more (Parker, 2026-10-17).
	await rowsFor(page).getByRole("link", { name: TITLE }).click();
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/, { timeout: 15_000 });

	// The access is edited from the chip in the byline strip (the creator's door, the
	// same dialog the video pass built): its rows are the Access table. Warning first,
	// while the change is still only in the form — the dialog says what the cut does
	// before it saves, not after a user finds it.
	await page.getByRole("button", { name: /public access/i }).click();
	await page.getByRole("dialog").locator("table").getByRole("checkbox").first().uncheck();
	await expect(page.getByText(/nobody can open this yet/i)).toBeVisible();

	await page.getByRole("button", { name: "Save Access" }).click();
	await page.goto("/studio/works");
	await expect(rowsFor(page)).toContainText("Nobody Can Open");

	// Still released, and now genuinely shut: the server drops it from what a user sees.
	// Polled for the same reason as the read after Release — and note this direction was
	// already tolerant of the race by accident, since `find(...)?.publicAccess` on a Work
	// the fetch has not caught up with is `undefined`, which is falsy and passes. A read
	// that cannot fail from being early also cannot prove the change landed.
	await expect
		.poll(async () => Boolean((await catalogWork())?.publicAccess), {
			message: "the locked Work is still Public Access to a user",
		})
		.toBe(false);

	// ── Clean up ────────────────────────────────────────────────────────────
	// Same helper as the opening sweep: delete every Release-walk Work this creator owns,
	// which includes the one this run just created. A failed assertion above must not leave
	// a row behind that outlives this run — and a shared fixture must come back to empty.
	await sweepReleaseWalkWorks(session);
});
