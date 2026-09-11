// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What a stored Dashboard layout resolves to.
 *
 * Here because **every failure in this module is a plausible value rather than an error**: a
 * retired panel name renders a missing box, a duplicate renders the same panel twice, and
 * collapsing "never arranged" into "arranged to nothing" hands a new creator a blank page
 * that looks exactly like a deliberate one.
 */
import { describe, expect, it } from "bun:test";
import {
	DEFAULT_STUDIO_PANELS,
	hiddenStudioPanels,
	resolveStudioPanels,
	STUDIO_PANELS,
} from "./studio-panels";

describe("resolveStudioPanels", () => {
	it("gives a creator who has never arranged anything the defaults", () => {
		expect(resolveStudioPanels(null)).toEqual(DEFAULT_STUDIO_PANELS);
		expect(resolveStudioPanels(undefined)).toEqual(DEFAULT_STUDIO_PANELS);
	});

	it("keeps an empty layout empty, because hiding everything is a real choice", () => {
		// 🚨 The distinction the whole function turns on. Collapsing this into the defaults
		// would silently override somebody who cleared their Dashboard on purpose.
		expect(resolveStudioPanels([])).toEqual([]);
	});

	it("keeps the creator's order rather than the canonical one", () => {
		expect(resolveStudioPanels(["posts", "earnings"])).toEqual(["posts", "earnings"]);
	});

	it("drops a panel that no longer exists", () => {
		// A stored array is a list of names written in the past. A retired one must not reach
		// a renderer that has never heard of it.
		expect(resolveStudioPanels(["earnings", "a-panel-we-removed"])).toEqual(["earnings"]);
	});

	it("collapses a repeat rather than rendering the panel twice", () => {
		expect(resolveStudioPanels(["catalog", "catalog"])).toEqual(["catalog"]);
	});

	it("survives a stored value that is not a list at all", () => {
		expect(resolveStudioPanels("earnings")).toEqual(DEFAULT_STUDIO_PANELS);
		expect(resolveStudioPanels({ panels: ["earnings"] })).toEqual(DEFAULT_STUDIO_PANELS);
	});

	it("hands back a fresh array, so a caller mutating it cannot move the defaults", () => {
		const first = resolveStudioPanels(null);
		first.push("posts");
		expect(resolveStudioPanels(null)).toEqual(DEFAULT_STUDIO_PANELS);
	});
});

describe("hiddenStudioPanels", () => {
	it("offers everything not already shown, in canonical order", () => {
		expect(hiddenStudioPanels(["catalog"])).toEqual(STUDIO_PANELS.filter((p) => p !== "catalog"));
		expect(hiddenStudioPanels([...STUDIO_PANELS])).toEqual([]);
		expect(hiddenStudioPanels([])).toEqual([...STUDIO_PANELS]);
	});

	it("orders the menu canonically rather than by what was removed", () => {
		// Two creators who removed the same panels in different orders see the same menu.
		expect(hiddenStudioPanels(["posts", "earnings"])).toEqual(
			hiddenStudioPanels(["earnings", "posts"]),
		);
	});
});
