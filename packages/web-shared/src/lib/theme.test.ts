// SPDX-License-Identifier: Apache-2.0
//
// The catalog is the contract between three things that cannot import each other: the
// pre-paint snippets in the two index.html files, the API's stored-value enum, and the
// palette blocks in theme.css. These tests pin all three from here — the scripts by
// checking that they name every value (their behavior is still a browser check).

import { describe, expect, test } from "bun:test";
import { THEME_VALUES } from "@anthers/shared/theme";
import {
	DEFAULT_THEME,
	isDarkTheme,
	THEMES,
	themeDefinition,
	themeFamily,
	themeForValue,
	themeVariant,
	withVariant,
} from "./theme";

/** The palette roles every theme block must define, matching theme.css's own set. */
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
	return css.match(new RegExp(`\\[data-theme="${value}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1];
}

describe("theme catalog", () => {
	test("the catalog and the stored-value contract name the same values", () => {
		expect(THEMES.map((option) => option.value).sort()).toEqual([...THEME_VALUES].sort());
	});

	test("every family has exactly one light and one dark variant", () => {
		const families = new Map<string, string[]>();
		for (const option of THEMES) {
			families.set(option.label, [...(families.get(option.label) ?? []), option.group]);
		}
		for (const [label, groups] of families) {
			expect(groups.sort(), `${label} does not have one variant of each`).toEqual([
				"Dark",
				"Light",
			]);
		}
	});

	test("the default is in the catalog", () => {
		expect(themeDefinition(DEFAULT_THEME)).not.toBeNull();
	});

	test("an unknown or retired value resolves to null, never a theme", () => {
		expect(themeForValue("tidepool-dark")).toBeNull();
		expect(themeForValue("meadow-light")).toBeNull();
		expect(themeForValue(null)).toBeNull();
	});

	test("withVariant keeps the family and moves the variant", () => {
		expect(withVariant("reef-dark", "Light")).toBe("reef-light");
		expect(withVariant("ember-light", "Dark")).toBe("ember-dark");
		expect(withVariant("light", "Dark")).toBe("dark");
	});

	test("themeVariant, themeFamily and isDarkTheme read the catalog", () => {
		expect(themeVariant("reef-dark")).toBe("Dark");
		expect(themeFamily("heather-light")).toBe("Heather");
		expect(isDarkTheme("reef-dark")).toBe(true);
		expect(isDarkTheme("reef-light")).toBe(false);
	});

	test("both pre-paint snippets name every stored value", async () => {
		for (const file of ["apps/web/index.html", "apps/admin/index.html"]) {
			const html = await Bun.file(new URL(`../../../../${file}`, import.meta.url)).text();
			for (const value of THEME_VALUES) {
				expect(html, `${file} is missing ${value}`).toContain(`"${value}"`);
			}
		}
	});

	test("every catalog value has a complete palette block, and no block is an orphan", async () => {
		const css = await Bun.file(new URL("../styles/theme.css", import.meta.url)).text();

		for (const option of THEMES) {
			const block = blockFor(css, option.value);
			expect(block, `${option.value} has no block`).toBeDefined();
			const missing = REQUIRED_TOKENS.filter((token) => !block?.includes(`${token}:`));
			expect(missing, `${option.value} is missing ${missing.join(", ")}`).toEqual([]);
		}

		const blocks = [...css.matchAll(/\[data-theme="([^"]+)"\]/g)].map((match) => match[1]);
		expect([...new Set(blocks)].sort()).toEqual(THEMES.map((option) => option.value).sort());
	});
});
