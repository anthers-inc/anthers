// SPDX-License-Identifier: Apache-2.0
/**
 * The sidebar nav's own contract — the Library / Network / Discovery rows and the Settings row
 * beneath them, their one fixed order, and the account setting that decides which of the three
 * tabs a session opens on.
 *
 * 🚨 **Two of these assertions exist because a regression shipped through them.** #437
 * introduced grips and a wrapper row, and in doing so interpolated the NavLink's
 * className *function* into a template string — the function's source landed in the
 * class attribute as a string, no styles applied, and the items rendered as unstyled
 * stacks of icon-over-label. The same PR gave the grip its drag handlers but no
 * `draggable` attribute, so a grip drag started a text selection instead of an HTML5
 * drag. That whole mechanism is gone now (2026-10-20): the order is fixed, and the
 * starting tab is `homeDefaultTab` on the account. The styling assertions stay because
 * the breakage they caught was in the row's shape, not in the drag.
 *
 * ⚠️ **The second test writes the shared gauntlet walker's starting tab** — the account
 * every authed spec shares. It puts Network back the moment it finishes asserting, and
 * the `afterAll` repeats that on the failure path. The one route another spec reads is
 * `/` (video-player's `goto("/")`), which navigates on to a `/works/…` slug regardless of
 * where the redirect lands it.
 */
import { expect, test } from "@playwright/test";
import { API_URL, WEB_ORIGIN } from "./fixtures";

const ROWS = "nav[aria-label='Anthers'] > a";

/** The nav labels, in the order they render. Settings joined below the three tabs on 2026-10-23. */
const labels = (page: import("@playwright/test").Page) =>
	page.evaluate(
		(sel: string) => [...document.querySelectorAll(sel)].map((a) => a.textContent?.trim()),
		ROWS,
	);

const ORDER = ["Library", "Network", "Discovery", "Settings"];

/** The PATCH the settings card fires when a tab radio is chosen. */
const chooseTab = async (
	page: import("@playwright/test").Page,
	label: "Library" | "Network" | "Discovery",
) => {
	const patch = page.waitForResponse(
		(r) => r.url().includes("/api/accounts/me") && r.request().method() === "PATCH",
		{ timeout: 10_000 },
	);
	const radio = page.getByRole("radio", { name: new RegExp(`^${label}`) });
	// `click()` rather than `check()`: the radio is controlled by the account payload, so its
	// checked state only flips once the write lands and the session refreshes. `check()`
	// asserts the state immediately and would call a correct write a failure.
	await radio.click();
	const response = await patch;
	expect(response.status(), `saving the ${label} starting tab`).toBe(200);
	expect(
		(await response.request().postDataJSON())?.homeDefaultTab,
		"the write carries the chosen tab",
	).toBe(label.toLowerCase());
	await expect(radio).toBeChecked();
};

test.describe.configure({ mode: "serial" });

test("the nav items read as rows — icon beside label at the nav's small size", async ({ page }) => {
	test.setTimeout(60_000);
	await page.goto(`${WEB_ORIGIN}/network`);
	const nav = page.getByRole("navigation", { name: "Anthers" });
	const link = nav.getByRole("link", { name: "Network" });
	await expect(link).toBeVisible();
	expect(await labels(page)).toEqual(ORDER);

	// The item carries its real classes (the regression shipped a function's source
	// as the className — nothing applied, and the row collapsed into stacked text).
	const cls = await link.getAttribute("class");
	expect(cls).toContain("text-sm");
	expect(cls).toContain("flex");

	// The icon sits beside the label, not above it, at the nav's 14px — the broken
	// sidebar had the icon above a full-size label.
	const icon = await link.locator("svg").boundingBox();
	const label = await link.evaluate((el) => {
		const node = [...el.childNodes].find(
			(n) => n.nodeType === Node.TEXT_NODE && (n.textContent?.trim().length ?? 0) > 0,
		);
		if (!node) return null;
		const range = document.createRange();
		range.selectNode(node);
		const rect = range.getBoundingClientRect();
		return { x: rect.x, y: rect.y };
	});
	expect(icon, "the item's icon renders").not.toBeNull();
	expect(label, "the item's label text renders").not.toBeNull();
	expect(await link.evaluate((el) => getComputedStyle(el).fontSize)).toBe("14px");
	expect(
		icon && label && label.y < icon.y + icon.height,
		"the label sits beside the icon, not under it",
	).toBe(true);
	expect(icon && label && label.x > icon.x, "the label is to the icon's right").toBe(true);

	// Nothing in the row is draggable: the order is the site's, not the account's.
	expect(
		await nav.locator("span[title='Drag to reorder']").count(),
		"the nav offers no reorder grip",
	).toBe(0);
	expect(await nav.locator("[draggable='true']").count()).toBe(0);

	// The row spans the sidebar's width rather than hugging its label; the aside opens
	// on a 200ms width transition, so measure only after the box has finished.
	const navEl = page.locator("nav[aria-label='Anthers']");
	await expect
		.poll(
			() =>
				navEl.evaluate((el) =>
					Math.round((el.closest("aside") as HTMLElement).getBoundingClientRect().width),
				),
			{ timeout: 2_000 },
		)
		.toBe(256);
	const asideBox = await navEl.evaluate((el) =>
		(el.closest("aside") as HTMLElement).getBoundingClientRect(),
	);
	for (const name of ORDER) {
		const row = nav.getByRole("link", { name });
		const rowBox = await row.boundingBox();
		expect(rowBox, `the ${name} row renders`).not.toBeNull();
		if (rowBox) {
			expect(rowBox.x + rowBox.width, "the row is not clipped by the sidebar").toBeLessThanOrEqual(
				asideBox.x + asideBox.width,
			);
		}
	}
});

test("the account's starting tab decides where / lands, and the order never moves", async ({
	page,
}) => {
	test.setTimeout(60_000);
	await page.goto(`${WEB_ORIGIN}/network`);
	await expect(
		page.getByRole("navigation", { name: "Anthers" }).getByRole("link", { name: "Network" }),
	).toBeVisible();

	// Choosing a tab in Settings is the only control, and it takes effect on the next
	// visit to `/` without a fresh sign-in.
	await page.goto(`${WEB_ORIGIN}/settings?tab=account`);
	await expect(page.getByRole("heading", { name: "Where You Start" })).toBeVisible();
	await chooseTab(page, "Library");

	await page.goto(`${WEB_ORIGIN}/`);
	await expect(page).toHaveURL(/\/library$/);
	await expect
		.poll(() => labels(page), { message: "the sidebar keeps its fixed order" })
		.toEqual(ORDER);

	// Back at the default: Network is where a session lands when nothing else is chosen.
	await page.goto(`${WEB_ORIGIN}/settings?tab=account`);
	await chooseTab(page, "Network");
	await page.goto(`${WEB_ORIGIN}/`);
	await expect(page).toHaveURL(/\/network$/);
	await expect
		.poll(() => labels(page), { message: "choosing a tab never rearranges the nav" })
		.toEqual(ORDER);

	// The walker is the shared account: put the default starting tab back before anything
	// else reads it (belt-and-braces afterAll below catches a mid-test failure).
	await page.request.patch(`${API_URL}/api/accounts/me`, {
		headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN },
		data: { homeDefaultTab: "network" },
	});
});

test.afterAll(async ({ browser }) => {
	// The restore above runs only if the second test reaches its end; this is the same
	// patch on the failure path. The context carries the walker's own session cookie
	// (the storage state the setup project writes) so the write authenticates.
	const context = await browser.newContext({
		storageState: "tests/e2e/.auth/gauntlet-walker.json",
	});
	const res = await context.request
		.patch(`${API_URL}/api/accounts/me`, {
			headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN },
			data: { homeDefaultTab: "network" },
			failOnStatusCode: false,
		})
		.catch(() => null);
	if (!res || (res && res.status() !== 200)) {
		console.warn(
			"the starting-tab restore did not land — a next run's fixture reset is the backstop",
		);
	}
	await context.close();
});
