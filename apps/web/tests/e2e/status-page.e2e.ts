// SPDX-License-Identifier: Apache-2.0
/**
 * The public status page: it renders a live answer from /api/status, in a real browser.
 *
 * 🚨 **The whole page is a claim about the world, so the spec walks the real endpoint.**
 * No fixture of a report is set up — the page's job is to render whatever the running API
 * truthfully answers, and the one thing a test could lock in dishonestly is a mocked
 * "all operational" when the deployment's answer would differ. What is asserted is the
 * page's *shape*: the state headline renders for some state, every component row carries
 * a state label, and the outside view's row says where its answer came from. Whether the
 * state is operatonal or degraded is the deployment's business, never the test's.
 */
import { expect, test, WEB_ORIGIN } from "./fixtures";

const PAGE = `${WEB_ORIGIN}/status`;

test.describe("the status page", () => {
	test("renders a live answer with the component rows, linked from the footer", async ({
		page,
	}) => {
		await page.goto(PAGE);
		// The headline resolves from the live /api/status rather than staying "Checking…".
		await expect(page.locator("h1").first()).not.toContainText("Checking");
		// The outside view's row, the page's one row that answers from beyond the platform.
		await expect(page.getByText("Checked from outside")).toBeVisible();
		// A component row for the database, the one component whose state can be down.
		await expect(page.getByText("Database", { exact: true })).toBeVisible();

		// Footer links, from both shells this surface renders under.
		await page.goto(`${WEB_ORIGIN}/`);
		await expect(page.locator("footer a[href='/status']")).toHaveText("Status");
	});

	test("hands readers to the standalone page served off the platform", async ({ page }) => {
		await page.goto(PAGE);
		// The old sentence apologized for this page dying with the platform; the standalone
		// page at status.anthers.org (served by the droplet the outside check runs on) is
		// the answer to it, and the lede now hands readers there.
		await expect(page.locator('a[href="https://status.anthers.org"]')).toBeVisible();
		await expect(page.getByText("served by the same platform")).toHaveCount(0);
	});
});
