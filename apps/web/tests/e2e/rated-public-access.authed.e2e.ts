// SPDX-License-Identifier: Apache-2.0
/**
 * The note a creator meets when releasing a Mature or Adult Work into Public Access, walked in a
 * browser, and the FAQ answer it links to.
 *
 * What this proves beyond `rated-public-access.test.ts` is that the page feeds the rule what the
 * form actually holds: the note answers each change to the rating, the release checkbox and the
 * Everyone row as it happens, before anything is saved. It also follows the link, because an
 * anchor that opens nothing lands the creator at the top of a long page.
 *
 * Runs on `media_fixture`, which has payouts set up, since the release checkbox is locked for a
 * creator who could not release. Nothing is saved, so the Work is never actually released.
 */
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const TITLE_PREFIX = "Rated PA walk ";
const TITLE = `${TITLE_PREFIX}${Date.now()}`;
const NOTE = "Heads up: Mature and Adult Works aren't shown to every reader.";

let session = "";

async function sweep(): Promise<void> {
	if (!session) return;
	const res = await fetch(`${API_URL}/api/content/works`, {
		headers: { Cookie: `session=${session}` },
	});
	const { works } = (await res.json()) as { works: Array<{ id: number; title: string }> };
	for (const w of works.filter((w) => w.title.startsWith(TITLE_PREFIX))) {
		await fetch(`${API_URL}/api/content/works/${w.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
}

test.afterAll(sweep);

test("a creator releasing rated work into Public Access is told who will see it", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	await sweep();

	const created = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${session}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({
			type: "text",
			title: TITLE,
			bodyHtml: "<p>A walk.</p>",
			maturity: "mature",
			streamEnabled: true,
			seedAccess: [{ threshold: 0, allow: true, price: "0" }],
		}),
	});
	const { work } = (await created.json()) as { work: { publicId: number } };

	await page.goto(`/studio/works/${work.publicId}/edit`);
	const note = page.getByText(NOTE);
	const released = page.getByLabel("Released to my public Catalog");
	const everyone = page.getByRole("row", { name: /Everyone/ }).getByRole("checkbox");

	// A Mature Work in Public Access that is not being released says nothing yet.
	await expect(released).toBeEnabled();
	await expect(note).toHaveCount(0);

	await released.check();
	await expect(note).toBeVisible();

	// The rating alone never decides it: General is met by every reader, and Adult is noted too.
	await page.getByRole("radio", { name: /^General/ }).check();
	await expect(note).toHaveCount(0);
	await page.getByRole("radio", { name: /^Adult/ }).check();
	await expect(note).toBeVisible();

	// Out of Public Access, there is nothing to qualify.
	await everyone.uncheck();
	await expect(note).toHaveCount(0);
	await everyone.check();
	await expect(note).toBeVisible();

	// The link opens the one answer it names, rather than the top of the FAQ.
	await page.getByRole("link", { name: "How Ratings Affect Who Sees a Work" }).click();
	await expect(page).toHaveURL(/\/faq#content-controls$/);
	const answer = page.locator("#content-controls details");
	await expect(answer).toHaveAttribute("open", "");
	await expect(answer).toBeInViewport();
});
