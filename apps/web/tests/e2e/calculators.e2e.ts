// SPDX-License-Identifier: AGPL-3.0-or-later

import { STORAGE_PER_GIB_MONTH, thresholdForBadge, timePoolFor } from "@anthers/shared/constants";
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

		// The groups the page is organized into. Section = format, tag = subject; these
		// headings are the structure, so guard them against a silent regression.
		// (<Reveal> only fades content in on scroll, but it animates opacity — which
		// Playwright still counts as visible — so below-fold assertions hold here.)
		//
		// ⚠️ A third group, "How the model works", led this page until 2026-08-30; it held
		// the `/demo-*` explainers and went with them.
		await expect(page.getByRole("heading", { name: "Run the numbers yourself" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "How we stack up" })).toBeVisible();

		// 🚨 **A link to a deleted `/demo-*` page would not look broken.** `App.tsx` ends in
		// a `/:username` catch-all, so those paths now fall through to a profile lookup
		// rather than to anything that announces itself as missing — and the handles stay
		// reserved, so the lookup renders "not found" instead of erroring. A dangling card
		// would therefore navigate, render, and pass every other assertion on this page.
		// This is the only thing that would say so.
		const demoLinks = await page.locator('a[href*="/demo-"]').count();
		expect(demoLinks, "the resources index links to a retired demo page").toBe(0);

		await expect(page.getByRole("heading", { name: "Video Storage Calculator" })).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Creator Monetization Calculator" }),
		).toBeVisible();

		await page.getByRole("heading", { name: "Video Storage Calculator" }).click();
		await expect(page).toHaveURL(/\/resources\/video-storage$/);
		expect(errors).toEqual([]);
	});

	/**
	 * ⚠️ **The money here is DERIVED, and it used to be frozen.** It asserted `$0.212` and
	 * `$21.25`, both computed at `$0.02/GiB` — DigitalOcean Spaces' rate, which the page
	 * defaulted to for eight days after storage moved to Cloudflare R2. The test agreed
	 * with the page because both had the same wrong number in them, which is the failure
	 * mode the sibling test below was written to end. The **sizes** stay frozen: they are
	 * geometry off the bitrate ladder and owe nothing to a dial.
	 */
	test("video storage: default readout and library scale-out", async ({ page }) => {
		const errors = trackErrors(page);
		await page.goto("/resources/video-storage");
		// 1080p60, H.264 master + AV1 ladder — a fixed 10.62 GiB/hr.
		const gibPerHour = 10.62;
		const hourly = gibPerHour * STORAGE_PER_GIB_MONTH;
		await expect(page.locator("p.text-5xl")).toContainText(`$${hourly.toFixed(3)}`);
		await expect(page.getByText("10.62 GiB", { exact: false }).first()).toBeVisible();
		// 100-hour library scale-out, at the same rate the page reads.
		const library = gibPerHour * 100 * STORAGE_PER_GIB_MONTH;
		await expect(
			page
				.getByText(
					`$${library.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
					{ exact: false },
				)
				.first(),
		).toBeVisible();
		expect(errors).toEqual([]);
	});

	/**
	 * 🚨 **This asserted only that the phrase was VISIBLE, and that is how the page came to
	 * overstate creator revenue threefold for a fortnight.** When the Seed retired,
	 * `thresholdForBadge` began returning dollars while the page still multiplied by $3, so
	 * a Sprout viewer was modeled as directing $18 rather than $6 — and a test asking
	 * "does the string `reaches creators` appear" passed every run.
	 *
	 * Every figure on this page is computed, so the typed-figure scan has nothing to look
	 * at either. That leaves this test as the only thing standing between the model and the
	 * page, which is why it now reads the numbers instead of the words.
	 *
	 * The expected values are derived from the same constants the page reads, so this pins
	 * the *relationship* and moves with the dials rather than freezing a figure.
	 */
	test("creator monetization: the split is the model's, not a multiple of it", async ({ page }) => {
		const errors = trackErrors(page);
		await page.goto("/resources/creator-monetization");
		await expect(page.getByText("Viewer's Badge").first()).toBeVisible();

		const summary = page.getByText(/reaches creators/).first();
		await expect(summary).toBeVisible();
		const text = (await summary.innerText()).replace(/\s+/g, " ");

		// The page opens on Sprout. Both figures come from the constants, not from here.
		const sprout = thresholdForBadge("sprout");
		const usd = (n: number) => `$${n.toFixed(2)}`;

		expect(text, "the amount given to Anthers").toContain(usd(sprout));
		expect(text, "the Time Pool it funds").toContain(usd(timePoolFor(sprout)));
		// The directed figure is the Badge's own amount. Under the retirement bug it was
		// that amount × the Public Access price, which is the assertion that would have
		// caught it — and nothing else on the page would have.
		expect(text, "what the viewer directs, NOT a multiple of it").toContain(usd(sprout));
		expect(text, "reaches creators = Time Pool + directed").toContain(
			usd(timePoolFor(sprout) + sprout),
		);

		expect(errors).toEqual([]);
	});
});
