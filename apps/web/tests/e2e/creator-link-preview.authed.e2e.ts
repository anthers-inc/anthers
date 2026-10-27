// SPDX-License-Identifier: Apache-2.0
/**
 * A profile's link preview names the creator, and shows their own card.
 *
 * A profile is shared as `/@{handle}`, and the shell carries one site-level card for every
 * route, so without this the creator's own name never reaches the link. The walk sets the
 * media fixture's display name, bio and portrait — the three facts a card is built from —
 * then reads the served document the way a crawler does: no JavaScript, no session.
 *
 * ⭐ **The image is the composed card, not the portrait it is made from.** That distinction is
 * the whole point of the walk: an unfurler handed the portrait crops a square into a wide box,
 * and for a creator whose portrait is a mark it reads as the platform rather than the person.
 * So the assertion is that the document names the card's own address, and that the address
 * really answers with an image.
 *
 * The filename says `.authed.` only to inherit the gauntlet project's setup, which is what
 * seeds the media fixture; the request below carries no credentials, which is the point.
 */

import { db } from "@anthers/db/client";
import { MEDIA_FIXTURE_EMAIL } from "@anthers/db/media-fixture";
import { users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { expect, test, WEB_ORIGIN } from "./fixtures";

const DISPLAY_NAME = "Media Fixture";
const BIO = "Nine works of every kind, written for the preview walk.";
const PORTRAIT = "https://cdn.anthers.org/creators/4/avatars/preview-walk.webp";

test("a profile's preview names the creator and serves their composed card", async ({ page }) => {
	const [creator] = await db
		.select({ handle: users.atprotoHandle })
		.from(users)
		.where(eq(users.email, MEDIA_FIXTURE_EMAIL))
		.limit(1);
	expect(creator?.handle, "the media fixture account exists").toBeTruthy();
	const handle = creator!.handle!;

	// The fixture is reseeded per browser session, so setting these on its own row is the
	// test's precondition rather than a change to anything anybody keeps.
	await db
		.update(users)
		.set({ displayName: DISPLAY_NAME, bio: BIO, avatar: PORTRAIT })
		.where(eq(users.email, MEDIA_FIXTURE_EMAIL));

	const res = await page.request.get(`${WEB_ORIGIN}/@${handle}`);
	expect(res.status()).toBe(200);
	const html = await res.text();

	expect(html).toContain(`<title>${DISPLAY_NAME} — Anthers</title>`);
	expect(html).toContain(`<meta property="og:title" content="${DISPLAY_NAME}" />`);
	expect(html).toContain(`<meta property="og:description" content="${BIO}" />`);
	// The card's own address, which is what the crawler fetches — not the portrait. The
	// origin is the deployment's (`BASE_URL`/`FRONTEND_URL` at the API, whose host differs
	// between a browser session and CI), so the assertion is on the path and the fetch uses
	// exactly what the document named.
	const card = /<meta property="og:image" content="([^"]+)" \/>/.exec(html)?.[1];
	expect(card?.endsWith(`/api/accounts/users/${handle}/card.png`)).toBe(true);
	expect(html).toContain(
		`<meta property="og:image:alt" content="The profile card for ${DISPLAY_NAME} on Anthers." />`,
	);
	// The profile's own address, which is where the recipient lands.
	expect(html).toContain(`<link rel="canonical" href="https://anthers.org/@${handle}" />`);

	// And the address answers with the image the card promised. The fixture's portrait is a
	// URL with no upload behind it, so the composition finds nothing to draw and renders the
	// card's empty ground — the fallback that keeps a preview from ever being a broken image.
	const image = await page.request.get(card!);
	expect(image.status()).toBe(200);
	expect(image.headers()["content-type"]).toBe("image/png");
});
