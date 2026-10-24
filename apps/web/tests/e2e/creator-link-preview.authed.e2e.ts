// SPDX-License-Identifier: Apache-2.0
/**
 * A profile's link preview names the creator.
 *
 * A profile is shared as `/@{handle}`, and the shell carries one site-level card for every
 * route, so without this the creator's own name never reaches the link. The walk sets the
 * media fixture's display name, bio and portrait — the three facts a card is built from —
 * then reads the served document the way a crawler does: no JavaScript, no session.
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

test("a profile's preview names the creator, their words, and their portrait", async ({ page }) => {
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
	expect(html).toContain(`<meta property="og:image" content="${PORTRAIT}" />`);
	// The profile's own address, which is where the recipient lands.
	expect(html).toContain(`<link rel="canonical" href="https://anthers.org/@${handle}" />`);
});
