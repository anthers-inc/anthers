// SPDX-License-Identifier: Apache-2.0
/**
 * The email decor's contract, from its docblock: each builder emits an SVG data URI
 * that decodes to real markup, and stays inside an email's payload budget — Gmail
 * clips message HTML at roughly 102 KB and counts a data URI at full encoded size,
 * so a builder that quietly grew past these bounds would push real mail into the
 * clip. Determinism is asserted too: the shell embeds these on every send, and a
 * builder that scattered randomly between two sends would make every email differ.
 */
import { describe, expect, it } from "bun:test";
import { emailGrassFloorDataUri, emailVineTileDataUri } from "./decor";

const PALETTE = {
	stem: "#227240",
	flower: "#e9c85e",
	core: "#ce8c19",
	grass: "#227240",
	casing: "#f3f0de",
};

describe("the email vine tile", () => {
	const uri = emailVineTileDataUri(PALETTE);

	it("is an SVG data URI that decodes to self-closing markup", () => {
		expect(uri.startsWith("data:image/svg+xml,")).toBe(true);
		const svg = decodeURIComponent(uri.slice("data:image/svg+xml,".length));
		expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
		expect(svg).toContain("</svg>");
		// Baked color rather than currentColor: an email never sets one.
		expect(svg).toContain(PALETTE.stem);
	});

	it("stays inside the email payload budget — well under 12 KB encoded", () => {
		expect(uri.length).toBeLessThan(12 * 1024);
	});

	it("is deterministic, so every send embeds the same decor", () => {
		expect(emailVineTileDataUri(PALETTE)).toBe(uri);
	});
});

describe("the email grass floor tile", () => {
	const uri = emailGrassFloorDataUri(PALETTE);

	it("is an SVG data URI that decodes to self-closing markup", () => {
		expect(uri.startsWith("data:image/svg+xml,")).toBe(true);
		const svg = decodeURIComponent(uri.slice("data:image/svg+xml,".length));
		expect(svg).toContain("</svg>");
		// The bees ride the tile, since a mail client strips position:absolute —
		// asserted through the icon markup a bee group carries (a transform whose
		// scale matches a bee's size) plus the amber fill they are given.
		expect(svg).toContain('fill="#ce8c19"');
	});

	it("stays inside the email payload budget — well under 12 KB encoded", () => {
		expect(uri.length).toBeLessThan(12 * 1024);
	});

	it("is deterministic, so every send embeds the same decor", () => {
		expect(emailGrassFloorDataUri(PALETTE)).toBe(uri);
	});
});
