// SPDX-License-Identifier: Apache-2.0
/**
 * The signed-in site's Meadow backdrop — the decor layer the app shell mounts
 * behind its pages (pollen surface, side vines with their bees, grass floor).
 *
 * 🚨 **The layer's whole contract is that it paints BENEATH the page, and that is
 * what these specs pin.** A creator's work or post must never have bees, vines or
 * pollen rendered across it (Parker, 2026-10-16), so the backdrop carries a
 * negative z-index and sits in a stacking context shared with the page content:
 * `MeadowBackdrop`'s root against an ancestor wrapper that is `relative isolate`
 * (LoggedInLayout). If either half is lost — the layer moved inside the scrolled
 * <main>, the wrapper's `isolate` dropped, or the negative z replaced by something
 * at or above the content — the stacking-context walk below fails, because the
 * nearest stacking context of the backdrop and of <main> would differ.
 *
 * The z-index and paint contract also has to be a browser test for the reason the
 * band-alternation spec carries: nothing in the source reliably says a Tailwind
 * utility survived a refactor, and a layer at zero instead of negative still
 * typechecks, lint-tells nothing, and paints across the page's first paragraph.
 */
import { expect, type Page, test } from "@playwright/test";

const backdrop = (page: Page) => page.locator("[data-meadow-backdrop]");

test("the signed-in shell renders the Meadow backdrop behind its pages", async ({ page }) => {
	await page.goto("/feed");

	const layer = backdrop(page);
	await expect(layer, "the shell mounted no decor layer").toBeAttached();

	const style = await layer.evaluate((el) => {
		const s = getComputedStyle(el);
		return {
			zIndex: s.zIndex,
			pointerEvents: s.pointerEvents,
			backgroundImage: s.backgroundImage,
		};
	});

	// The decor is the page's backdrop, never a floating layer: negative z-index
	// (behind the page content), no pointer interaction (it can never swallow a
	// click meant for the page), and the pollen texture as its baked background.
	expect(
		parseInt(style.zIndex, 10),
		`the decor layer must carry a NEGATIVE z-index to paint beneath the page (saw ${style.zIndex})`,
	).toBeLessThan(0);
	expect(style.pointerEvents, "the decor layer must not intercept page interactions").toBe("none");
	expect(
		style.backgroundImage.length,
		"the pollen surface is missing — the layer lost its baked background",
	).toBeGreaterThan(0);
});

test("the backdrop and the page content share their stacking context", async ({ page }) => {
	await page.goto("/feed");

	// A stacking context is created by a positioned element with a non-auto
	// z-index; by isolation, opacity, transforms and filters; and by several
	// containment modes. The wrapper LoggedInLayout puts around the layer and
	// <main> must be one (`relative isolate`), or the layer's negative z-index
	// escapes into an outer context and paints beneath an OPAQUE ancestor — the
	// decor vanishing behind the page rather than sitting behind it, signed-in
	// flat again. So two facts, both required: the layer's parent is a stacking
	// context, and <main>'s own nearest stacking context is that same element.
	//
	// The shell's <main> is the right second walker because it is the page's
	// containing surface, present in every shell state, exactly what the decor
	// must stay beneath.
	const verdict = await page.evaluate(() => {
		const makesContext = (el: Element) => {
			const s = getComputedStyle(el);
			return (
				(s.position !== "static" && s.zIndex !== "auto") ||
				s.isolation === "isolate" ||
				parseFloat(s.opacity || "1") < 1 ||
				s.transform !== "none" ||
				s.filter !== "none" ||
				s.backdropFilter !== "none"
			);
		};
		const nearest = (el: Element): Element => {
			// Walk from the PARENT: the backdrop itself creates a stacking context by
			// design (its negative z-index), and the walk is for the context it shares
			// with the page, which only an ancestor of both can answer.
			let node: Element | null = el.parentElement;
			while (node && node !== document.documentElement) {
				if (makesContext(node)) return node;
				node = node.parentElement;
			}
			return document.documentElement;
		};
		const layer = document.querySelector("[data-meadow-backdrop]");
		const main = document.querySelector("main");
		if (!layer || !main || !layer.parentElement) {
			return "missing (no decor layer, no wrapper, or no main)";
		}
		const wrapper = layer.parentElement;
		if (!makesContext(wrapper)) {
			return "wrapper-not-a-context (the layer's negative z escapes to the page root)";
		}
		return nearest(main) === wrapper ? "shared" : "separate";
	});

	expect(
		verdict,
		"the decor layer and the page content live in different stacking contexts — the " +
			"layer's negative z-index no longer orders it beneath the page",
	).toBe("shared");
});

test("the backdrop carries the vines and the grass floor at wide viewports", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/feed");

	const layer = backdrop(page);
	await expect(layer).toBeAttached();

	// At `xl` the layer holds the left and right vine columns and the floor band's
	// wrapper, each carrying an inline `background-image`; below that only the pollen
	// surface rides the root. Counting the styled children, rather than class strings,
	// is what keeps this honest against a class refactor.
	const styled = await layer.evaluate(
		(el) =>
			[...el.querySelectorAll<HTMLElement>(":scope > div, :scope > div div")].filter(
				(d) => (d.style.backgroundImage?.length ?? 0) > 0,
			).length,
	);
	expect(
		styled,
		"expected the two vine columns plus the floor band to paint their tiles",
	).toBeGreaterThanOrEqual(3);
});
