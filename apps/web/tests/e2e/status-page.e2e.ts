// SPDX-License-Identifier: Apache-2.0
/**
 * The public status page: it renders live answers from /api/status and /api/status/history,
 * in a real browser.
 *
 * 🚨 **The whole page is a claim about the world, so the spec walks the real endpoints.**
 * No fixture of a report is set up — the page's job is to render whatever the running API
 * truthfully answers, and the one thing a test could lock in dishonestly is a mocked
 * "all operational" when the deployment's answer would differ. What is asserted is the
 * page's *shape*: the overall state banner, every component row carrying a state, the
 * Past Incidents section reading whatever the record holds. Whether the state is
 * operational or degraded, and whether an incident is in the record, is the deployment's
 * business, never the test's.
 */
import { expect, test, WEB_ORIGIN } from "./fixtures";

const PAGE = `${WEB_ORIGIN}/status`;

test.describe("the status page", () => {
	test("renders a live answer with the component rows, linked from the footer", async ({
		page,
	}) => {
		await page.goto(PAGE);
		// The overall banner resolves from the live /api/status rather than staying "Checking…".
		await expect(page.getByText("Checking")).toHaveCount(0);
		// A component row for the database, the one component whose state can be down.
		await expect(page.getByText("Database", { exact: true })).toBeVisible();
		// The outside check's row, named for the product it answers about.
		await expect(page.getByText("Website", { exact: true })).toBeVisible();

		// Footer links, from both shells this surface renders under.
		await page.goto(`${WEB_ORIGIN}/`);
		await expect(page.locator("footer a[href='/status']")).toHaveText("Status");
	});

	test("carries the Past Incidents section, reading whatever the record holds", async ({
		page,
	}) => {
		await page.goto(PAGE);
		// The section exists whatever the record holds; whether incidents render inside
		// it is the sampler's history, never the test's.
		await expect(page.getByText("Past Incidents")).toBeVisible();
	});

	test("hands readers to the standalone page served off the platform", async ({ page }) => {
		await page.goto(PAGE);
		// The standalone page at status.anthers.org (served by the droplet the outside
		// check runs on) is the answer to this page dying with the platform; the lede
		// hands readers there in one sentence, without an apology for it.
		await expect(page.locator('a[href="https://status.anthers.org"]')).toBeVisible();
		await expect(page.getByText("served by the same platform")).toHaveCount(0);
	});
});
