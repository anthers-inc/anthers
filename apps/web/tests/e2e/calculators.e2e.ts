// SPDX-License-Identifier: Apache-2.0

import {
	cardFeeDisplay,
	STORAGE_PER_GIB_MONTH,
	thresholdForBadge,
	timePoolFor,
} from "@anthers/shared/constants";
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

		// The groups the page is organized into — one per audience, flagship-led, with the
		// comparisons as the strip both audiences read. These headings are the structure, so
		// guard them against a silent regression.
		// (<Reveal> only fades content in on scroll, but it animates opacity — which
		// Playwright still counts as visible — so below-fold assertions hold here.)
		await expect(page.getByRole("heading", { name: "Follow your own money" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "What working here pays" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "The mechanism, drawn" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "How we stack up" })).toBeVisible();

		// 🚨 **A dangling `/demo-*` card is not visible from this page's other assertions.**
		// Every one of them looks at what rendered; a link nobody clicks renders fine. So the
		// count below is the only thing here that would notice one, and it is cheap enough to
		// keep even though those paths now answer with a 404 rather than a plausible page.
		const demoLinks = await page.locator('a[href*="/demo-"]').count();
		expect(demoLinks, "the resources index links to a retired demo page").toBe(0);

		// Each audience category opens on its flagship card. The creator category's two
		// staging calculators were absorbed by their flagship (2026-10-18) — so a staging
		// link returning is this suite's way of noticing.
		await expect(page.getByRole("link", { name: "Your Media Month" }).first()).toBeVisible();
		await expect(page.getByRole("link", { name: "How the Money Moves" }).first()).toBeVisible();
		await expect(page.getByRole("link", { name: "Your Financials on Anthers" })).toBeVisible();
		const absorbed = await page
			.locator('a[href*="/resources/creator-monetization"], a[href*="/resources/video-storage"]')
			.count();
		expect(absorbed, "the resources index links to a retired staging calculator").toBe(0);

		await page.getByRole("link", { name: "Your Financials on Anthers" }).click();
		await expect(page).toHaveURL(/\/resources\/creator-financials$/);
		expect(errors).toEqual([]);
	});

	// 🚨 **A retired URL is a redirect, not a removal** — both staging calculators were
	// live pages in production with links in circulation. Each must land on the page
	// that absorbed it, else the absorbed URLs render 404s that only a link-walker sees.
	for (const old of ["creator-monetization", "video-storage"]) {
		test(`the retired /resources/${old} lands on the financials flagship`, async ({ page }) => {
			await page.goto(`/resources/${old}`);
			await expect(page).toHaveURL(/\/resources\/creator-financials$/);
			await expect(page.getByRole("heading", { name: "Your Financials on Anthers" })).toBeVisible();
		});
	}

	/**
	 * 🚨 **Every figure on this page is computed — so the test reads the numbers, not
	 * the words.** The predecessor's test once passed through a threefold overstated
	 * page by asking whether the phrase "reaches creators" was visible; the same rule
	 * applies here with more inputs: derive expectations from the constants and the
	 * generated figures the page itself reads, never freeze a rendered dollar.
	 */
	test("creator financials: the supporter math is the model's", async ({ page }) => {
		const errors = trackErrors(page);
		await page.goto("/resources/creator-financials");
		await expect(page.getByText("Your supporters").first()).toBeVisible();

		// The page opens on the default scenario: 250 supporters holding Root, 30-hour
		// months, 4 hours with you, $1 directed each — the readout states the total.
		const count = 250;
		const badge = "root";
		const directed = 1;
		const pool = timePoolFor(thresholdForBadge(badge));
		const share = 4 / 30;
		const tpPer = Math.round(share * pool * 100) / 100;
		// The directed net: whole charge = 3 + 1, fee split pro-rata, directed side nets.
		const charge = thresholdForBadge(badge) + directed;
		const fee = cardFeeDisplay(charge);
		const feeOnDirected = Math.round(((fee * directed) / charge) * 100) / 100;
		const perSupporter = Math.round((tpPer + (directed - feeOnDirected)) * 100) / 100;
		// Plus the sales line the same headline totals: each sale its own charge.
		const sale = Math.round((10 - cardFeeDisplay(10)) * 100) / 100;
		const expectedRevenue = Math.round((perSupporter * count + sale * 40) * 100) / 100;

		// The headline stat is the one the verdict restates — read the number out of the
		// page's own mono rendering and compare it to the model, not the words.
		const headline = page.getByText("Reaches you, monthly").locator("..").locator("p").nth(1);
		const headlineText = (await headline.innerText()).replace(/\s+/g, " ");
		expect(headlineText, "the computed revenue is the model's").toContain(
			`$${expectedRevenue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
		);

		expect(errors).toEqual([]);
	});

	/**
	 * ⚠️ **The storage readout is DERIVED, and its predecessor once froze the rate.**
	 * It asserted `$0.212` and `$21.25`, both computed at `$0.02/GiB` — DigitalOcean
	 * Spaces' rate, eight days stale after storage moved to Cloudflare R2. The lesson
	 * stands here: the test READS the catalog's GiB off the page, derives the expected
	 * top-up from that catalog and the dial the copy quotes, and freezes nothing.
	 */
	test("creator financials: the catalog lands in a rung, bytes past it bill at cost", async ({
		page,
	}) => {
		const errors = trackErrors(page);
		await page.goto("/resources/creator-financials");

		// Read the catalog the page computed (20 source-hours at 1080p60 H.264 + the
		// AV1 ladder, plus 8 GiB of everything else). The value is the card's second
		// paragraph — its `GiB` unit is a span, so `getByText(/GiB/)` would match that
		// alone and parse nothing.
		const catalogCard = page.getByText("Your catalog", { exact: true }).locator("..");
		const catalogText = (await catalogCard.locator("p").nth(1).innerText()).trim();
		const gib = Number(/([\d.]+)\s*GiB/.exec(catalogText)?.[1]);
		expect(gib, "the page renders a catalog size").toBeGreaterThan(200);

		// Past Blossom's 200 GiB, every byte above bills at the at-cost rate the page
		// quotes — the rung card says so, with the derived dollar beside it.
		const topUp = Math.round((gib - 200) * STORAGE_PER_GIB_MONTH * 100) / 100;
		await expect(page.getByText("The Badge that carries it")).toBeVisible();
		await expect(page.getByText("$0.0161", { exact: false }).first()).toBeVisible();
		await expect(page.getByText(`$${topUp.toFixed(2)}`, { exact: false })).toBeVisible();
		expect(errors).toEqual([]);
	});
});
