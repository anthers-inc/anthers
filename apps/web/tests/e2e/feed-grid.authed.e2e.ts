// SPDX-License-Identifier: Apache-2.0
/**
 * The feed grid's own contract — the wide-tile shelf Parker's redesign specifies,
 * walked on the shared walker with the fixture creator's world seeded and cleaned up.
 *
 * The tiles carry a 16:9 preview band over a card area, the same shape for every work
 * and post type; a portrait mockup cropped INTO that band is this spec's strongest
 * witness, because a band that ever sizes itself to its artwork goes unmissably tall.
 * Posts read their excerpt in the preview area and nowhere else; a hovered tile tints
 * with a soft background; the creator's name inside a tile links to the creator's
 * page rather than the tile's target; only what plays carries a play affordance (a
 * video keeps
 * one on hover, a shirt never shows one); a preview answers the viewer's stop and every
 * preview — video or audio — carries its speaker button, whose click is the persistent
 * hover-audio answer; and the grid fills the content area, flexing to fewer, larger
 * tiles as the window narrows.
 *
 * 🚨 **The scratch spec that "verified" #437's drag pinned none of this, and the
 * regressions shipped.** Pins instead of screenshots: structure, ratios, counts.
 *
 * ⚠️ **The world this spec seeds is its own and leaves with it**: a follow of the
 * fixture creator by the walker, one announcement post, and one physical Work with a
 * seeded merch variant — all deleted in `afterAll`, because the walker and the fixture
 * creator are accounts other specs in this project read.
 */

import { db } from "@anthers/db/client";
import { merchVariants, users, works } from "@anthers/db/schema";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import type { BrowserContext, Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { API_URL, signInAsMediaFixture, WEB_ORIGIN } from "./fixtures";

const BODY_TEXT =
	"The opening of the feed post body sits in the preview band, deliberately longer than a line so the clamp has room to breathe.";

/**
 * The tile WRAPPER the grid renders, from a tile's link: FeedTile's whole-card
 * target is a stretched overlay painted over a non-link card (the creator's
 * name needs a real anchor above that overlay, and an anchor inside an anchor
 * is invalid HTML the gauntlet's console watch refuses), so the overlay carries
 * the tile's name and geometry and the wrapper carries the band, the body and
 * the tint.
 */
const tileRoot = (overlay: Locator): Locator => overlay.locator("xpath=..");

/**
 * A deliberately PORTRAIT mockup (200x700): a band that sizes itself to its artwork
 * produces a tall tile, the exact regression this grid pins away.
 */
const PORTRAIT_MOCKUP = `data:image/svg+xml,${encodeURIComponent(
	"<svg xmlns='http://www.w3.org/2000/svg' width='200' height='700'><rect width='200' height='700' fill='#c0392b'/><text x='100' y='360' fill='white' font-size='40' text-anchor='middle'>MOCKUP</text></svg>",
)}`;

let creatorToken: string | null = null;
let creatorHandle = "";
let slug: string | null = null;
let shirtWorkId = 0;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
	test.setTimeout(120_000);
	const context = await browser.newContext();
	creatorToken = await signInAsMediaFixture(context as BrowserContext);
	const me = (await (
		await fetch(`${API_URL}/api/auth/me`, { headers: { Cookie: `session=${creatorToken}` } })
	).json()) as { user?: { handle?: string; id?: number } };
	const handle = me.user?.handle ?? "";
	expect(handle).toBeTruthy();
	creatorHandle = handle;
	const created = await fetch(`${API_URL}/api/content/posts`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN,
			Cookie: `session=${creatorToken}`,
		},
		body: JSON.stringify({
			title: "Feed grid walk post",
			bodyHtml: `<p>${BODY_TEXT}</p>`,
			isPublished: true,
		}),
	});
	expect(created.status).toBe(201);
	slug = ((await created.json()) as { post?: { slug?: string } }).post?.slug ?? null;
	expect(slug).toBeTruthy();

	// A physical Work with a portrait mockup, seeded straight into the session DB
	// (the same inserts the goods-in-feed unit case makes) — no thumbnail, so the
	// tile's artwork is the store's mockup.
	const [fixtureCreator] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.atprotoHandle, handle))
		.limit(1);
	expect(fixtureCreator, "the fixture creator row").toBeTruthy();
	const publicId = 900_000_000 + Math.floor(Math.random() * 10_000_000);
	const [shirt] = await db
		.insert(works)
		.values({
			creatorId: fixtureCreator.id,
			publicId,
			slug: `feed-grid-shirt-${publicId}`,
			type: "physical",
			title: "Feed grid shirt",
			thumbnail: "",
			maturity: "general",
			maturityRows: rowsRatedAs("general"),
			maturitySource: "creator",
			maturitySetAt: new Date(),
			visibility: "released",
			releasedAt: new Date(),
			access: [{ threshold: 0, allow: true, price: "0" }],
			credits: [{ role: "Made by", contributor: "Media Fixture", types: ["created"] }],
		})
		.returning();
	shirtWorkId = shirt.id;
	await db.insert(merchVariants).values({
		workId: shirt.id,
		color: "Red",
		size: "M",
		catalogVariantId: publicId,
		syncVariantId: publicId,
		catalogVariantName: "Red / M",
		catalogPrice: "9.50",
		listPrice: "30.00",
		printFileUrl: "data:text/plain,none",
		mockupUrl: PORTRAIT_MOCKUP,
	});
	await context.close();
});

test.afterAll(async ({ browser }) => {
	// The order goes back — Work and variant first, then the announcement, then the
	// walker's follow. A failed delete leaves litter; the fixture reset is the
	// next run's backstop.
	if (shirtWorkId) {
		await db.delete(merchVariants).where(eq(merchVariants.workId, shirtWorkId));
		await db.delete(works).where(eq(works.id, shirtWorkId));
	}
	const context = await browser.newContext();
	if (slug && creatorToken) {
		await fetch(`${API_URL}/api/content/posts/${slug}`, {
			method: "DELETE",
			headers: { Origin: WEB_ORIGIN, Cookie: `session=${creatorToken}` },
		}).catch(() => {});
	}
	const page = await context.newPage();
	await page.request
		.post(`${API_URL}/api/accounts/users/${creatorHandle}/unfollow`, {
			headers: { Origin: WEB_ORIGIN },
			failOnStatusCode: false,
		})
		.catch(() => {});
	await context.close();
});

test("no creator suggestions ride the feed, and the post reads one excerpt in its band", async ({
	page,
}) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 2000, height: 1100 });
	await page.goto(`${WEB_ORIGIN}/network`);

	// No creator suggestions: the section is the recommendation the feed doesn't make.
	expect(await page.evaluate(() => document.body.textContent ?? "")).not.toContain(
		"Creators to Follow",
	);

	// The walker follows the fixture creator — the page's own API carries the session.
	const follow = await page.request.post(`${API_URL}/api/accounts/users/${creatorHandle}/follow`, {
		headers: { Origin: WEB_ORIGIN },
	});
	expect([200, 201, 409]).toContain(follow.status());
	await page.reload();

	const postTile = page.getByRole("link", { name: /Feed grid walk post/ });
	await expect(postTile).toBeVisible();
	const postCard = tileRoot(postTile);

	// The preview band is 16:9: wider than tall, whatever artwork it holds.
	const band = await postCard.evaluate((el) => {
		const inner = (el as HTMLElement).querySelector(":scope > div") as HTMLElement;
		const r = inner.getBoundingClientRect();
		return { w: r.width, h: r.height };
	});
	expect(band.w / band.h, "the post tile's band reads 16:9 wide").toBeGreaterThan(1.5);

	// One excerpt: the body's opening appears exactly once in the tile — the band.
	const once = await postCard.evaluate((el) => {
		const text = (el as HTMLElement).textContent ?? "";
		return text.split("deliberately longer than a line").length - 1;
	});
	expect(once, "the excerpt appears only in the preview area").toBe(1);
});

test("the creator name inside a tile links to the creator's page, not the tile's target", async ({
	page,
}) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 2000, height: 1100 });
	await page.goto(`${WEB_ORIGIN}/network`);
	await expect(page.getByRole("link", { name: /Feed grid walk post/ })).toBeVisible();

	// The tile's surface still opens its own target: the stretched overlay takes a
	// click anywhere on the tile. This half has to be pinned too, because raising the
	// name past the overlay is exactly the change that could swallow a plain click.
	const postTile = page.getByRole("link", { name: /Feed grid walk post/ });
	await postTile.click();
	await page.waitForURL(`**/posts/${slug}*`);
	await page.goBack();
	await page.waitForURL(`**/network`);
	await expect(page.getByRole("link", { name: /Feed grid walk post/ })).toBeVisible();

	// The name's link is the only anchor in the tile aimed at a profile path — the
	// tile's own is the post's, stretched over it as an overlay. The overlay only
	// navigates because it paints over the card; the name only wins its own click
	// because it rises past the overlay. Neither is provable by reading the markup,
	// which is why the pin is clicked in a browser.
	const nameLink = tileRoot(postTile).locator("a[href^='/@']");
	await expect(nameLink).toHaveCount(1);
	await nameLink.click();
	await page.waitForURL(`**/@${creatorHandle}`);
	// The profile rendered: its handle is spoken where the page is read, not just
	// reached — a wrong-but-existing page would still pass the URL alone.
	await expect(page.getByText(`@${creatorHandle}`).first()).toBeVisible();
});

test("the goods and video tiles keep their band shapes and their hover truths", async ({
	page,
}) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 2000, height: 1100 });
	await page.goto(`${WEB_ORIGIN}/network`);

	const shirtTile = page.getByRole("link", { name: /Feed grid shirt/ });
	await expect(shirtTile).toBeVisible();
	const shirtCard = tileRoot(shirtTile);

	// The portrait mockup is CROPPED into the same 16:9 band shape — a band that
	// sized itself to its artwork would stand tall here.
	const shirtBand = await shirtCard.evaluate((el) => {
		const inner = (el as HTMLElement).querySelector(":scope > div") as HTMLElement;
		const r = inner.getBoundingClientRect();
		return { w: r.width, h: r.height };
	});
	expect(shirtBand.w / shirtBand.h, "the goods band reads 16:9 wide").toBeGreaterThan(1.5);

	// Hovering a shirt shows no play affordance: the band (where an overlay would
	// inject itself) carries no svg even under the pointer — the badge icons live
	// in the card and are not counted.
	await shirtTile.hover();
	await page.waitForTimeout(250);
	expect(
		await shirtCard.evaluate(
			(el) =>
				((el as HTMLElement).querySelector(":scope > div") as HTMLElement)?.querySelectorAll("svg")
					.length ?? -1,
		),
		"no play affordance in a goods tile's preview",
	).toBe(0);

	// A hovered tile tints — the soft highlight every tile shares (the tint is the
	// wrapper's; the overlay over it hovers with the wrapper, an ancestor of it).
	const postTile = page.getByRole("link", { name: /Feed grid walk post/ });
	const postCard = tileRoot(postTile);
	const beforeHover = await postCard.evaluate((el) => getComputedStyle(el).backgroundColor);
	await postTile.hover();
	await page.waitForTimeout(300);
	const afterHover = await postCard.evaluate((el) => getComputedStyle(el).backgroundColor);
	expect(afterHover, "the hovered tile gains a tinted background").not.toBe(beforeHover);

	// The video keeps its play affordance on hover — it is the one thing that plays.
	const videoTile = page.getByRole("link", { name: /A short film that really plays/ });
	await videoTile.hover();
	await page.waitForTimeout(250);
	expect(
		await tileRoot(videoTile).evaluate(
			(el) =>
				((el as HTMLElement).querySelector(":scope > div") as HTMLElement)?.querySelectorAll("svg")
					.length ?? -1,
		),
		"the video's play affordance shows on hover",
	).toBeGreaterThan(0);
});

test("the preview stop keeps a held hover a poster, and the default still plays", async ({
	page,
}) => {
	test.setTimeout(60_000);
	const videoName = /A short film that really plays/;
	// Long enough that the hover debounce (`PREVIEW_HOVER_DELAY_MS` is 500 ms) has
	// fired and the player would be mounted if any path allowed it.
	const hold = 1_500;

	// The stop, persisted before the page loads the way the settings page leaves it:
	// *Play previews as I browse* set off means a deliberate one-and-a-half-second
	// hold never ships a stream — the wiring guard for `tilePreviewPlayable`'s
	// first param, which no unit test can carry alone.
	await page.addInitScript(() => {
		localStorage.setItem("anthers_tile_previews", "0");
	});
	await page.setViewportSize({ width: 2000, height: 1100 });
	await page.goto(`${WEB_ORIGIN}/network`);
	const stoppedTile = page.getByRole("link", { name: videoName });
	await expect(stoppedTile).toBeVisible();
	await stoppedTile.hover();
	await page.waitForTimeout(hold);
	expect(
		await tileRoot(stoppedTile).evaluate(
			(el) => (el as HTMLElement).querySelectorAll("video").length,
		),
		"a stopped preview never mounts a player",
	).toBe(0);

	// The contrast half, from a fresh store so the same run proves the stop — and
	// not the debounce — is what withheld the preview: with no mark in storage the
	// same hold mounts the player inside the band.
	await page.addInitScript(() => {
		localStorage.removeItem("anthers_tile_previews");
	});
	await page.goto(`${WEB_ORIGIN}/network`);
	const playingTile = page.getByRole("link", { name: videoName });
	await expect(playingTile).toBeVisible();
	await playingTile.hover();
	await expect(
		tileRoot(playingTile).locator("video"),
		"the default still previews on a deliberate hold",
	).toBeAttached({ timeout: 3_000 });
});

test("the preview's speaker button turns hover audio on, and that answer persists", async ({
	page,
}) => {
	test.setTimeout(60_000);
	const videoName = /A short film that really plays/;

	await page.setViewportSize({ width: 2000, height: 1100 });
	await page.goto(`${WEB_ORIGIN}/network`);
	const tile = page.getByRole("link", { name: videoName });
	await expect(tile).toBeVisible();
	await tile.hover();
	const video = tileRoot(tile).locator("video");
	await expect(video, "the default preview mounts silently").toBeAttached({ timeout: 3_000 });
	await expect(video).toHaveJSProperty("muted", true);

	// The button rides the preview: it is the one control inside the band, and
	// flipping it ON is the gesture that un-mutes the same element mid-hover.
	const speaker = page.getByRole("button", { name: "Play hover previews with sound" });
	await expect(speaker, "a silent preview carries its speaker button").toBeVisible();
	await speaker.click();
	await expect(video, "the click unmutes the playing element").toHaveJSProperty("muted", false, {
		timeout: 2_000,
	});
	expect(
		await page.evaluate(() => localStorage.getItem("anthers_tile_preview_audio")),
		"the button writes the persistent answer",
	).toBe("1");

	// The same button is already reflecting the ON state — its own label swap is
	// this run's persistence witness, before any navigation asserts the store.
	const muteButton = page.getByRole("button", { name: "Mute hover previews" });
	await expect(muteButton).toBeVisible();
	await expect(muteButton).toHaveAttribute("aria-pressed", "true");

	// A later visit reads the remembered answer: the fresh document has had no
	// gesture of its own, so the audibility of the element is the browser's call —
	// what persists is the setting, and the button state carries it.
	await page.goto(`${WEB_ORIGIN}/network`);
	const nextTile = page.getByRole("link", { name: videoName });
	await expect(nextTile).toBeVisible();
	await nextTile.hover();
	await expect(tileRoot(nextTile).locator("video")).toBeAttached({ timeout: 3_000 });
	await expect(
		page.getByRole("button", { name: "Mute hover previews" }),
		"a later visit starts from the remembered on",
	).toBeVisible();
});

test("an audio preview carries the same speaker button and the same remembered answer", async ({
	page,
}) => {
	test.setTimeout(60_000);
	const audioName = /Track 1/;

	await page.setViewportSize({ width: 2000, height: 1100 });
	await page.goto(`${WEB_ORIGIN}/network`);
	const tile = page.getByRole("link", { name: audioName });
	await expect(tile).toBeVisible();
	await tile.hover();
	const audio = tileRoot(tile).locator("audio");
	await expect(audio, "the listened default preview mounts silently").toBeAttached({
		timeout: 3_000,
	});
	await expect(audio).toHaveJSProperty("muted", true);

	// The one control a listened preview had no reason to carry until the setting
	// reached it — the same button, the same remembered answer the video preview
	// writes, because the setting names the hover's sound rather than its medium.
	const speaker = tileRoot(tile).getByRole("button", {
		name: "Play hover previews with sound",
	});
	await expect(speaker, "an audio preview carries its speaker button").toBeVisible();
	await speaker.click();
	await expect(audio, "the click unmutes the playing element").toHaveJSProperty("muted", false, {
		timeout: 2_000,
	});
	expect(
		await page.evaluate(() => localStorage.getItem("anthers_tile_preview_audio")),
		"the button writes the persistent answer",
	).toBe("1");
});

test("the grid fills the content area and flexes as the window narrows", async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 2000, height: 1100 });
	await page.goto(`${WEB_ORIGIN}/network`);
	await expect(page.getByRole("link", { name: /Feed grid walk post/ })).toBeVisible();

	const colsAt = () =>
		page.evaluate(() => {
			const grid = [...document.querySelectorAll("main [class*='grid-cols']")].at(0) as
				| HTMLElement
				| undefined;
			if (!grid) return null;
			const first = grid.firstElementChild as HTMLElement | null;
			const rowTiles = first
				? [...grid.querySelectorAll(":scope > [data-testid='feed-tile']")].filter((t) => {
						const r = (t as HTMLElement).getBoundingClientRect();
						const f = first.getBoundingClientRect();
						return Math.abs(r.top - f.top) < 4;
					}).length
				: 0;
			return { gridW: Math.round(grid.getBoundingClientRect().width), cols: rowTiles };
		});

	const wide = await colsAt();
	expect(wide, "the grid renders").not.toBeNull();
	expect(wide?.gridW ?? 0, "the grid takes the content area's width").toBeGreaterThan(1500);
	expect(wide?.cols ?? 0, "several tiles wide at the wide window").toBeGreaterThanOrEqual(4);

	await page.setViewportSize({ width: 1000, height: 900 });
	await page.waitForTimeout(300);
	const narrow = await colsAt();
	expect(narrow?.cols ?? 0, "fewer tiles per row when the window narrows").toBeLessThan(
		wide?.cols ?? 0,
	);
});
