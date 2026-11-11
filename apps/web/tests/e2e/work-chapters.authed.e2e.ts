// SPDX-License-Identifier: Apache-2.0
/**
 * Creator-authored chapters, walked in a browser.
 *
 * The YouTube model (Parker, 2026-10-13): the creator types timestamps into the
 * description; every one of them is a chapter cue; the timestamps render as links
 * that reach the page's mounted player — the description's and a review's alike,
 * both being plain text under the same scope — while the players segment their seek
 * bar over the cues and mount a chapter list in their own transport. Every one of
 * these can break silently on a page where the media still plays, which is the
 * failure shape the player specs were written against.
 *
 * ⚠️ **The audio Work's player below runs bar-driven** (the account's Use Persistent
 * Miniplayer, whose default reading is on): the page renders no element, so a cue or
 * a timestamp link *starts the bar at the moment it names* — which the prototype hook
 * still catches, because it replaces HTMLMediaElement's own accessor and the bar's
 * `new Audio()` element goes through it. The video keeps the page-local player, so
 * its seek assertions read the video element's writes unchanged.
 *
 * The fixtures are the media fixture's episode (spoken) and clip (video), whose
 * descriptions carry `0:00` and `0:02` cues — the fixture clips are seconds long,
 * so the cues sit inside their real duration and the end-filter leaves both rows
 * standing.
 *
 * 🚨 Chromium's demuxer on a clip this short snaps seeks back to zero (the spoken
 * player spec's note), so every movement assertion reads the `currentTime` WRITES
 * the player makes, not the position it settles at — the player's own behavior.
 * The hooks are installed on the prototype via `addInitScript`, before the page's
 * scripts, so a landed `?t` is caught on its way in.
 *
 * The review fixture is the walker's own review, posted over itself — the API keeps
 * one review per user per Work and upserts, so re-runs re-write one row rather than
 * piling up. No other suite reads reviews on the media fixture's Works, which is
 * what makes a persistent review row acceptable here.
 */
import { mediaFixtureWork } from "@anthers/db/media-fixture";
import type { Page } from "@playwright/test";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const EPISODE = mediaFixtureWork("episode");
const CLIP = mediaFixtureWork("video");
const BAR = "[data-testid=player-bar]";

type Kind = "audio" | "video";

/** Install the prototype hook that records a media element's `currentTime` writes. */
async function hookCurrentTime(page: Page, kind: Kind) {
	await page.addInitScript((kind: Kind) => {
		const writes: number[] = [];
		(window as unknown as { __mediaTimeWrites?: number[] }).__mediaTimeWrites = writes;
		const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")!;
		Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
			get() {
				return desc.get!.call(this);
			},
			set(v: number) {
				if ((this as HTMLMediaElement).tagName === (kind === "audio" ? "AUDIO" : "VIDEO")) {
					writes.push(v);
				}
				desc.set!.call(this, v);
			},
			configurable: true,
		});
	}, kind);
}

const timeWrites = async (page: Page): Promise<number[]> =>
	(await page.evaluate(
		() => (window as unknown as { __mediaTimeWrites?: number[] }).__mediaTimeWrites,
	)) ?? [];

/**
 * Give the signed-in walker the consumption evidence a page visit would produce.
 *
 * The review composer is locked for a reader who has not spent recorded time with the
 * Work, and the player's attention flushes on its own schedule — too late for a review
 * posted in the same walk. The API is the same one the player flushes to.
 */
async function seedConsumption(page: Page, work: { slug: string; publicId: number }) {
	const cookies = await page.context().cookies();
	const session = cookies.find((cookie) => cookie.name === "session")?.value;
	expect(session, "the walker's session cookie").toBeTruthy();

	const read = await fetch(`${API_URL}/api/content/works/${work.slug}-${work.publicId}`);
	expect(read.status).toBe(200);
	const { work: row } = (await read.json()) as {
		work: { id: number; creatorId: number | null };
	};
	expect(row.creatorId, "the fixture Work has a creator").not.toBeNull();

	const endedAt = Date.now();
	const recorded = await fetch(`${API_URL}/api/subscriptions/attention`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN,
			Cookie: `session=${session}`,
		},
		body: JSON.stringify({
			events: [
				{
					creatorId: row.creatorId,
					workId: row.id,
					eventType: "listen",
					durationSeconds: 2,
					startedAt: endedAt - 2_000,
					endedAt,
					clientId: `e2e-review-${crypto.randomUUID()}`,
				},
			],
		}),
	});
	expect(recorded.status, "seeding the walker's consumption").toBe(200);
}

test("an audio Work's page lists the chapters its description carries", async ({ page }) => {
	await page.goto(`/works/${EPISODE.slug}-${EPISODE.publicId}`);

	const list = page.getByTestId("chapter-list");
	await expect(list).toBeVisible();
	// Both cues, titled off their own lines as the description wrote them.
	await expect(list.getByRole("button", { name: /Welcome/ })).toBeVisible();
	await expect(list.getByRole("button", { name: /The interview begins/ })).toBeVisible();

	// The playhead opens at zero, inside the 0:00 cue — the row marked playing.
	await expect(list.getByRole("button", { name: /0:00 Welcome/ })).toHaveAttribute(
		"aria-current",
		"true",
	);
});

test("a chapter row starts the bar at the moment it names", async ({ page }) => {
	/*
	 * Bar-driven playback (the account default's reading is on) owns no page element:
	 * the hook below catches the BAR's `new Audio()` element too, because it replaces
	 * the prototype's accessor, so the moment's write is still the observable.
	 */
	await hookCurrentTime(page, "audio");
	await seedConsumption(page, EPISODE);
	await page.goto(`/works/${EPISODE.slug}-${EPISODE.publicId}`);
	await expect(page.getByTestId("chapter-list")).toBeVisible();

	await page.getByRole("button", { name: /The interview begins/ }).click();

	// The seek naming a moment starts listening at it — the same meaning an
	// unreachable element seek always had, now routed through the bar.
	await expect(page.locator(BAR)).toBeVisible();
	await expect
		.poll(() => timeWrites(page), { message: "the cue never reached the bar" })
		.toContain(2);
	await expect(page.locator(`${BAR} [data-testid=now-playing-title]`)).toHaveText(EPISODE.title);
});

test("a timestamp in the description is a link that starts the bar at the moment it names", async ({
	page,
}) => {
	await hookCurrentTime(page, "audio");
	await page.goto(`/works/${EPISODE.slug}-${EPISODE.publicId}`);

	// The description renders every cue as a link — exactly one here names 0:02; the
	// chapter list's same-labeled row is a button, not a link.
	const anchor = page.getByRole("link", { name: "0:02", exact: true });
	await expect(anchor).toBeVisible();
	await anchor.click();

	await expect(page.locator(BAR)).toBeVisible();
	await expect
		.poll(() => timeWrites(page), { message: "the link never reached the bar" })
		.toContain(2);
	// The address keeps carrying the moment, so a copy lands where the viewer is.
	await expect(page).toHaveURL(/[*?&]t=2(&|$)/);
});

test("a ?t address plays from the moment it names, not from the resume", async ({ page }) => {
	await hookCurrentTime(page, "audio");
	await page.goto(`/works/${EPISODE.slug}-${EPISODE.publicId}?t=2`);
	await expect(page.getByTestId("chapter-list")).toBeVisible();

	// Bar-driven playback loads nothing until something is pressed, so the ?t rides
	// the play. The only element write it should produce is the moment itself — the
	// seekOnce the provider runs writes the target exactly once — so whatever
	// position a previous run remembered must NOT appear in its place: startSeconds
	// outranking the resume is the rule.
	await page
		.locator("[data-testid=spoken-player]")
		.getByRole("button", { name: "Play", exact: true })
		.click();
	await expect(page.locator(BAR)).toBeVisible();
	await expect
		.poll(() => timeWrites(page), { message: "the ?t seek never wrote currentTime" })
		.toContain(2);
});

test("the video player carries the chapter list its description segments", async ({ page }) => {
	await hookCurrentTime(page, "video");
	await page.goto(`/works/${CLIP.slug}-${CLIP.publicId}`);
	await expect(page.locator("video")).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => document.querySelector("video")?.duration ?? 0), {
			timeout: 15_000,
			message: "the video never reported a duration — HLS did not attach",
		})
		.toBeGreaterThan(0);

	const list = page.getByTestId("chapter-list");
	await expect(list).toBeVisible();
	await expect(list.getByRole("button", { name: /The good part/ })).toBeVisible();

	await list.getByRole("button", { name: /The good part/ }).click();
	expect(await timeWrites(page)).toContain(2);
});

test("a review's timestamp is a link that starts the bar at the moment it names", async ({
	page,
}) => {
	await hookCurrentTime(page, "audio");
	await seedConsumption(page, EPISODE);
	await page.goto(`/works/${EPISODE.slug}-${EPISODE.publicId}`);
	await expect(page.getByTestId("chapter-list")).toBeVisible();
	// The section headings render once the aggregate has arrived, which is when the
	// card and the composer are decided.
	await expect(page.getByRole("heading", { name: "Your Review" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Other Reviews" })).toBeVisible();

	// The walker's own review, re-posted over its previous self on every run. An earlier
	// run leaves a review, which now opens as the walker's own rather than as an open
	// composer, so the second and later runs take the Edit door. The section itself is
	// always present now, so Edit is what tells the two states apart.
	const edit = page.getByTestId("your-review").getByRole("button", { name: "Edit" });
	if ((await edit.count()) > 0) {
		await edit.click();
	} else {
		await page.getByRole("button", { name: "Recommend", exact: true }).click();
	}
	const body = "Watch from 0:02 on. You're welcome.";
	await page.locator("textarea").fill(body);
	await page.getByRole("button", { name: /Post review|Save changes/ }).click();

	// Two cues named 0:02 render once the review lands — the description's and the
	// review's; the review renders further down the page, and the last is it.
	const reviewAnchor = page.getByRole("link", { name: "0:02", exact: true }).last();
	await expect(reviewAnchor).toBeVisible();
	await reviewAnchor.click();

	await expect(page.locator(BAR)).toBeVisible();
	await expect
		.poll(() => timeWrites(page), { message: "the review link never reached the bar" })
		.toContain(2);
});

test("the creator's own Work states the review and vote refusals in place", async ({
	page,
	context,
}) => {
	// The media fixture creator owns the episode, so the side column's Reviews tab is the
	// creator's view of their own reception. `#reviews` is a real address for that tab.
	await signInAsMediaFixture(context);
	await page.goto(`/works/${EPISODE.slug}-${EPISODE.publicId}#reviews`);

	await expect(page.getByRole("heading", { name: "Your Review" })).toBeVisible();
	// The section is a card carrying the reason, not a composer whose every control is
	// disabled: there is nothing here that would only refuse when pressed.
	await expect(page.getByTestId("your-review")).toContainText("You can't review your own Work.");
	await expect(page.getByRole("button", { name: "Recommend", exact: true })).toHaveCount(0);
	// ⚠️ The helpfulness controls are disabled with the same reason, but this fixture has
	// no review a public list would show: the only reviewer here is the walker, whose
	// account is a test account and is filtered out of the public list. The vote refusal
	// is proven in `reviews.test.ts`; the client passes the same reason to the control.
});
