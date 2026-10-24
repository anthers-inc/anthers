// SPDX-License-Identifier: Apache-2.0
/**
 * One card for one thing (Parker, 2026-10-24): the Library shelf renders the same
 * `FeedTile` the Network, Discovery and a creator's page render. The shelf used to draw
 * its own `ShelfCard`, so the same Work looked like a different product depending on
 * which tab happened to list it — and the creator page's Projects sat in a second card
 * family inside the one grid.
 *
 * A source-text guard, because the surfaces share a widget rather than a stylesheet: what
 * can regress is a page quietly growing a private card again, a grid drifting away from
 * the shape the others use, or the tile losing the Project arm that lets a creator's
 * timeline hold every kind.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");

const network = read("AuthenticatedHomePage.tsx");
const discovery = read("DiscoverPage.tsx");
const library = read("LibraryPage.tsx");
const creator = read("CreatorProfilePage.tsx");
const tile = read("../components/cards/FeedTile.tsx");

/** The auto-fill grid every listing surface shares. */
const SHARED_GRID = "grid-cols-[repeat(auto-fill,minmax(280px,1fr))]";

const SURFACES = [
	["Network", network],
	["Discovery", discovery],
	["Library", library],
	["Creator page", creator],
] as const;

describe("every listing surface renders the shared tile", () => {
	it("imports and renders FeedTile", () => {
		for (const [surface, source] of SURFACES) {
			expect(source, `${surface} does not import the shared tile`).toContain(
				'from "../components/cards/FeedTile"',
			);
			expect(source, `${surface} does not render the shared tile`).toContain("<FeedTile");
		}
	});

	it("lays its entries out in the one grid shape", () => {
		for (const [surface, source] of SURFACES) {
			expect(source, `${surface} uses a grid of its own`).toContain(SHARED_GRID);
		}
	});

	it("leaves the Library no private card family", () => {
		expect(library, "the Library grew its own card again").not.toContain("function ShelfCard");
		// The shelf's own facts ride the tile's slots rather than a second widget.
		expect(library).toContain("<ShelfTile");
		expect(library).toContain("badges={");
		expect(library).toContain("actions={");
	});

	it("gives the creator page's Projects the tile instead of a second card", () => {
		expect(creator, "the creator page still imports ProjectCard").not.toContain(
			'import ProjectCard from "../components/cards/ProjectCard"',
		);
		expect(creator, "the creator page still renders ProjectCard").not.toContain("<ProjectCard");
		expect(creator).toContain("projectEntry");
	});
});

describe("the shared tile carries all three kinds", () => {
	it("has a release, a post and a project arm", () => {
		expect(tile).toContain('entry.kind === "release"');
		expect(tile).toContain('entry.kind === "project"');
		expect(tile).toContain("PostTile");
		expect(tile).toContain("ProjectTile");
	});

	it("never prints the missing-creator fallback", () => {
		// A tombstoned creator is ordinary on a shelf, so the tile shows a neutral face and
		// words rather than the "?" the old card family rendered wherever a join was absent.
		expect(tile).toContain("Unknown creator");
		expect(tile).not.toContain('{ handle: "?" }');
	});
});
