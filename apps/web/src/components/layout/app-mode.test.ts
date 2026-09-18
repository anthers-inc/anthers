// SPDX-License-Identifier: Apache-2.0
/**
 * Which mode a page puts somebody in. The sticky half is the part worth a suite: a page that
 * belongs to neither mode must keep the one somebody arrived in, or following a link out of the
 * Studio swaps the sidebar under them.
 */
import { describe, expect, it } from "bun:test";
import { modeForPath } from "./app-mode";

describe("modeForPath", () => {
	it("puts every Studio route in studio mode", () => {
		for (const path of ["/studio", "/studio/catalog", "/studio/works/123456789/edit"]) {
			expect(modeForPath(path, "user")).toBe("studio");
		}
	});

	it("puts the user-only pages in user mode", () => {
		for (const path of ["/feed", "/library", "/discover", "/basket", "/settings", "/purchases"]) {
			expect(modeForPath(path, "studio")).toBe("user");
		}
	});

	it("keeps the mode somebody arrived in on a page that belongs to neither", () => {
		for (const path of ["/works/a-song-123456789", "/@someone", "/@someone/works/x-1", "/faq"]) {
			expect(modeForPath(path, "studio")).toBe("studio");
			expect(modeForPath(path, "user")).toBe("user");
		}
	});

	it("matches a whole path segment, not a prefix of one", () => {
		// A path that merely begins with a mode's root, such as `/studios` or `/feedback`, is neither.
		expect(modeForPath("/studios", "user")).toBe("user");
		expect(modeForPath("/feedback", "studio")).toBe("studio");
	});
});
