// SPDX-License-Identifier: Apache-2.0
//
// The theme study's one mechanical invariant: every candidate family has both of its
// palette blocks in the stylesheet, and each block carries the full token set. A
// missing block would silently render the study's preview in Meadow, which looks
// plausible enough that only this check or a careful eye would catch it.

import { describe, expect, test } from "bun:test";
import { CURRENT_FAMILY, LAB_FAMILIES, type LabVariant, themeValue } from "./theme-lab-data";

const CSS_PATH = new URL(
	"../../../../packages/web-shared/src/styles/theme-candidates.css",
	import.meta.url,
);

const VARIANTS: readonly LabVariant[] = ["light", "dark"];

/** The palette roles every block must define, matching theme.css's own set. */
const REQUIRED_TOKENS = [
	"--color-base-100",
	"--color-base-200",
	"--color-base-300",
	"--color-base-content",
	"--color-primary",
	"--color-primary-content",
	"--color-secondary",
	"--color-secondary-content",
	"--color-accent",
	"--color-accent-content",
	"--color-neutral",
	"--color-neutral-content",
	"--color-info",
	"--color-info-content",
	"--color-success",
	"--color-success-content",
	"--color-warning",
	"--color-warning-content",
	"--color-error",
	"--color-error-content",
	"--bluesky-mark",
] as const;

function blockFor(css: string, value: string): string | undefined {
	const match = css.match(new RegExp(`\\[data-theme="${value}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
	return match?.[1];
}

describe("theme study candidates", () => {
	test("every family and variant has a complete palette block", async () => {
		const css = await Bun.file(CSS_PATH).text();

		for (const family of LAB_FAMILIES) {
			for (const variant of VARIANTS) {
				const value = themeValue(family, variant);
				const block = blockFor(css, value);
				expect(block, `${value} has no block`).toBeDefined();

				const missing = REQUIRED_TOKENS.filter((token) => !block?.includes(`${token}:`));
				expect(missing, `${value} is missing ${missing.join(", ")}`).toEqual([]);
			}
		}
	});

	test("Meadow keeps the real light and dark values", () => {
		expect(themeValue(CURRENT_FAMILY, "light")).toBe("light");
		expect(themeValue(CURRENT_FAMILY, "dark")).toBe("dark");
	});
});
