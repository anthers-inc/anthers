// SPDX-License-Identifier: AGPL-3.0-or-later
//
// No page may scroll sideways on a phone. One test per logged-out route, at 390px.
//
// This is the gate half of `scripts/mobile-overflow.ts`, which found all seven
// overflowing routes fixed in PR #168 and was then wired into nothing at all — no
// Makefile target, no CI job, no script entry. The fix held by luck rather than by
// coverage: `SubscribePage` was rebuilt wholesale in PR #223 afterwards with nothing
// watching it. Living here rather than in a Makefile step means `make verify` and CI's
// `browser` job both run it without either being told to.
//
// The class of bug it catches is ordinary-looking Tailwind that silently loses, which is
// why reading a diff will not find it: `mx-auto` on a flex-column child disables
// `align-self: stretch`, and an inline `style={{maxWidth}}` beats `max-w-full` from a
// layer the cascade cannot resolve against. In both cases the class is present in the
// DOM and simply does not win, so there is no error anywhere.
//
// The script stays as the diagnostic loop — it reports every offender's computed style
// and screenshots the page. This file only has to fail, and carries enough into the
// failure message to say which element to open.
//
// 🚨 WHAT THIS CANNOT SEE, which matters more than what it can. `MeadowDecor` carries
// `overflow-hidden`, so on every route that renders it — directly or through
// `MeadowDecorLayout` — a breakout is CLIPPED rather than scrolled, the document never
// widens, and this gate passes no matter what. Measured, not inferred: injecting a
// 1200px element into each route's own content moved `scrollWidth` on 10 of the 22 routes
// then in the list and moved it on NONE of these —
//
//     /  ·  /for-creators  ·  /about  ·  /faq  ·  /resources  ·  /compare/itch-io
//     /compare/ghost  ·  /login (below the card)
//
// ⚠️ Four of the blind routes were the `/demo-*` pages, deleted on 2026-08-30. The count
// above is left at 22 because that is what was measured; the list is eight rather than
// twelve because those four routes no longer exist to be blind about.
//
// They are kept in the list on purpose — the clipping is a property of today's layout,
// not a promise, and a page that stops rendering `MeadowDecor` becomes checkable without
// anyone remembering to add it back. But do not read a green result on one of them as
// evidence it fits: clipped content is *cut off* rather than reachable, which is its own
// bug and one this gate is structurally blind to. Catching that needs a different
// assertion (no element's right edge past the viewport), and it would have to tell a
// deliberately-clipped vine from an accidentally-clipped paragraph — which is why it is
// not attempted here rather than why it is not worth doing.

import type { Page } from "@playwright/test";
import { MOBILE_ROUTES, MOBILE_WIDTH } from "../../scripts/mobile-routes";
import { expect, test } from "./fixtures";

test.use({
	viewport: { width: MOBILE_WIDTH, height: 844 },
	isMobile: true,
	hasTouch: true,
	deviceScaleFactor: 2,
});

/**
 * Measure the document against the width we ASKED for, and name what pokes past it.
 *
 * 🚨 `window.innerWidth` is the wrong yardstick and produces a false pass. Under
 * `isMobile: true` Chromium scales the layout viewport to fit the document, so a page
 * that overflows reports an `innerWidth` which has already grown to accommodate it and
 * the comparison comes out clean. The requested width is the only fixed quantity in the
 * measurement, which is why it is passed into the page rather than read from it.
 */
async function measure(page: Page, targetVw: number) {
	return page.evaluate((vw: number) => {
		const docWidth = document.documentElement.scrollWidth;
		const seen = new Set<string>();
		const offenders: string[] = [];
		for (const el of document.querySelectorAll("*")) {
			const rect = el.getBoundingClientRect();
			const overBy = Math.round(rect.right - vw);
			// 1px of slack: sub-pixel rounding at a 2x device scale factor puts a
			// correctly-fitting edge a fraction past the line often enough to matter.
			if (overBy <= 1) continue;
			const cls =
				typeof (el as HTMLElement).className === "string"
					? (el as HTMLElement).className.split(/\s+/).slice(0, 6).join(" ")
					: "";
			const key = `${el.tagName}|${cls}|${Math.round(rect.width)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const cs = window.getComputedStyle(el);
			offenders.push(
				`+${overBy}px <${el.tagName.toLowerCase()}> w=${Math.round(rect.width)} ` +
					`.${cls} (width=${cs.width} maxW=${cs.maxWidth} display=${cs.display})`,
			);
		}
		return { docWidth, offenders: offenders.slice(0, 8) };
	}, targetVw);
}

test.describe("no page scrolls sideways on a phone", () => {
	for (const route of MOBILE_ROUTES) {
		test(`${route} fits ${MOBILE_WIDTH}px`, async ({ page }) => {
			// ⚠️ Settle before measuring, or the gate reads a half-laid-out page. Measuring
			// straight after `load` had this spec passing `/copyright` and `/login` while both
			// genuinely overflowed — late-arriving layout widened the document after the
			// assertion had already run. `networkidle` plus a short beat matches what the
			// diagnostic script does, and is what makes the two agree.
			await page.goto(route, { waitUntil: "networkidle" });
			await page.waitForTimeout(300);

			// 🚨 The render proof is load-bearing, because the assertion below is a NEGATIVE
			// one and a blank page satisfies it perfectly. This is the trap that let the first
			// draft of `marketing-copy.e2e.ts` report nine passes against a loading spinner,
			// and the same family as the Tier 0 harness reporting "All routes clean" over a
			// page whose content never rendered. An empty document is 390px wide and always
			// will be.
			await expect(page.locator("#root")).not.toBeEmpty();
			const text = (await page.locator("body").textContent()) ?? "";
			expect(
				text.length,
				`${route} rendered no copy — the fit below would mean nothing`,
			).toBeGreaterThan(200);

			const { docWidth, offenders } = await measure(page, MOBILE_WIDTH);
			const over = docWidth - MOBILE_WIDTH;
			expect(
				docWidth,
				offenders.length
					? `${route} overflows by ${over}px:\n  ${offenders.join("\n  ")}`
					: `${route} overflows by ${over}px, with no single element past the edge — look for a margin, a grid gap or a negative inset`,
			).toBeLessThanOrEqual(MOBILE_WIDTH);
		});
	}
});
