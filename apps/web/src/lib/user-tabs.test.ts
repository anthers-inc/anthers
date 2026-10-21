// SPDX-License-Identifier: Apache-2.0
/**
 * The tab-id-to-route mapping the landing redirect reads.
 *
 * `RootRedirect` asks this for whatever the account payload holds, including `null` for
 * an account that never chose. The mapping is total on purpose — a payload from a build
 * whose default differed, or one naming a tab this build dropped, lands on a real tab
 * rather than on a broken route.
 */
import { describe, expect, it } from "bun:test";
import { DEFAULT_USER_TAB, USER_TABS, userTabPath } from "./user-tabs";

describe("userTabPath", () => {
	it("maps each tab id to its route", () => {
		for (const tab of USER_TABS) expect(userTabPath(tab.id)).toBe(tab.to);
	});

	it("sends an account that never chose to the default tab", () => {
		expect(DEFAULT_USER_TAB).toBe("network");
		expect(userTabPath(null)).toBe("/network");
		expect(userTabPath(undefined)).toBe("/network");
	});

	it("sends an id this build dropped to the default tab", () => {
		expect(userTabPath("browse")).toBe("/network");
	});
});
