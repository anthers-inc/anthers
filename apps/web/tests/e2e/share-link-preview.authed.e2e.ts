// SPDX-License-Identifier: Apache-2.0
/**
 * A share link's link preview names the Work, not the site.
 *
 * `/s/{token}` is the address the Share button hands a sharer, so it is the address that
 * actually gets pasted into a chat — and the token carries no slug, so the served shell
 * cannot describe it without asking the API. This walk mints a real link through the
 * surface a sharer uses, then reads the served document the way a crawler does: no
 * JavaScript, no session, just the head.
 *
 * The canonical address is asserted to be the Work's own page rather than the link that
 * was fetched. A share link is a locator and never a page; letting a crawler index
 * `/s/{token}` as one would put an address that carries no meaning into search results.
 *
 * The `.authed.` filename inherits the `gauntlet` project, whose setup releases the one
 * free Work with real media behind it — a share link can be minted only for a Work that is
 * released, streamable and free to everyone.
 */
import { gauntletPost } from "@anthers/db/gauntlet";
import { expect, test, WEB_ORIGIN } from "./fixtures";

// G1: the gauntlet's one free Work with a real transcoded video behind it.
const WORK = gauntletPost("G1");
const FREE = `/works/${WORK.slug}`;

test("a share link's preview names the Work, and canonically points at its page", async ({
	page,
}) => {
	await page.goto(FREE);
	await page.getByRole("button", { name: "Share", exact: true }).click();

	// The input starts on the page address and upgrades to the minted watch link, and that
	// upgrade is what this spec needs: the link is the address a sharer actually pastes.
	const linkInput = page.getByLabel("Share link");
	await expect(linkInput).toBeVisible();
	const linkUrl = await linkInput.inputValue();
	const token = linkUrl.split("/s/")[1];
	expect(token).toMatch(/^[0-9a-f]{8,64}$/);

	// Read it as an unfurler does: the raw document, with no script and no session.
	const res = await page.request.get(`${WEB_ORIGIN}/s/${token}`);
	expect(res.status()).toBe(200);
	const html = await res.text();

	expect(html).toContain(`<title>${WORK.title} — Anthers</title>`);
	expect(html).toContain(`<meta property="og:title" content="${WORK.title}" />`);
	// The card the recipient follows describes the Work's own page, not the opaque link.
	expect(html).toContain(
		`<link rel="canonical" href="https://anthers.org/works/${WORK.slug}-${WORK.publicId}" />`,
	);
	expect(html).toContain(
		`<meta property="og:url" content="https://anthers.org/works/${WORK.slug}-${WORK.publicId}" />`,
	);
});

test("an unknown share token keeps the site card rather than failing the page", async ({
	page,
}) => {
	const res = await page.request.get(`${WEB_ORIGIN}/s/0000000000000000notatoken`);
	expect(res.status()).toBe(200);
	const html = await res.text();

	expect(html).toContain("<title>Anthers</title>");
	expect(html).toContain('<meta property="og:title" content="Anthers" />');
	// The shell's own address, untouched: an unresolvable token never rewrites the block.
	expect(html).toContain('<meta property="og:url" content="https://anthers.org/" />');
});
