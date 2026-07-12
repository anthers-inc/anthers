// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Collect real JS failures, ignoring the expected no-backend API noise
// (there's no API behind the static preview the webServer builds).
function trackErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
	page.on("console", (m) => {
		if (m.type() === "error" && !/\/api\/|auth\/me|Failed to load resource/i.test(m.text())) {
			errors.push(`console: ${m.text()}`);
		}
	});
	return errors;
}

test.describe("Resources calculators", () => {
	test("landing lists the calculators and cards navigate", async ({ page }) => {
		const errors = trackErrors(page);
		await page.goto("/resources");
		await expect(page.getByRole("heading", { name: "Tools & calculators" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Video Storage Calculator" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Video Bandwidth Calculator" })).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Creator Monetization Calculator" }),
		).toBeVisible();

		await page.getByRole("heading", { name: "Video Storage Calculator" }).click();
		await expect(page).toHaveURL(/\/resources\/video-storage$/);
		expect(errors).toEqual([]);
	});

	test("video storage: default readout and library scale-out", async ({ page }) => {
		const errors = trackErrors(page);
		await page.goto("/resources/video-storage");
		// Big readout: master + AV1 ladder for 1080p60 H.264 @ $0.02.
		await expect(page.locator("p.text-5xl")).toContainText("$0.212");
		await expect(page.getByText("10.62 GiB", { exact: false }).first()).toBeVisible();
		// 100-hour library scale-out.
		await expect(page.getByText("$21.25", { exact: false }).first()).toBeVisible();
		expect(errors).toEqual([]);
	});

	test("video bandwidth: stream time responds to the delivered tier", async ({ page }) => {
		const errors = trackErrors(page);
		await page.goto("/resources/video-bandwidth");
		const readout = page.locator("p.text-5xl");
		await expect(readout).toHaveText("2h 21m"); // AV1 1080p60 on a 4 GiB allowance
		await page.getByRole("button", { name: "2160p" }).click();
		await expect(readout).toHaveText("45 min"); // same allowance, 4K burns it far faster
		expect(errors).toEqual([]);
	});

	test("creator monetization: V3 model and live slider", async ({ page }) => {
		const errors = trackErrors(page);
		await page.goto("/resources/creator-monetization");
		// Default viewer: 300 GiB usage -> $4.50 Time Pool, Petal badge, zero cut.
		await expect(page.getByText(/300 GiB.*badge Petal/)).toBeVisible();
		// The crux line states the zero-cut split ("...reaches creators...Anthers keeps $0").
		await expect(page.getByText(/reaches creators/)).toBeVisible();
		// Audience builder total.
		await expect(page.getByText("$1,624.00").first()).toBeVisible();

		// Drive the Usage slider to its max: 600 GiB -> $9.00 Time Pool (600 × $0.015).
		// (Badge stays Petal — combined spend is $18 usage + $6 boost = $24, under the
		// $30 Blossom threshold — so we assert on the recomputed Time Pool sub-text.)
		const slider = page.getByRole("slider").first();
		await slider.focus();
		await slider.press("End");
		await expect(page.getByText(/600 GiB.*0\.015/)).toBeVisible();
		expect(errors).toEqual([]);
	});
});
