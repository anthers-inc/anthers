// SPDX-License-Identifier: Apache-2.0
/**
 * Collapsing the sidebar on a desktop leaves an icon RAIL beside the page (Parker,
 * 2026-10-19), rather than the width-0 drawer a phone still gets.
 *
 * `sidebar-phone.authed.e2e.ts` pins the phone half — closed is 0 there, and opening it
 * lays it over the page — so this spec pins the desktop half: the aside keeps 4rem, the
 * nav's icons stay reachable, their labels survive as accessible names and hover titles,
 * and the expanded column comes back intact. The last test covers Studio mode, whose nav
 * is a separate map and would otherwise be the one branch a rail change could miss.
 *
 * The sidebar's own key is pinned in `search-bar.authed.e2e.ts`, which owns the one spec
 * file that touches the account's shortcut map; this spec covers the rail's mechanics
 * through the toggle button, so no chord read here can race a rebind there.
 */
import { expect, type Page, test } from "@playwright/test";
import { signInAsCreator, WEB_ORIGIN } from "./fixtures";

const DESKTOP = { width: 1280, height: 800 };

const toggle = (page: Page) => page.getByRole("button", { name: "Toggle sidebar" });

/** The aside's width, where `<main>` starts, and what each nav row actually draws. */
async function railState(page: Page) {
	return page.evaluate(() => {
		const aside = document.querySelector("aside")?.getBoundingClientRect();
		const main = document.querySelector("main")?.getBoundingClientRect();
		const nav = document.querySelector("nav[aria-label='Anthers'], nav[aria-label='Studio']");
		const rows = [...(nav?.querySelectorAll("a") ?? [])].map((a) => {
			// The row's leading glyph — an `svg` for a place, the creator's thumbnail for the
			// profile tab. It is the first child in either case.
			const icon = a.firstElementChild?.getBoundingClientRect();
			// The expanded column keeps the label as a bare text node; the rail swaps it
			// for an `sr-only` span, which is a 1px box rather than a drawn label.
			const text = [...a.childNodes].find(
				(node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0,
			);
			const hidden = [...a.querySelectorAll("span.sr-only")].find(
				(span) => (span.textContent ?? "").trim().length > 0,
			);
			let labelWidth = -1;
			if (text) {
				const range = document.createRange();
				range.selectNode(text);
				labelWidth = Math.round(range.getBoundingClientRect().width);
			} else if (hidden) {
				labelWidth = Math.round(hidden.getBoundingClientRect().width);
			}
			return {
				// The row's leading glyph is excluded: it is an icon, or the creator's initial
				// when they have no thumbnail, and neither is part of the row's name.
				name: (a.textContent ?? "").slice(a.firstElementChild?.textContent?.length ?? 0).trim(),
				href: a.getAttribute("href"),
				iconX: icon ? Math.round(icon.x) : -1,
				iconRight: icon ? Math.round(icon.right) : -1,
				labelWidth,
				title: a.getAttribute("title"),
			};
		});
		return {
			asideLeft: Math.round(aside?.x ?? -1),
			asideWidth: Math.round(aside?.width ?? -1),
			mainLeft: Math.round(main?.left ?? -1),
			rows,
			grips: document.querySelectorAll("span[title='Drag to reorder']").length,
		};
	});
}

test.describe("on a desktop", () => {
	test.use({ viewport: DESKTOP });

	test("collapsing leaves the nav's icons in a rail beside the page", async ({ page }) => {
		test.setTimeout(60_000);
		await page.goto(`${WEB_ORIGIN}/discovery`);
		await expect(toggle(page)).toBeVisible();
		await expect.poll(async () => (await railState(page)).asideWidth).toBe(256);

		await toggle(page).click();
		await expect
			.poll(async () => (await railState(page)).asideWidth, {
				message: "the collapsed sidebar did not settle at the rail's width",
			})
			.toBe(64);

		const rail = await railState(page);
		expect(rail.mainLeft, "the rail still sits beside the page").toBe(64);
		expect(rail.rows.map((row) => row.name)).toEqual(["Library", "Discovery", "Settings"]);
		expect(rail.grips, "the nav carries no drag grips").toBe(0);
		for (const row of rail.rows) {
			expect(row.title, `${row.name} keeps a hover label`).toBeTruthy();
			expect(row.name.startsWith(row.title ?? ""), `${row.name}'s label names it`).toBe(true);
			expect(row.labelWidth, `${row.name}'s label is not drawn`).toBeLessThanOrEqual(1);
			expect(
				row.iconX >= rail.asideLeft && row.iconRight <= rail.asideLeft + rail.asideWidth,
				`${row.name}'s icon is inside the rail`,
			).toBe(true);
		}

		// A rail icon is still a link with a name, not a decorative glyph.
		await expect(
			page.getByRole("navigation", { name: "Anthers" }).getByRole("link", { name: "Discovery" }),
		).toBeVisible();
	});

	test("opening it again restores the labels", async ({ page }) => {
		test.setTimeout(60_000);
		await page.goto(`${WEB_ORIGIN}/discovery`);
		await expect(toggle(page)).toBeVisible();
		await expect.poll(async () => (await railState(page)).asideWidth).toBe(256);

		await toggle(page).click();
		await expect.poll(async () => (await railState(page)).asideWidth).toBe(64);
		await toggle(page).click();
		await expect.poll(async () => (await railState(page)).asideWidth).toBe(256);

		const expanded = await railState(page);
		expect(expanded.mainLeft, "the expanded column sits beside the page").toBe(256);
		// The grips went with drag-to-reorder (2026-10-20); the order is the site's now.
		expect(expanded.grips, "the nav carries no drag grips").toBe(0);
		for (const row of expanded.rows) {
			expect(row.title, `${row.name} drops its rail-only hover label`).toBeNull();
			expect(row.labelWidth, `${row.name}'s label is drawn again`).toBeGreaterThan(1);
		}
	});

	test("Studio mode's nav collapses to its own icons", async ({ page, context }) => {
		test.setTimeout(60_000);
		// The authed walker is not a creator, so the Studio's gate would bounce this walk
		// to /settings. The creator sign-in lands in this test's own context only.
		await signInAsCreator(context);
		await page.goto(`${WEB_ORIGIN}/studio`);
		const studioNav = page.getByRole("navigation", { name: "Studio", exact: true });
		await expect(studioNav).toBeVisible();
		await expect.poll(async () => (await railState(page)).asideWidth).toBe(256);

		const expandedRows = (await railState(page)).rows.map((row) => row.href);
		await toggle(page).click();
		await expect.poll(async () => (await railState(page)).asideWidth).toBe(64);

		const rail = await railState(page);
		// Hrefs rather than names: the profile row's text is a name and a handle on two lines,
		// and the rail keeps only the name as its accessible label.
		expect(rail.rows.map((row) => row.href)).toEqual(expandedRows);
		for (const row of rail.rows) {
			expect(row.title, `${row.name} keeps a hover label`).toBeTruthy();
			expect(row.name.startsWith(row.title ?? ""), `${row.name}'s label names it`).toBe(true);
			expect(row.labelWidth, `${row.name}'s label is not drawn`).toBeLessThanOrEqual(1);
			expect(
				row.iconX >= rail.asideLeft && row.iconRight <= rail.asideLeft + rail.asideWidth,
				`${row.name}'s icon is inside the rail`,
			).toBe(true);
		}

		// The mode switch moved to the header on 2026-10-23, so the rail no longer takes it
		// with the sidebar's words — it stands outside the aside and stays put either way.
		const switchInHeader = await page.evaluate(() => {
			const nav = document.querySelector("header nav[aria-label='User or Creator']");
			const aside = document.querySelector("aside");
			return nav != null && aside != null && !aside.contains(nav);
		});
		expect(switchInHeader, "the mode switch lives in the header, not the sidebar").toBe(true);
		await toggle(page).click();
		await expect
			.poll(async () => (await railState(page)).asideWidth, {
				message: "the expanded column is back",
			})
			.toBe(256);
	});
});
