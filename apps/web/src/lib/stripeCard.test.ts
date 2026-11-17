// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Stripe Elements appearance reads DaisyUI 5's tokens, and reads them whole.
 *
 * 🚨 **This is a source-text assertion, and it is the right shape for this defect.** The
 * appearance is resolved in a browser — `toRgb` rasterises a probe element through a
 * canvas — so a DOM-less suite cannot observe the color that reaches Stripe. What it can
 * observe is the string, and the string is where the bug lived: the tokens were DaisyUI 4's
 * `--bc`, `--b1`, `--p` and `--er`, which the theme stopped defining when it moved to
 * DaisyUI 5. An undefined property inside `var()` invalidates the declaration rather than
 * falling back, so the probe kept `body`'s inherited color and BOTH `colorText` and
 * `colorBackground` resolved to it. On the light theme that painted every card and address
 * field dark green with dark green text; on the dark theme it painted them cream with cream
 * labels. Nothing threw, and no browser spec reaches a payment surface yet.
 *
 * The second half — that the tokens are never wrapped in `oklch()` — is the other half of
 * the same trap: DaisyUI 5's tokens are complete colors, so `oklch(var(--color-base-100))`
 * is `oklch(oklch(…))` and is just as invalid as the missing variable was.
 */
describe("Stripe Elements appearance", () => {
	// Comments are stripped first, because the docblock above has to be able to *name* the
	// retired variables and the wrapper it warns against. The assertion is about the code.
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

	it("resolves the four roles the Appearance API needs", () => {
		expect(source).toContain('colorPrimary: toRgb("var(--color-primary)")');
		expect(source).toContain('colorText: toRgb("var(--color-base-content)")');
		expect(source).toContain('colorBackground: toRgb("var(--color-base-100)")');
		expect(source).toContain('colorDanger: toRgb("var(--color-error)")');
	});
});
