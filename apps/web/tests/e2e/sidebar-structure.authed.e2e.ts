// SPDX-License-Identifier: Apache-2.0
/**
 * The house sidebar structure (Parker, 2026-10-11): the nav tabs, a divider below
 * them that is PERSISTENT — it stands even where the page registers nothing — then
 * the page's middle section, a second divider, and the tab-shared Type and Tags.
 *
 * Pins in the shape of `sidebar-nav.authed.e2e.ts`: structure and order measured,
 * never a screenshot. The greying half of the shared Type contract (a type absent
 * from a page or excluded by its view) is asserted where the first consumer lands —
 * the Library task's lens section — not here, where no consumer passes the set yet.
 */

import { expect, test } from "@playwright/test";
import { WEB_ORIGIN } from "./fixtures";

test.describe.configure({ mode: "serial" });

/** The sidebar's landmarks — the nav, every divider (deep: the second structural
 *  divider is inside the scroll region), and the section headings — each with a y. */
const sidebarMap = (page: import("@playwright/test").Page) =>
	page.evaluate(() => {
		const column = document.querySelector("aside > div");
		if (!column) return null;
		return [...column.querySelectorAll("nav, div.divider, h3")].map((el) => ({
			tag: el.tagName.toLowerCase(),
			divider: el.classList.contains("divider"),
			text: el.textContent?.trim() ?? "",
			y: el.getBoundingClientRect().y,
		}));
	});

const typeSectionRows = (page: import("@playwright/test").Page) =>
	page.evaluate(() => {
		const sections = [...document.querySelectorAll("aside section")];
		const typeSection = sections.find((s) => s.querySelector("h3")?.textContent === "Type");
		if (!typeSection) return null;
		return [...typeSection.querySelectorAll("button")].map((b) => b.textContent?.trim());
	});

test("the sidebar reads tabs, divider, middle section, divider, shared filters", async ({
	page,
}) => {
	test.setTimeout(60_000);
	await page.goto(`${WEB_ORIGIN}/feed`);
	await expect(
		page.getByRole("navigation", { name: "Anthers" }).getByRole("link", { name: "Feed" }),
	).toBeVisible();

	// The section order on the Feed: Bookmarks (middle content, not a filter), then
	// Access (feed-unique), then the shared Type and Tags — after the second divider.
	expect(await page.getByRole("heading", { name: "Bookmarks", exact: true })).toBeVisible();
	expect(await page.getByRole("heading", { name: "Access", exact: true })).toBeVisible();
	expect(await page.getByRole("heading", { name: "Type", exact: true })).toBeVisible();
	expect(await page.getByRole("heading", { name: "Tags", exact: true })).toBeVisible();
	const headingY = async (name: string) =>
		await page
			.getByRole("heading", { name, exact: true })
			.evaluate((el) => el.getBoundingClientRect().y);
	expect(await headingY("Bookmarks")).toBeLessThan(await headingY("Access"));
	expect(await headingY("Access")).toBeLessThan(await headingY("Type"));
	expect(await headingY("Type")).toBeLessThan(await headingY("Tags"));

	// The map carries the two dividers between the sections: one below the nav
	// (persistent), one between the middle and the shared filters.
	const map = await sidebarMap(page);
	expect(map).not.toBeNull();
	const dividers = map?.filter((d) => d.divider) ?? [];
	expect(dividers.length, "the two structural dividers stand").toBeGreaterThanOrEqual(2);
	const nav = map?.find((d) => d.tag === "nav");
	const bookmarks = map?.find((d) => d.text === "Bookmarks");
	expect(
		nav && dividers[0] && bookmarks && dividers[0].y > nav.y && dividers[0].y < bookmarks.y,
		"the persistent divider sits between the nav and the page's section",
	).toBe(true);

	// The retired name is gone: the shared section's heading is Type, not Work Type.
	expect(await page.getByText("Work Type").count()).toBe(0);
});

test("the shared Type list is the unified vocabulary, greyed rows included", async ({ page }) => {
	test.setTimeout(60_000);
	await page.goto(`${WEB_ORIGIN}/feed`);
	await expect(
		page.getByRole("navigation", { name: "Anthers" }).getByRole("link", { name: "Feed" }),
	).toBeVisible();
	// The shared sections mount in an effect after first paint; wait for the
	// vocabulary rather than racing it.
	await expect(page.getByRole("heading", { name: "Type", exact: true })).toBeVisible();
	// All, then Posts below it, then every Work type in the shared order — the one
	// list every tab's sidebar carries (greyed consumers assert this where they land).
	expect(await typeSectionRows(page)).toEqual([
		"All",
		"Posts",
		"Games",
		"Music",
		"Audio",
		"Video",
		"Writing",
		"Books",
		"Comics",
		"Images",
		"Software",
		"Physical",
		"Services",
	]);
});

test("a Type selection filters the feed through the page's own adapter", async ({ page }) => {
	test.setTimeout(60_000);
	await page.goto(`${WEB_ORIGIN}/feed`);
	await expect(
		page.getByRole("navigation", { name: "Anthers" }).getByRole("link", { name: "Feed" }),
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Type", exact: true })).toBeVisible();

	// Posts is a KIND of feed entry, not a Work type: the shared row's selection
	// translates to the feed route's `kind=posts`, not to `media_type=posts`. The
	// server-side filter semantics are the API suite's; this asserts the ROW drove
	// the right request and the stream that came back obeys the kind.
	const postsFetch = page.waitForResponse(
		(r) =>
			r.url().includes("/api/accounts/me/feed") &&
			new URL(r.url()).searchParams.get("kind") === "posts",
		{ timeout: 10_000 },
	);
	await page.getByRole("button", { name: "Posts", exact: true }).click();
	await expect(page).toHaveURL(/media_type=posts/);
	const postsResponse = await postsFetch;
	expect(postsResponse.status(), "the Posts row's fetch answers").toBe(200);
	const postsBody = (await postsResponse.json()) as { entries?: { kind: string }[] };
	expect(
		postsBody.entries?.every((e) => e.kind === "post") ?? true,
		"nothing but posts comes back for kind=posts",
	).toBe(true);

	// A Work type narrows only the work side, back through `media_type`.
	const gamesFetch = page.waitForResponse(
		(r) =>
			r.url().includes("/api/accounts/me/feed") &&
			new URL(r.url()).searchParams.get("media_type") === "game",
		{ timeout: 10_000 },
	);
	await page.getByRole("button", { name: "Games", exact: true }).click();
	await expect(page).toHaveURL(/media_type=game/);
	const gamesResponse = await gamesFetch;
	expect(gamesResponse.status(), "the Games row's fetch answers").toBe(200);
	const gamesBody = (await gamesResponse.json()) as {
		entries?: { kind: string; work?: { type?: string } | null }[];
	};
	expect(
		gamesBody.entries?.every(
			(e) => e.kind === "release" || e.work?.type === "game" || e.work?.type == null,
		) ?? true,
		"work entries are games; posts survive a type filter through what they announce",
	).toBe(true);
});

test("the divider below the nav is persistent on a page that registers nothing yet", async ({
	page,
}) => {
	// The Library's sidebar migration is its own task; before it, its sidebar still
	// stands the persistent divider — the structure never depends on the page.
	await page.goto(`${WEB_ORIGIN}/library`);
	await expect(
		page.getByRole("navigation", { name: "Anthers" }).getByRole("link", { name: "Library" }),
	).toBeVisible();
	const map = await sidebarMap(page);
	const nav = map?.find((d) => d.tag === "nav");
	const anyDivider = map?.some((d) => d.divider && d.y > (nav?.y ?? 0));
	expect(anyDivider, "the divider stands below the nav").toBe(true);
});
