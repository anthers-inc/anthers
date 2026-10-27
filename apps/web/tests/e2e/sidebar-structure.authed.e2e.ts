// SPDX-License-Identifier: Apache-2.0
/**
 * The house sidebar structure (Parker, 2026-10-11): the nav tabs, a divider below
 * them that is PERSISTENT — it stands even where the page registers nothing — then
 * the tab-shared Lenses, a second divider, and the shared filters (Access where the
 * tab consumes it, Type, Tags).
 *
 * Pins in the shape of `sidebar-nav.authed.e2e.ts`: structure and order measured,
 * never a screenshot. Discovery also carries a consumer of the Type gray-out (its
 * lenses), which this spec exercises through the lens rows themselves; the Library's
 * own lens spec pins that tab's copy.
 */

import { expect, test } from "@playwright/test";
import { WEB_ORIGIN } from "./fixtures";

/**
 * Discovery under My Network, named in the URL rather than inherited.
 *
 * 🚨 **A bare `/discovery` opens on the account's last-chosen recipe**, and the walker is one
 * account shared with every authed spec, including the one that walks the recipe chips. A run
 * where that spec had left another recipe selected drew a stream this page had to render
 * around, and the structure this file pins belongs to the tab, not to the recipe. Naming the
 * recipe keeps the sidebar's shape the subject.
 */
const DISCOVERY = `${WEB_ORIGIN}/discovery?window=all&candidates=network&mix=straight`;

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

test("the sidebar reads tabs, divider, lenses, divider, shared filters", async ({ page }) => {
	test.setTimeout(60_000);
	await page.goto(DISCOVERY);
	await expect(
		page.getByRole("navigation", { name: "Anthers" }).getByRole("link", { name: "Discovery" }),
	).toBeVisible();

	// The section order on the Feed: the tab-shared LENSES (the middles are lenses
	// now), then the shared filters — Access, which the feed's stream consumes, then
	// Type, then Tags.
	expect(await page.getByRole("heading", { name: "Lenses", exact: true })).toBeVisible();
	expect(await page.getByRole("heading", { name: "Access", exact: true })).toBeVisible();
	expect(await page.getByRole("heading", { name: "Type", exact: true })).toBeVisible();
	expect(await page.getByRole("heading", { name: "Tags", exact: true })).toBeVisible();
	const headingY = async (name: string) =>
		await page
			.getByRole("heading", { name, exact: true })
			.evaluate((el) => el.getBoundingClientRect().y);
	expect(await headingY("Lenses")).toBeLessThan(await headingY("Access"));
	expect(await headingY("Access")).toBeLessThan(await headingY("Type"));
	expect(await headingY("Type")).toBeLessThan(await headingY("Tags"));

	// The map carries the two dividers between the sections: one below the nav
	// (persistent), one between the Lenses and the shared filters.
	const map = await sidebarMap(page);
	expect(map).not.toBeNull();
	const dividers = map?.filter((d) => d.divider) ?? [];
	expect(dividers.length, "the two structural dividers stand").toBeGreaterThanOrEqual(2);
	const nav = map?.find((d) => d.tag === "nav");
	const lenses = map?.find((d) => d.text === "Lenses");
	expect(
		nav && dividers[0] && lenses && dividers[0].y > nav.y && dividers[0].y < lenses.y,
		"the persistent divider sits between the nav and the Lenses",
	).toBe(true);

	// The Lenses on the feed: all three are live over the feed's own corpora (Parker,
	// 2026-10-23), so no row carries the grayed marker any more.
	const lensRows = await page.evaluate(() => {
		const headings = [...document.querySelectorAll("aside section h3")];
		const s = headings.find((h) => h.textContent === "Lenses")?.closest("section");
		return [...(s?.querySelectorAll("button") ?? [])].map(
			(b) =>
				`${b.textContent?.trim()}${b.getAttribute("aria-disabled") === "true" ? " [grayed]" : ""}`,
		);
	});
	expect(lensRows).toEqual(["No Lens", "Music Player", "Channel Guide", "Bookshelf"]);

	// A live lens opens its own view over the same stream, and No Lens gives the grid
	// back — the lens is a view, never a container, on the feed exactly as in the
	// Library. A feed with no music yet says so in the lens's own words.
	await page.getByRole("button", { name: "Music Player", exact: true }).click();
	await expect(
		page
			.getByTestId("release-grid")
			.or(page.getByText(/No music in your feed yet|Nothing to listen to in your feed yet/)),
	).toBeVisible();
	await page.getByRole("button", { name: "No Lens", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Lenses", exact: true })).toBeVisible();
	await expect(page.getByTestId("release-grid")).toHaveCount(0);

	// The retired names are gone: the shared section's heading is Type, not Work Type
	// — and Bookmarks, whose strip the Save unification retires, has no heading left
	// on this sidebar.
	expect(await page.getByText("Work Type").count()).toBe(0);
	expect(await page.getByRole("heading", { name: "Bookmarks", exact: true }).count()).toBe(0);
});

test("the shared Type list is the unified vocabulary, grayed rows included", async ({ page }) => {
	test.setTimeout(60_000);
	await page.goto(DISCOVERY);
	await expect(
		page.getByRole("navigation", { name: "Anthers" }).getByRole("link", { name: "Discovery" }),
	).toBeVisible();
	// The shared sections mount in an effect after first paint; wait for the
	// vocabulary rather than racing it.
	await expect(page.getByRole("heading", { name: "Type", exact: true })).toBeVisible();
	// All, then Posts below it, then every Work type in the shared order — the one
	// list every tab's sidebar carries (grayed consumers assert this where they land).
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
	await page.goto(DISCOVERY);
	await expect(
		page.getByRole("navigation", { name: "Anthers" }).getByRole("link", { name: "Discovery" }),
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

test("the divider below the nav is persistent on a page that registers nothing", async ({
	page,
}) => {
	// A page with no sidebar content of its own still gets the structure's divider:
	// the shape never depends on the page. (The Library no longer qualifies — its
	// Lenses grew in with its sidebar task; Settings never registers anything.)
	await page.goto(`${WEB_ORIGIN}/settings`);
	const map = await sidebarMap(page);
	const nav = map?.find((d) => d.tag === "nav");
	const anyDivider = map?.some((d) => d.divider && d.y > (nav?.y ?? 0));
	expect(anyDivider, "the divider stands below the nav").toBe(true);
});
