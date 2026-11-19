// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Stripe Elements appearance is browser-resolved, so these are source-text assertions.
 *
 * `toRgb` reads a theme token through `getComputedStyle` and rasterises it through a
 * canvas, which a DOM-less suite cannot observe. What it can observe is the source, and
 * the source is where both defects lived:
 *
 * - the tokens were DaisyUI 4's `--bc`, `--b1`, `--p` and `--er`, which the theme stopped
 *   defining; an undefined property inside `var()` invalidates the declaration rather
 *   than falling back, so both text and background resolved to the body's inherited color;
 * - the field surface was `base-100`, the same token as the card around it, so the
 *   AddressElement's inputs disappeared into the page in both themes.
 *
 * The assertions below pin the parts a reviewer can see without a browser: the tokens are
 * DaisyUI 5's complete colors, the field and block surfaces differ, the dark variant uses
 * Stripe's dark theme, and a theme change recomputes the appearance.
 */
describe("Stripe Elements appearance", () => {
	// Comments are stripped first, because the docblocks have to be able to *name* the
	// retired variables and the wrapper they warn against. The assertions are about code.
	const source = readFileSync(join(import.meta.dir, "stripeCard.ts"), "utf8").replace(
		/\/\*[\s\S]*?\*\//g,
		"",
	);

	it("names DaisyUI 5 tokens rather than the retired short variables", () => {
		// Every `var(--…)` the file reads must be a `--color-*` token.
		const variables = [...source.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
		expect(variables.length).toBeGreaterThan(0);
		for (const name of variables) expect(name).toStartWith("--color-");
		// The four DaisyUI 4 names this file used to carry, named so a regression is obvious.
		for (const retired of ["--b1", "--bc", "--p", "--er"])
			expect(source).not.toContain(`var(${retired})`);
	});

	it("passes each token through without wrapping it in oklch()", () => {
		expect(source).not.toContain("oklch(var(");
	});

	it("gives the fields their own surface, distinct from the block around them", () => {
		expect(source).toContain('const field = toRgb("var(--color-base-200)")');
		expect(source).toContain("colorBackground: field");
		expect(source).toContain('".Block": { backgroundColor: surface }');
		expect(source).toContain('".Input": {');
		expect(source).toContain("backgroundColor: field");
		expect(source).toMatch(/border: `1px solid \$\{border\}`/);
	});

	it("uses Stripe's dark theme for a dark variant", () => {
		expect(source).toContain('theme: dark ? ("night" as const) : ("flat" as const)');
	});

	it("resolves the muted and focus roles rather than leaving them to Stripe", () => {
		expect(source).toContain("labelColorText: label");
		expect(source).toContain("colorTextPlaceholder: placeholder");
		expect(source).toContain("colorTextSecondary: secondary");
		expect(source).toContain("inputColorBorder: border");
		expect(source).toContain("inputFocusColorBorder: primary");
		expect(source).toContain('".Input:focus": {');
	});

	it("recomputes when the document's theme changes", () => {
		expect(source).toContain("useTheme()");
		expect(source).toContain("useMemo(() => stripeAppearance(theme), [theme])");
	});

	it("resolves the four roles the Appearance API needs", () => {
		expect(source).toContain('const primary = toRgb("var(--color-primary)")');
		expect(source).toContain('const text = toRgb("var(--color-base-content)")');
		expect(source).toContain("colorPrimary: primary");
		expect(source).toContain("colorText: text");
		expect(source).toContain("colorBackground: field");
		expect(source).toContain('const danger = toRgb("var(--color-error)")');
		expect(source).toContain("colorDanger: danger");
	});
});
