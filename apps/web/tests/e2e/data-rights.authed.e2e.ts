// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The two controls the privacy policy says you have.
 *
 * 🚨 **This spec exists because both were claimed for months and neither existed.** The
 * API routes shipped in PR #193 — `GET /me/export`, `GET /me/deletion`, `DELETE /me`,
 * `POST /me/deletion/cancel` — and **nothing in the front end ever called any of them**,
 * while Privacy Policy said *"downloading your data and deleting your account both happen
 * immediately in your settings"* and `/parents` told parents the same. A promise with no
 * mechanism, invisible because the routes existed and passed their own tests.
 *
 * So what is asserted here is the thing that was missing: **that a person can reach them**.
 * Route tests cannot see this gap — they were green throughout — and neither can a
 * signed-out page check, because every route on this app renders the same marketing page
 * when logged out, so those assertions pass whether or not the UI exists. That is why this
 * is an `.authed` spec.
 *
 * ⚠️ **Nothing here actually deletes an account.** The gauntlet viewer is shared fixture
 * state that later rungs depend on, and a spec that consumed it would break them in a way
 * that looks like an unrelated failure. It asserts as far as the confirmation — which is
 * also the part that was missing, since the counts are the whole substance of informed
 * consent — and stops.
 */
import { expect, test } from "@playwright/test";

test("a person can download their data from settings", async ({ page }) => {
	await page.goto("/settings");

	const button = page.getByRole("button", { name: /download my data/i });
	await expect(button, "no export control on the settings page").toBeVisible();

	// Assert the FILE, not the click. The claim is that you get a copy of your data —
	// a button that appears and downloads nothing would satisfy a weaker assertion while
	// leaving the promise exactly as broken as it was.
	const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
	expect(download.suggestedFilename()).toMatch(/^anthers-export-\d{4}-\d{2}-\d{2}\.json$/);
});

test("deletion states what it will do, in real counts, before it does it", async ({ page }) => {
	await page.goto("/settings");

	await page.getByRole("button", { name: /^delete my account$/i }).click();

	// Parker's ruling (2026-08-07): the safety lives in informed consent plus an oops
	// window, not in the foreign keys. "Your content will be deleted" is a sentence people
	// click past — so the confirmation has to carry this account's real per-table outcomes,
	// and they are not uniform: destroyed, tombstoned, anonymised, and kept-with-you-detached
	// are four different fates and the UI may not flatten them into one number.
	const panel = page.locator("text=Here is exactly what happens to this account").locator("..");
	await expect(panel).toBeVisible();
	await expect(panel).toContainText(/Deleted:/);
	await expect(panel).toContainText(/Kept, with your name removed:/);
	await expect(panel).toContainText(/Your Works:/);
	await expect(panel).toContainText(/Kept without you attached:/);

	// The grace window is stated at the point of decision rather than only in the policy.
	await expect(panel).toContainText(/signing back in during that week cancels it/i);

	// And backing out is available and harmless. Deliberately the last action, so this spec
	// leaves the fixture exactly as it found it.
	await page.getByRole("button", { name: /keep my account/i }).click();
	await expect(panel).not.toBeVisible();
});
