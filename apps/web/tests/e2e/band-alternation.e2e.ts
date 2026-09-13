// SPDX-License-Identifier: Apache-2.0
//
// A banded marketing page alternates tinted and plain from the hero to the closing band,
// with no two bands of the same surface touching. See `Section` in
// `packages/web-shared/src/components/decor/sections.tsx` for why the alternation wins
// over bookending the page.
//
// This has to be a browser test because nothing in the source says it. Each page sets
// `tint` band by band, the FAQ and the Roadmap derive it from a content count, and adding
// a section, a category or a bucket shifts everything below it. Reading a diff does not
// find it; two plain bands separated only by padding look like a deliberate choice until
// the page is rendered.
//
// A band is a top-level `<header>` or `<section>` in the page content, which is how every
// one of these pages is built, and it is tinted when it paints any background at all.

import { expect, test } from "./fixtures";

const BANDED_ROUTES = [
	"/",
	"/for-creators",
	"/about",
	"/faq",
	"/roadmap",
	"/resources",
	"/compare/itch-io",
	"/compare/ghost",
];

for (const route of BANDED_ROUTES) {
	test(`${route} alternates its section bands`, async ({ page }) => {
		await page.goto(route);
		await page.locator("main header, main section").first().waitFor();

		const bands = await page.evaluate(() =>
			[...document.querySelectorAll("main header, main section")]
				.filter((el) => el.parentElement?.closest("header, section") === null)
				.map((el) => ({
					tinted: getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)",
					label: (el.querySelector("h1, h2, p")?.textContent ?? "").trim().slice(0, 48),
				})),
		);

		// A selector that stopped matching would pass the check below vacuously.
		expect(
			bands.length,
			"no section bands found — has the page structure changed?",
		).toBeGreaterThanOrEqual(3);
		expect(bands[0].tinted, `the hero band ("${bands[0].label}") should be tinted`).toBe(true);

		const touching = bands.flatMap((band, i) =>
			i > 0 && band.tinted === bands[i - 1].tinted
				? [
						`"${bands[i - 1].label}" and "${band.label}" are both ${band.tinted ? "tinted" : "plain"}`,
					]
				: [],
		);
		expect(touching).toEqual([]);
	});
}
