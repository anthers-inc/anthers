// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { APP_VERSION } from "./version";

/**
 * `APP_VERSION` is a hand-bumped calver constant, and a hand-bumped constant has no
 * generator behind it — this suite is the generator's job done by a test. A typo in
 * a bump (`202.10.0`, `2026-10-0`, a `v` prefix) fails the build here rather than
 * shipping a footer that reads wrong or breaking `git tag` at deploy time.
 *
 * The shape is `YYYY.M.N` — exactly three dot-separated components, first is a four
 * digit year, the rest are digits. Deliberately loose on month/patch ranges: the
 * month is real time (and the guard would be wrong about it half the year) and a
 * patch above `9` is legal, so the test pins the grammar rather than the calendar.
 */
describe("APP_VERSION", () => {
	it("is calver YYYY.M.N", () => {
		expect(APP_VERSION).toMatch(/^\d{4}\.\d{1,2}\.\d+$/);
	});

	it("carries no v prefix and no spaces", () => {
		// `git tag v<APP_VERSION>` in the deploy job composes this string, and a tag
		// may not carry a space or a leading `v` on top of the prefix it already adds.
		expect(APP_VERSION).not.toContain(" ");
		expect(APP_VERSION.startsWith("v")).toBe(false);
	});

	it("is also valid semver, so desktop/node tooling parses it", () => {
		// The whole reason calver works for the distributed repos too: the string
		// `2026.10.0` parses as semver major 2026. If this ever stops holding, the
		// desktop updater's version comparison silently misorders releases.
		const parts = APP_VERSION.split(".");
		expect(parts).toHaveLength(3);
		for (const part of parts) {
			expect(/^\d+$/.test(part)).toBe(true);
			expect(Number(part)).toBeGreaterThanOrEqual(0);
			expect(Number.isNaN(Number(part))).toBe(false);
		}
	});
});
