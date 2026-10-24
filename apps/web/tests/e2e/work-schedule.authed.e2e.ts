// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduling a Work's release from its page, walked in a browser.
 *
 * What this proves is the join a unit test cannot reach: the time typed into the page's
 * datetime input is the instant the server stores, in the creator's own zone, and the
 * Works table says so afterwards. The sweep that acts on the time is `work-release-schedule.test.ts`'s
 * subject; no worker runs in a browser session.
 *
 * Runs on `media_fixture`, which nothing else resets and which has payouts set up, since a
 * schedule is refused for a creator who could not release. Serial, because the sweep below is by
 * title prefix.
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

const TITLE_PREFIX = "Schedule walk ";
const TITLE = `${TITLE_PREFIX}${Date.now()}`;

let session = "";

interface OwnedWork {
	id: number;
	publicId: number;
	title: string;
	visibility: string;
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
		body: JSON.stringify({
			type: "service",
			title: TITLE,
			maturityRows: rowsRatedAs("general"),
			// Scheduling and the final release both ask for a human in the credits
			// (`credits_creator_required`); the schedule below would be refused without it.
			credits: CREATED_CREDIT,
		}),
	});
	const { work } = (await created.json()) as { work: OwnedWork };

	await page.goto(`/studio/works/${work.publicId}/edit`);
	// The schedule lives in the Release field's edit state, on the Work's page (the
	// kinds pass, 2026-10-14) — one date field and its Now shortcut, saved alone.
	await page.getByRole("button", { name: "Edit Release" }).click();
	const releaseAt = page.getByLabel("Anthers Release Date");
	await expect(releaseAt).toBeEnabled();
	await expect(releaseAt).toHaveValue("");

	// Two days out at 09:00 on the BROWSER's clock. Computed there rather than here: Auckland can
	// already be tomorrow, and "tomorrow at nine" by this machine's clock was once in its past.
	const local = await page.evaluate(() => {
		const d = new Date();
		d.setDate(d.getDate() + 2);
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
	});
	await releaseAt.fill(local);

	await page.getByRole("button", { name: "Save Release" }).click();
	// Saving keeps the creator on the Work's page, looking at the result.
	await expect(page.getByText(/scheduled for/i)).toBeVisible({ timeout: 15_000 });
	await page.goto("/studio/works");
	const row = page.locator("tbody tr").filter({ hasText: TITLE });
	// The Release Date cell names the schedule itself, the words the Work's page uses.
	await expect(row).toContainText(/scheduled for/i);
	await expect(row).toContainText("Private");

	// The instant stored is the typed local time, not the same digits read as UTC.
	const expected = await page.evaluate((value) => new Date(value).toISOString(), local);
	const [stored] = (await ownWorks()).filter((w) => w.title === TITLE);
	expect(stored.scheduledReleaseAt && new Date(stored.scheduledReleaseAt).toISOString()).toBe(
		expected,
	);

	// Now replaces the schedule with the release-now act, as the server would.
	await page.goto(`/studio/works/${work.publicId}/edit`);
	await page.getByRole("button", { name: "Edit Release" }).click();
	await expect(releaseAt).toHaveValue(local);
	await page.getByRole("button", { name: "Now", exact: true }).click();
	await expect(releaseAt).not.toHaveValue(local);
	await page.getByRole("button", { name: "Save Release" }).click();
	await expect(page.getByText(/scheduled for/i)).toHaveCount(0, { timeout: 15_000 });
	// A time the field holds that has already passed is the release act, not a schedule:
	// the row is out, and its schedule is gone.
	await expect
		.poll(
			async () => {
				const [row] = (await ownWorks()).filter((w) => w.title === TITLE);
				return row ? `${row.visibility}:${row.scheduledReleaseAt}` : "gone";
			},
			{ message: "the Now save never released the row" },
		)
		.toBe("released:null");
});
