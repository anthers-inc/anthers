// SPDX-License-Identifier: Apache-2.0
/**
 * Discovery's *Don't Show* rows, walked in a browser (Parker, 2026-11-06; the lists and the
 * actions landed 2026-11-10).
 *
 * 🚨 **The menu row and the settings list are one feature, and each is useless alone.** A
 * row that hides but leaves no list is a control with no way back — the tile it hid is gone
 * from the stream, so the settings card is the only route to undo it. A list with no row is a
 * page nobody can put anything in. So each walk goes the whole circle: hide from the tile,
 * find it named in *Hidden from Discovery*, show it again, and see the tile return.
 *
 * ⚠️ **The walker account is shared with every authed spec**, so both lists are cleared for
 * the fixture subject before and after each test, on the success and failure paths alike.
 */
import { mediaFixtureWork } from "@anthers/db/media-fixture";
import type { Page } from "@playwright/test";
import { API_URL, expect, test, WEB_ORIGIN } from "./fixtures";

/** A fixture Work no sibling spec hides, and whose title nothing else in the stream shares. */
const SUBJECT = mediaFixtureWork("episode");
const FIXTURE_DISPLAY_NAME = "Media Fixture";

test.describe.configure({ mode: "serial" });

/** The subject's own ids, read once: both lists key on them, and cleanup has to name them. */
let ids: { workId: number; creatorId: number } | null = null;

function sessionOf(cookies: { name: string; value: string }[]): string {
	const token = cookies.find((c) => c.name === "session")?.value;
	expect(token, "the authed project should carry a session cookie").toBeTruthy();
	return token as string;
}

async function subjectIds() {
	if (ids) return ids;
	const work = await fetch(`${API_URL}/api/content/works/${SUBJECT.slug}-${SUBJECT.publicId}`).then(
		(r) => r.json(),
	);
	ids = { workId: work.work.id, creatorId: work.work.creatorId };
	return ids;
}

/** Empty both lists of the fixture subject through the real routes. */
async function clearHides(page: Page) {
	try {
		const session = sessionOf(await page.context().cookies());
		const { workId, creatorId } = await subjectIds();
		for (const path of [`works/${workId}`, `creators/${creatorId}`]) {
			await fetch(`${API_URL}/api/accounts/me/hidden/${path}`, {
				method: "DELETE",
				headers: { Origin: WEB_ORIGIN, Cookie: `session=${session}` },
			});
		}
	} catch {
		// A walk that took the page down still starts clean next run: the hide is idempotent
		// and the subject is this spec's own.
	}
}

test.beforeEach(async ({ page }) => {
	await clearHides(page);
});
test.afterEach(async ({ page }) => {
	await clearHides(page);
});

/** The subject's tile, wherever the grid drew it. */
const tile = (page: Page) =>
	page.locator("[data-testid='feed-tile']").filter({ hasText: SUBJECT.title });

/**
 * The stream, narrowed to the subject by the Filter mode's term and drawn from everyone —
 * the walker account's own recipe is My Network, which the media fixture is not in.
 */
const stream = (page: Page) =>
	page.goto(`/discovery?candidates=everyone&window=all&q=${encodeURIComponent(SUBJECT.title)}`);

const settingsCard = (page: Page) =>
	page
		.locator(".card")
		.filter({ has: page.getByRole("heading", { name: "Hidden from Discovery" }) });

test("a Work leaves the stream and waits in the settings list", async ({ page }) => {
	test.setTimeout(90_000);
	await stream(page);
	await expect(tile(page), "the fixture Work should be in Discovery").toBeVisible();

	await tile(page)
		.getByRole("button", { name: `More options for ${SUBJECT.title}` })
		.click();
	await tile(page).getByRole("button", { name: "Don't Show this Work" }).click();

	// The tile leaves on the spot, without waiting for a refetch.
	await expect(tile(page), "a hidden Work should leave the stream").toHaveCount(0);

	await page.goto("/settings?tab=content");
	const listed = settingsCard(page).getByRole("list", { name: "Hidden Works" });
	await expect(listed, "the Work should be named in Hidden Works").toContainText(SUBJECT.title);

	await listed.getByRole("button", { name: "Show again" }).click();
	await expect(settingsCard(page).getByText("You haven't hidden any Works.")).toBeVisible();

	await stream(page);
	await expect(tile(page), "Show again should put the entry back").toBeVisible();
});

test("a creator leaves the stream and waits in her own list", async ({ page }) => {
	test.setTimeout(90_000);
	await stream(page);
	await expect(tile(page)).toBeVisible();

	await tile(page)
		.getByRole("button", { name: `More options for ${SUBJECT.title}` })
		.click();
	await tile(page).getByRole("button", { name: "Don't Show this Creator" }).click();
	await expect(tile(page), "a hidden creator's entry should leave the stream").toHaveCount(0);

	await page.goto("/settings?tab=content");
	const listed = settingsCard(page).getByRole("list", { name: "Hidden Creators" });
	await expect(listed, "the creator should be named in Hidden Creators").toContainText(
		FIXTURE_DISPLAY_NAME,
	);

	// The card's copy is the whole difference between a hide and a block, so it is asserted
	// rather than assumed: a reader who expected a block has to be told what this is.
	await expect(settingsCard(page)).toContainText(/isn't a block/i);

	await listed.getByRole("button", { name: "Show again" }).click();
	await expect(settingsCard(page).getByText("You haven't hidden any creators.")).toBeVisible();

	await stream(page);
	await expect(tile(page), "Show again should put the entry back").toBeVisible();
});
