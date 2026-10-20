// SPDX-License-Identifier: Apache-2.0
/**
 * The Lenses section belongs to every user tab (Parker, 2026-10-19).
 *
 * A source-text guard: the shared component renders every row and grays the ones a tab
 * has not built, so the only per-tab choices are the `live` set and the adapter. This
 * pins the section's presence on Library, Network, and Discovery, Discovery's lens
 * riding the URL beside its mode, and the graying contract that makes an unbuilt row a
 * visible promise rather than a missing word.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");

const network = read("AuthenticatedHomePage.tsx");
const library = read("LibraryPage.tsx");
const discovery = read("DiscoverPage.tsx");
const section = read("../components/layout/SharedLensesSection.tsx");

describe("the Lenses section on all three tabs", () => {
	it("is rendered by Network, Library, and Discovery", () => {
		for (const [tab, source] of [
			["Network", network],
			["Library", library],
			["Discovery", discovery],
		] as const) {
			expect(source, `${tab} does not import the shared lenses section`).toContain(
				'from "../components/layout/SharedLensesSection"',
			);
			expect(source, `${tab} does not render the shared lenses section`).toContain(
				"<SharedLensesSection",
			);
		}
	});

	it("keeps the Library's built lenses live", () => {
		expect(library).toContain('new Set(["", "music", "channel-guide", "bookshelf"])');
	});

	it("starts Network and Discovery with No Lens as the only live row", () => {
		// The prop is absent on both, so the component's default set is what they use.
		expect(network).not.toContain("live={");
		expect(discovery).not.toContain("live={");
		expect(section).toContain('live = new Set([""])');
	});
});

describe("Discovery composes a lens with the active mode", () => {
	it("carries both the mode and the lens in the URL", () => {
		expect(discovery).toContain('searchParams.get("mode")');
		expect(discovery).toContain('searchParams.get("lens")');
		expect(discovery).toContain("updateParams({ lens: id })");
	});

	it("leaves the lens in place when the mode changes", () => {
		// The mode switch clears the mode's own preset vocabulary and the ticker's
		// access control; it never clears `lens`, because a lens applies over any mode.
		const switchCall = discovery.slice(
			discovery.indexOf("updateParams({") + 1,
			discovery.indexOf('preset: "",'),
		);
		expect(switchCall).not.toContain("lens:");
	});
});

describe("an unbuilt lens is grayed, never missing", () => {
	it("renders every row and disables the unbuilt ones", () => {
		expect(section).toContain("LENSES.map");
		expect(section).toContain("disabled={!built}");
		expect(section).toContain("(Coming Soon)");
	});
});
