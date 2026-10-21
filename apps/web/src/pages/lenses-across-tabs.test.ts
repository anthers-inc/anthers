// SPDX-License-Identifier: Apache-2.0
/**
 * The Lenses section belongs to every user tab (Parker, 2026-10-19), and each tab lights
 * the rows it has built (Parker, 2026-10-20 for the Network's two).
 *
 * A source-text guard: the shared component renders every row and grays the ones a tab
 * has not built, so the only per-tab choices are the `live` set and the adapter. This
 * pins the section's presence on Library, Network, and Discovery, each tab's live set,
 * Discovery's lens riding the URL beside its mode, and the graying contract that makes an
 * unbuilt row a visible promise rather than a missing word.
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

	it("lights the Music Player and Bookshelf on the Network, over the feed", () => {
		expect(network).toContain('const NETWORK_LIVES = new Set(["", "music", "bookshelf"])');
		expect(network).toContain("live={NETWORK_LIVES}");
		expect(network).toContain('scope="feed"');
		expect(network).toContain('source="network"');
	});

	it("keeps the Channel Guide grayed on the Network until it has a corpus it can play", () => {
		// A feed entry carries no payload, so the guide's inline player has nothing to
		// open there yet. The row stays, grayed, rather than promising a lens that would
		// render its locked pane for every program.
		expect(network).not.toContain("channel-guide");
	});

	it("starts Discovery with No Lens as the only live row", () => {
		// The prop is absent, so the component's default set is what Discovery uses.
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
