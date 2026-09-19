// SPDX-License-Identifier: Apache-2.0
/**
 * What covers a Work's cover for a reader: their setting for its rung, and their setting for each
 * kind of content it may contain.
 *
 * Here because the failure is silent. A cover rule that stops matching shows the picture, which is
 * exactly what a reader who asked for nothing is supposed to see, so only a test can tell the two
 * apart.
 */
import { describe, expect, it } from "bun:test";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { type ContentPreferences, coverFor, DEFAULT_PREFERENCES } from "./content-preferences";

const general = { maturity: "general", maturityRows: rowsRatedAs("general") };

function asking(notes: Partial<ContentPreferences["notes"]>): ContentPreferences {
	return { ...DEFAULT_PREFERENCES, notes: { ...DEFAULT_PREFERENCES.notes, ...notes } };
}

describe("coverFor", () => {
	it("covers nothing General for a reader who has asked for nothing", () => {
		expect(coverFor(DEFAULT_PREFERENCES, general)).toBeNull();
		expect(
			coverFor(DEFAULT_PREFERENCES, {
				maturity: "general",
				maturityRows: { ...rowsRatedAs("general"), violence: "general" as const },
			}),
		).toBeNull();
	});

	it("covers Mature by its rung, as it always has", () => {
		expect(
			coverFor(DEFAULT_PREFERENCES, { maturity: "mature", maturityRows: rowsRatedAs("mature") }),
		).toEqual({
			byRung: true,
			byNotes: [],
		});
	});

	it("covers a General Work for a kind of content the reader blurs, and names it", () => {
		const cartoon = {
			maturity: "general",
			maturityRows: { ...rowsRatedAs("general"), violence: "general" as const },
		};
		expect(coverFor(asking({ violence: "blur" }), cartoon)).toEqual({
			byRung: false,
			byNotes: ["violence"],
		});
		// Marked Not in It, it is not what the reader asked about.
		expect(coverFor(asking({ violence: "blur" }), general)).toBeNull();
	});

	it("🚨 covers a Work whose row nobody answered", () => {
		// The same allow-list rule the listings use: nothing is shown uncovered on the strength of
		// an answer nobody gave.
		expect(coverFor(asking({ horror: "blur" }), { maturity: "general", maturityRows: {} })).toEqual(
			{ byRung: false, byNotes: ["horror"] },
		);
	});

	it("covers a kind of content the reader hides wherever it still appears", () => {
		const horror = {
			maturity: "mature",
			maturityRows: { ...rowsRatedAs("general"), horror: "mature" as const },
		};
		const cover = coverFor({ ...asking({ horror: "hide" }), mature: "show" }, horror);
		expect(cover).toEqual({ byRung: false, byNotes: ["horror"] });
	});

	it("names every kind of content that covered it, in the matrix's order", () => {
		const rows = { ...rowsRatedAs("general"), language: "general", violence: "general" } as const;
		expect(
			coverFor(asking({ language: "blur", violence: "blur" }), {
				maturity: "general",
				maturityRows: rows,
			})?.byNotes,
		).toEqual(["violence", "language"]);
	});
});
