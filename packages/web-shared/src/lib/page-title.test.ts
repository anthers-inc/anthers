// SPDX-License-Identifier: Apache-2.0
//
// The tab-title suffix lives in one place so every page names itself the same way. A
// page title is a noun phrase in title case at the call site; what this helper owns is
// the site name and the empty-label case, and that is all these pin.

import { describe, expect, it } from "bun:test";
import { pageTitle } from "./page-title";

describe("pageTitle", () => {
	it("appends the site name to a page's own label", () => {
		expect(pageTitle("For Creators")).toBe("For Creators — Anthers");
		expect(pageTitle("Compared to itch.io")).toBe("Compared to itch.io — Anthers");
	});

	it("an empty label reads as the bare site name, never a dangling separator", () => {
		expect(pageTitle(null)).toBe("Anthers");
		expect(pageTitle(undefined)).toBe("Anthers");
		expect(pageTitle("")).toBe("Anthers");
	});
});
