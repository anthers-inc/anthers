// SPDX-License-Identifier: Apache-2.0
/**
 * The activity history the Privacy Policy points at.
 *
 * Ranges carry more than the old durations did — the record is now the person's
 * own inspectable history, and the Policy's *What you view, and for how long* says
 * so and links to settings. The promise exists only if the page does: a route test
 * on `/api/subscriptions/attention/history` cannot see whether a settings section
 * renders it, so this is an `.authed` browser spec.
 *
 * The gauntlet viewer holds no attention rows by default, so the empty state is
 * what the page can honestly be asserted on here. (A range-bearing fixture would
 * be consumed by the meter rungs' own `--watched-minutes` bookkeeping; the row
 * itself is asserted end-to-end in the API suites.)
 */
import { expect, test } from "@playwright/test";

test("a person can read their own activity record in settings", async ({ page }) => {
	await page.goto("/settings");

	await expect(
		page.getByRole("heading", { name: /your activity history/i }),
		"the record the Privacy Policy says is readable is not there",
	).toBeVisible();

	// The section says what it is — the stored record the export carries and the
	// Time Pool divides by — rather than presenting as a bare list.
	await expect(page.getByText(/exactly as it is stored/i)).toBeVisible();

	// The gauntlet viewer has no attention rows, so the honest state is the empty one:
	// a page that renders "Nothing recorded yet" until watching has happened is still
	// the promise kept — the record exists, and it is zero rows long.
	await expect(page.getByText(/nothing recorded yet/i)).toBeVisible();
});
