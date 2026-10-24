// SPDX-License-Identifier: Apache-2.0
/**
 * An **embed** — a share link rendered as a player, for a third-party page to iframe — and the
 * note that says who shared it.
 *
 * An embed is the same share link in a second shape: one affordance offers *Link* or *Embed*,
 * minted from one token, so there is one thing to revoke rather than a second pool and a second
 * gate to keep in step. This spec pins that sameness at the surface a sharer actually sees: the
 * Share button offers the two shapes as peers under the names they hand over (**Share Link**,
 * **Embed Code**), and the embed iframe snippet names the **same token** the link carries.
 *
 * It then pins where the shared-with note lives, which is the half that changed on 2026-10-23.
 * The note used to be a card *under* the player, on the page and inside the frame alike; on an
 * embed it is now an affordance on the media that stays inert until the media is hovered, and on
 * a share link it opens by itself and gets out of the way when the media is touched. Both are
 * asserted here because both are browser behavior that no unit can see.
 *
 * The token-sameness is asserted again server-side (a mint's `embedUrl` is built from the same
 * token as its `url`) in the API's share-link suite; this walk stays at the browser, where the
 * share button's two shapes are what a creator sees.
 *
 * The filename says `.authed.` to inherit the `gauntlet` project's `dependencies: ["setup"]`
 * (the fixture is the only source of a free Work with real media) — and the sharer is signed in
 * by definition, so the project's own storage state is the right one throughout. The share-link
 * case still needs a *stranger*, so it opens a context with no cookies of its own.
 */
import { gauntletPost } from "@anthers/db/gauntlet";
import { expect, test } from "./fixtures";

// G1: the gauntlet's one free Work with a real transcoded video behind it.
const FREE = `/works/${gauntletPost("G1").slug}`;

/** The Work's share token, taken the way a creator takes it: Share, then read the field. */
async function mintShareToken(page: import("@playwright/test").Page): Promise<string> {
	await page.goto(FREE);
	await page.getByRole("button", { name: "Share", exact: true }).click();
	const link = await page.getByLabel("Share Link").inputValue();
	const token = link.split("/s/")[1];
	expect(token).toMatch(/^[0-9a-f]{8,64}$/);
	return token;
}

test("the Share button offers Share Link and Embed Code, minted from one token", async ({
	page,
}) => {
	await page.goto(FREE);
	await page.getByRole("button", { name: "Share", exact: true }).click();

	// The share modal opens with the Work's page address in hand and then upgrades the
	// input to the minted share link — whose appearance is what swings the input's
	// label from "Work Link" to "Share Link", so that label being present means the
	// mint has answered.
	const linkInput = page.getByLabel("Share Link");
	await expect(linkInput).toBeVisible();
	const linkUrl = await linkInput.inputValue();
	const token = linkUrl.split("/s/")[1];
	expect(token).toMatch(/^[0-9a-f]{8,64}$/);

	// The Embed Code shape is a peer of the link, and its iframe names the SAME token —
	// one share, two renderings, rather than a second thing to meter and revoke.
	await page.getByRole("tab", { name: "Embed Code" }).click();
	const embedInput = page.getByLabel("Embed Code");
	await expect(embedInput).toBeVisible();
	const snippet = await embedInput.inputValue();
	expect(snippet).toContain("/embed/");
	expect(snippet).toContain(token);
	expect(snippet).toMatch(/^<iframe /);
});

test("an embed keeps its share note inert until the media is hovered", async ({ page }) => {
	const token = await mintShareToken(page);
	await page.goto(`/embed/${token}`);

	const stage = page.locator("[data-media-stage]");
	await expect(stage).toBeVisible();
	// The container is what fades, not the button inside it: a child's own computed opacity
	// stays 1 under a transparent parent.
	const notice = page.locator("[data-share-notice]");
	const trigger = page.getByRole("button", { name: "Who shared this" });

	// The frame on somebody else's page is the player and nothing else: the affordance is
	// there, but only under the pointer, the way a player's own controls are. The pointer
	// keeps its position across a navigation, and the Share button it was last over sits
	// where the media now is, so park it off the stage before asking.
	await page.mouse.move(0, 0);
	await expect(notice).toHaveCSS("opacity", "0");
	await expect(page.getByText(/shared this with you/)).toHaveCount(0);

	await stage.hover();
	await expect(notice).toHaveCSS("opacity", "1");

	await trigger.click();
	// The note stands over the medium it belongs to rather than below it — that placement is
	// the whole point of the change, so it is asserted structurally.
	await expect(stage.getByText(/shared this with you/)).toBeVisible();
	await expect(page.getByRole("link", { name: "Create a Free Account" })).toHaveAttribute(
		"target",
		"_blank",
	);
});

test("a share link announces itself on the media, then gets out of the way", async ({
	page,
	browser,
}) => {
	const token = await mintShareToken(page);

	// A stranger, with no cookies — the only state in which a share link is a share link.
	// The project's `use.storageState` is applied to a context this spec makes by hand, so
	// it is cleared explicitly rather than assumed absent.
	const stranger = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	try {
		const anon = await stranger.newPage();
		await anon.goto(`/s/${token}`);
		await expect(anon).toHaveURL(/\/works\//);

		const stage = anon.locator("[data-media-stage]");
		const note = stage.getByText(/shared this with you/);

		// It says so on arrival rather than asking for a hover nobody performs.
		await expect(note).toBeVisible();

		// Touching the thing they came to watch is taking up the invitation: it goes.
		await stage.click({ position: { x: 12, y: 12 } });
		await expect(note).toHaveCount(0);
	} finally {
		await stranger.close();
	}
});
