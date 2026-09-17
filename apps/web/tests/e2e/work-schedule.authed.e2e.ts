// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduling a Work's release from its page, walked in a browser.
 *
 * What this proves is the join a unit test cannot reach: the time typed into the page's
 * datetime input is the instant the server stores, in the creator's own zone, and the Catalog
 * card says so afterwards. The sweep that acts on the time is `work-release-schedule.test.ts`'s
 * subject; no worker runs in a browser session.
 *
 * Runs on `media_fixture`, which nothing else resets and which has payouts set up, since a
 * schedule is refused for a creator who could not release. Serial, because the sweep below is by
 * title prefix.
 */
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const TITLE_PREFIX = "Schedule walk ";
const TITLE = `${TITLE_PREFIX}${Date.now()}`;

let session = "";

interface OwnedWork {
	id: number;
	publicId: number;
	title: string;
	scheduledReleaseAt: string | null;
}

async function ownWorks(): Promise<OwnedWork[]> {
	const res = await fetch(`${API_URL}/api/content/works`, {
		headers: { Cookie: `session=${session}` },
	});
	return ((await res.json()) as { works: OwnedWork[] }).works;
}

async function sweep(): Promise<void> {
	if (!session) return;
	for (const w of (await ownWorks()).filter((w) => w.title.startsWith(TITLE_PREFIX))) {
		await fetch(`${API_URL}/api/content/works/${w.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
}

test.describe.configure({ mode: "serial" });
test.afterAll(sweep);

// ⚠️ **A zone far from UTC, pinned on the browser.** CI runs in UTC, where reading the typed digits
// as UTC and converting them from local time give the same instant — so without this the stored-time
// assertion below could not fail there. The expected instant is computed in the browser too, for the
// same reason.
test.use({ timezoneId: "Pacific/Auckland" });

test("a creator schedules a Work's release from its page", async ({ page, context }) => {
	session = await signInAsMediaFixture(context);
	await sweep();

	const created = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${session}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({ type: "service", title: TITLE, maturity: "general" }),
	});
	const { work } = (await created.json()) as { work: OwnedWork };

	await page.goto(`/studio/works/${work.publicId}/edit`);
	const releaseTime = page.getByLabel("Release time");
	await expect(releaseTime).toBeEnabled();
	await expect(
		page.getByText("Pick a time and save, and it releases then on its own."),
	).toBeVisible();

	// Two days out at 09:00 on the BROWSER's clock. Computed there rather than here: Auckland can
	// already be tomorrow, and "tomorrow at nine" by this machine's clock was once in its past.
	const local = await page.evaluate(() => {
		const d = new Date();
		d.setDate(d.getDate() + 2);
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
	});
	await releaseTime.fill(local);
	await expect(page.getByText(/It releases at this time once it's ready/)).toBeVisible();

	await page.getByRole("button", { name: /save work/i }).click();
	await expect(page).toHaveURL(/\/studio\/catalog$/, { timeout: 15_000 });
	const card = page.locator(".card").filter({ hasText: TITLE });
	await expect(card).toContainText("Releases");
	await expect(card).toContainText("Private");

	// The instant stored is the typed local time, not the same digits read as UTC.
	const expected = await page.evaluate((value) => new Date(value).toISOString(), local);
	const [stored] = (await ownWorks()).filter((w) => w.title === TITLE);
	expect(stored.scheduledReleaseAt && new Date(stored.scheduledReleaseAt).toISOString()).toBe(
		expected,
	);

	// Ticking release now clears the schedule in the form, as the server would.
	await page.goto(`/studio/works/${work.publicId}/edit`);
	await expect(releaseTime).toHaveValue(local);
	await page.getByRole("checkbox", { name: /released to my public catalog/i }).check();
	await expect(page.getByLabel("Release time")).toHaveCount(0);
});
