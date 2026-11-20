// SPDX-License-Identifier: Apache-2.0
/**
 * A Work, a post and a creator's profile answer with their own words in the served
 * document, not only inside the bundle.
 *
 * The standing pages' bodies are built at build time, so their suite proves the injection
 * against a map. These three pages have no words until an API read answers, and the read
 * sits on every document request — so what this walk proves is the whole path: the server
 * asks the API, the API applies the page's own gates, and the `<noscript>` block reaches
 * the document a reader with no JavaScript receives.
 *
 * The fixture is the User Gauntlet's, whose setup releases a free Work and a post about it
 * and gives the creator a bio. Reading the document through `page.request` is deliberate:
 * it is the same request a crawler makes, with no script run and no session.
 */
import { GAUNTLET_CREATOR_USERNAME, gauntletHandle, gauntletPost } from "@anthers/db/gauntlet";
import { API_URL, expect, test, WEB_ORIGIN } from "./fixtures";

const WORK = gauntletPost("G1");
/** The gauntlet seeds a post whose slug is the Work's slug plus `-post`. */
const POST = `${WORK.slug}-post`;

test("a Work's document carries its title, byline and description", async ({ page }) => {
	const res = await page.request.get(`${WEB_ORIGIN}/works/${WORK.slug}`);
	expect(res.status()).toBe(200);
	const html = await res.text();

	expect(html).toContain("<noscript>");
	expect(html).toContain(`<h1>${WORK.title}</h1>`);
	expect(html).toContain("Gauntlet Creator");
	expect(html).toContain(`${WORK.title} — a gauntlet fixture.`);
	// The app still boots from the same document: the body is an addition, not a swap.
	expect(html).toContain('<div id="root">');
});

test("a post's document carries its body, rendered from the stored markdown", async ({ page }) => {
	const res = await page.request.get(`${WEB_ORIGIN}/posts/${POST}`);
	expect(res.status()).toBe(200);
	const html = await res.text();

	expect(html).toContain("<noscript>");
	expect(html).toContain(`<h1>${WORK.title}</h1>`);
	expect(html).toContain("The free post.");
	// The Work the body links stays a link to the Work's own page.
	expect(html).toContain(`https://anthers.org/works/${WORK.slug}-${WORK.publicId}`);
});

test("a creator's profile carries their name, handle and bio", async ({ page }) => {
	const handle = await gauntletHandle(API_URL, GAUNTLET_CREATOR_USERNAME);
	const res = await page.request.get(`${WEB_ORIGIN}/@${handle}`);
	expect(res.status()).toBe(200);
	const html = await res.text();

	expect(html).toContain("<noscript>");
	expect(html).toContain("<h1>Gauntlet Creator</h1>");
	expect(html).toContain(`@${handle}`);
	expect(html).toContain("A fixture creator for the User Gauntlet.");
});
