// SPDX-License-Identifier: Apache-2.0
/**
 * An **embed** — a share link rendered as a player, for a third-party page to iframe.
 *
 * An embed is the same share link in a second shape: one affordance offers *Link* or
 * *Embed*, minted from one token, so there is one thing to revoke rather than a second pool
 * and a second gate to keep in step. This spec pins that sameness at the surface a sharer
 * actually sees: the Share button offers the two shapes as peers, and the embed iframe
 * snippet names the **same token** the link carries — one share, two renderings, never a
 * second access path.
 *
 * The token-sameness is asserted again server-side (a mint's `embedUrl` is built from the
 * same token as its `url`) in the API's share-link suite; this walk stays at the browser,
 * where the share button's two shapes are what a creator sees.
 *
 * The filename says `.authed.` to inherit the `gauntlet` project's `dependencies: ["setup"]`
 * (the fixture is the only source of a free Work with real media) — and the sharer is signed
 * in by definition, so the project's own storage state is the right one throughout.
 */
import { gauntletPost } from "@anthers/db/gauntlet";
import { expect, test } from "./fixtures";

// G1: the gauntlet's one free Work with a real transcoded video behind it.
const FREE = `/works/${gauntletPost("G1").slug}`;

test("the Share button offers Link and Embed shapes, minted from one token", async ({ page }) => {
	await page.goto(FREE);
	await page.getByRole("button", { name: "Share", exact: true }).click();

	// The Link shape is the default; its input carries the share URL with its token.
	const linkInput = page.getByLabel("Share link");
	await expect(linkInput).toBeVisible();
	const linkUrl = await linkInput.inputValue();
	const token = linkUrl.split("/s/")[1];
	expect(token).toMatch(/^[0-9a-f]{8,64}$/);

	// The Embed shape is a peer of the link, and its iframe names the SAME token — one
	// share, two renderings, rather than a second thing to meter and revoke.
	await page.getByRole("tab", { name: "Embed" }).click();
	const embedInput = page.getByLabel("Embed code");
	await expect(embedInput).toBeVisible();
	const snippet = await embedInput.inputValue();
	expect(snippet).toContain("/embed/");
	expect(snippet).toContain(token);
	expect(snippet).toMatch(/^<iframe /);
});
