// SPDX-License-Identifier: Apache-2.0
/**
 * The alpha notice above the signed-in app's top bar — shown until its own X puts it away,
 * and not shown again afterwards.
 *
 * The things pinned here are the decisions the notice makes. It is the topmost strip of the
 * shell and its sentence is centered; closing it is what puts it away and no timer does, so
 * the reload is the assertion that matters; and it belongs to the app chrome, so a signed-in
 * reader consulting a marketing page — which wears the marketing shell even behind a session
 * (`marketing-chrome.authed.e2e.ts`) — does not meet it, and neither does anybody signed out.
 *
 * ⚠️ **The remembered answer is per browser** (`lib/alpha-notice.ts`), so each Playwright
 * context starts from the storage state the project was given rather than from another
 * spec's clicks; the dismissal written here dies with the context.
 */
import { expect, test } from "@playwright/test";

const NOTICE = /Anthers is in alpha, and might still have some rough edges\./;

test("a signed-in reader meets the alpha notice, and closing it keeps it away", async ({
	page,
}) => {
	await page.goto("/discovery");

	const notice = page.getByText(NOTICE);
	await expect(notice).toBeVisible();
	await expect(notice).toHaveCSS("text-align", "center");
	// The notice is above the top bar, not the first of the status strips below it.
	const noticeBox = await notice.boundingBox();
	const headerBox = await page.getByRole("banner").boundingBox();
	if (!noticeBox || !headerBox) throw new Error("the notice and the header must both be laid out");
	expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(headerBox.y + 1);

	// The notice's one action: a real door to write through, not dead text.
	await expect(page.getByRole("link", { name: "contact@anthers.org" })).toHaveAttribute(
		"href",
		"mailto:contact@anthers.org",
	);

	await page.getByRole("button", { name: "Dismiss the alpha notice" }).click();
	await expect(page.getByText(NOTICE)).toHaveCount(0);

	// No timer, no route change, no second visit: the reader's close is the whole rule.
	await page.reload();
	await expect(page.getByText(NOTICE)).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Dismiss the alpha notice" })).toHaveCount(0);
});

test("the notice is the app chrome's, so marketing pages and signed-out readers do not carry it", async ({
	page,
	browser,
}) => {
	// Signed in, on a page that deliberately wears the marketing shell.
	await page.goto("/faq");
	await expect(page.getByRole("banner").getByRole("link", { name: "Sign Up Free" })).toBeVisible();
	await expect(page.getByText(NOTICE)).toHaveCount(0);

	// Signed out, on the homepage a stranger lands on.
	const visitorContext = await browser.newContext();
	const visitor = await visitorContext.newPage();
	try {
		await visitor.goto("/");
		await expect(visitor.getByText(NOTICE)).toHaveCount(0);
	} finally {
		await visitorContext.close();
	}
});
