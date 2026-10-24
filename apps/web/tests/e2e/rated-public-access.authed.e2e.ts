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
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import {
	API_URL,
	CREATED_CREDIT,
	expect,
	signInAsMediaFixture,
	test,
	WEB_ORIGIN,
} from "./fixtures";

const TITLE_PREFIX = "Rated PA walk ";
const TITLE = `${TITLE_PREFIX}${Date.now()}`;
const NOTE = "Heads up: Mature and Adult Works aren't shown to everyone.";

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
			maturityRows: rowsRatedAs("mature"),
			streamEnabled: true,
			access: [{ threshold: 0, allow: true, price: "0" }],
			// The Edit page release below needs a human in the credits (`credits_creator_required`).
			credits: CREATED_CREDIT,
		}),
	});
	const { work } = (await created.json()) as { work: { publicId: number } };

	await page.goto(`/studio/works/${work.publicId}/edit`);
	// The editing surface is the Work's page (the kinds pass, 2026-10-14); the release
	// field, the rating matrix and the access table each carry their own edit state now,
	// so the walk visits them in turn and re-opens the release read after each change.
	const note = page.getByText(NOTE);

	// A Mature Work in Public Access that is not being released says nothing yet.
	await page.getByRole("button", { name: "Edit Release" }).click();
	await expect(note).toHaveCount(0);

	// Now makes the draft a release-now — the act every note in the field qualifies.
	await page.getByRole("button", { name: "Now", exact: true }).click();
	await expect(note).toBeVisible();

	// The rating alone never decides it: General is met by every user. The walk saves
	// the rating, so the release field's next edit answers from the rows that stand.
	await page.getByRole("tab", { name: "Rating" }).click();
	// The tab IS the table, always open (Parker, 2026-10-16) — no edit state to enter.
	await page.getByRole("radio", { name: "Violence: None" }).check();
	await page.getByRole("button", { name: "Save Rating" }).click();
	// ⭐ The tab flip leaves the open edit open (TabPanels keeps every panel mounted;
	//    what mounts stays mounted). The open edit answers from the saved rows as they
	//    land — the note is gone before anything is clicked again.
	await expect(note).toHaveCount(0);
	// General is met by every user; Adult is noted too — the Work goes back to Adult
	// from its Sexual Content row, and the release edit notes it again.
	await page.getByRole("tab", { name: "Rating" }).click();
	await page.getByRole("radio", { name: "Sexual Content: Adult" }).check();
	await page.getByRole("button", { name: "Save Rating" }).click();
	// Back on the Details tab, the same still-open edit now shows the Adult note.
	await page.getByRole("tab", { name: "Details" }).click();
	await expect(note).toBeVisible();

	// Out of Public Access, there is nothing to qualify. The access is the byline chip's
	// dialog; its save is what the release read answers from.
	await page.getByRole("button", { name: /public access/i }).click();
	const everyone = page.getByRole("dialog").getByRole("row", { name: /Everyone/ });
	await everyone.getByRole("checkbox").uncheck();
	await page.getByRole("button", { name: "Save Access" }).click();
	await expect(note).toHaveCount(0);
	await page.getByRole("button", { name: /gated/i }).click();
	await page
		.getByRole("dialog")
		.getByRole("row", { name: /Everyone/ })
		.getByRole("checkbox")
		.check();
	await page.getByRole("button", { name: "Save Access" }).click();
	await expect(note).toBeVisible();

	// The link opens the one answer it names, rather than the top of the FAQ.
	await page.getByRole("link", { name: "How Ratings Affect Who Sees a Work" }).click();
	await expect(page).toHaveURL(/\/faq#content-controls$/);
	const answer = page.locator("#content-controls details");
	await expect(answer).toHaveAttribute("open", "");
	await expect(answer).toBeInViewport();
});
