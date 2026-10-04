// SPDX-License-Identifier: Apache-2.0
/**
 * Two-column basket layout — the second checkout's layout change (2026-10-03).
 *
 * The first live checkout filled a `max-w-2xl` single column; the page's horizontal space
 * went unused and every part of the flow read as a thin strip. The layout contract:
 *
 * - Desktop (`lg` and up): a two-column grid. The checkout column renders first in the
 *   JSX (it owns the page's only `<form>` and the only submit button) and sits visually
 *   right (`lg:order-2`); the items + receipt column sits left.
 * - Mobile (below `lg`): one column, reading order **items → receipt → checkout** —
 *   you read what you're buying before you pay for it, so the checkout column is `order-3`
 *   while DOM order puts the checkout first for focus and form semantics.
 *
 * This is a source-text guard in the family of `checkout-address-guard.test.ts`: the
 * layout is a class-string contract, and a refactor that flattens the grid or reorders
 * the stacking regresses a decision the live checkout paid for. It pins the exact
 * tokens per element rather than their prose.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "BasketPage.tsx"), "utf8");

describe("the basket page's two-column layout", () => {
	it("widens the page container beyond the old single-column width", () => {
		// The EMPTY basket's state keeps max-w-2xl deliberately (a centered empty state
		// reads right); only the FILLED page's container was widened — so the assertion
		// anchors on the max-width that only the filled layout carries, and the retired
		// one-column width must not sit beside the page's own container class where the
		// two-column contract lives.
		expect(source).not.toMatch(/max-w-2xl px-4 py-8/);
		expect(source, "the basket page lost its widened container").toContain("max-w-6xl px-4 py-8");
	});

	it("grids into two columns at lg", () => {
		expect(source).toContain("lg:grid");
		expect(source).toContain("lg:grid-cols-2");
	});

	it("stacks to one column below lg, reading items before the checkout", () => {
		// The base flex column is what stacks; the order utilities place the items
		// column first (order-1) and the checkout last (order-3) in the reading flow.
		expect(source).toContain("flex flex-col");
		expect(source).toContain("order-3");
		expect(source).toContain("order-1");
	});

	it("sits the checkout column LEFT on desktop, the items column right (2026-10-04)", () => {
		// Flip day: the checkout (form) column was visually right since the two-column
		// layout landed; Parker turned it around the next day — the form belongs left,
		// the pricing right. At `lg` the checkout is order-1 and the items order-2.
		expect(source).toMatch(/className="order-3 lg:order-1" data-testid="basket-checkout-column"/);
		expect(source).toMatch(/className="order-1 lg:order-2[^"]*" data-testid="basket-items-column"/);
		// And the old right-side placement of the checkout column is gone.
		expect(source).not.toContain('order-3 lg:order-2" data-testid="basket-checkout-column"');
	});

	it("keeps the checkout and its column locatable — the e2e specs anchor on these", () => {
		expect(source).toContain('data-testid="basket-checkout-column"');
		expect(source).toContain('data-testid="basket-items-column"');
		expect(source).toContain('data-testid="basket-items"');
	});

	it("splits the receipt into the buyer's section and the creator's section", () => {
		// 2026-10-04: the card fee is not the buyer's to pay — it comes out of the
		// price. Its line must sit INSIDE the creator's section (after the "You pay"
		// divider, before the receives line), and never between Subtotal and You pay.
		// Anchored on the JSX text nodes with surrounding punctuation so comments and
		// prose cannot satisfy them (the word "receives" itself appears in commentary).
		const payIdx = source.indexOf(">You pay</span>");
		const feeIdx = source.indexOf("Card processing");
		const receivesIdx = source.indexOf('data-testid="basket-creator-earns"');
		const taxIdx = source.indexOf("sessionTotals?.tax ?? 0");
		expect(payIdx).toBeGreaterThan(-1);
		expect(feeIdx).toBeGreaterThan(payIdx);
		expect(receivesIdx).toBeGreaterThan(feeIdx);
		// The tax line, by contrast, belongs to the buyer's half — before "You pay".
		expect(taxIdx).toBeGreaterThan(-1);
		expect(taxIdx).toBeLessThan(payIdx);
	});
});
