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
	test("landing groups its resources and cards navigate", async ({ page }) => {
		const errors = trackErrors(page);
		await page.goto("/resources");
		await expect(page.getByRole("heading", { name: "Check our math" })).toBeVisible();

		// The three groups the page is organized into. Section = format, tag = subject;
		// these headings are the structure, so guard them against a silent regression.
		// (<Reveal> only fades content in on scroll, but it animates opacity — which
		// Playwright still counts as visible — so below-fold assertions hold here.)
		await expect(page.getByRole("heading", { name: "How the model works" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Run the numbers yourself" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "How we stack up" })).toBeVisible();

		await expect(page.getByRole("heading", { name: "Video Storage Calculator" })).toBeVisible();
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

	test("creator monetization: support model renders zero-cut", async ({ page }) => {
		const errors = trackErrors(page);
		await page.goto("/resources/creator-monetization");
		// The viewer picks a Badge (how many Seeds they give Anthers, a segmented control —
		// not a GiB slider); creator earnings = a share of the Time Pool by watch-time plus
		// the Seeds given straight to them.
		await expect(page.getByText("Viewer's Badge").first()).toBeVisible();
		// The crux line states the zero-cut split ("...reaches creators (Time Pool + Seeds)...").
		await expect(page.getByText(/reaches creators/)).toBeVisible();
		expect(errors).toEqual([]);
		// TODO(Phase 6): restore a live Badge-pick interaction assertion once the app is run.
	});
});
