// SPDX-License-Identifier: Apache-2.0
/**
 * The storefront cleanup's selection rules.
 *
 * The script deletes personal records, so the one thing worth proving without a database
 * is that a Work with any recorded way to play it never enters the set. Every case below
 * is a Work that could plausibly be mistaken for a storefront: a hosted build, an
 * archived build, an embed, a Work of a kind whose page IS its medium, and the
 * download-only shape the correction exists for.
 */
import { describe, expect, test } from "bun:test";
import { isStorefrontOnly, rolledUpRanges } from "./prune-storefront-attention";

const NONE = { currentBuilds: 0, archivedWebBuilds: 0 };

describe("which build Works are storefront-only", () => {
	test("a game with only downloadable files is", () => {
		expect(
			isStorefrontOnly(
				{ id: 1, type: "game", title: "A", streamEnabled: false, embedUrl: "" },
				NONE,
			),
		).toBe(true);
		expect(
			isStorefrontOnly(
				{ id: 2, type: "software", title: "B", streamEnabled: true, embedUrl: "" },
				NONE,
			),
		).toBe(true);
	});

	test("a Work with a current build is not, primary or not", () => {
		expect(
			isStorefrontOnly(
				{ id: 3, type: "game", title: "C", streamEnabled: true, embedUrl: "" },
				{ currentBuilds: 1, archivedWebBuilds: 0 },
			),
		).toBe(false);
	});

	test("a Work with an archived hosted build is not", () => {
		// The build was replaced rather than removed; the rows from while it played are real.
		expect(
			isStorefrontOnly(
				{ id: 4, type: "game", title: "D", streamEnabled: true, embedUrl: "" },
				{ currentBuilds: 0, archivedWebBuilds: 1 },
			),
		).toBe(false);
	});

	test("a Work with an embed the page accepts is not", () => {
		expect(
			isStorefrontOnly(
				{
					id: 5,
					type: "game",
					title: "E",
					streamEnabled: true,
					embedUrl: "https://example.com/play",
				},
				NONE,
			),
		).toBe(false);
	});

	test("an embed the page would refuse does not make it playable", () => {
		expect(
			isStorefrontOnly(
				{
					id: 6,
					type: "game",
					title: "F",
					streamEnabled: true,
					embedUrl: "http://example.com/play",
				},
				NONE,
			),
		).toBe(true);
	});

	test("a kind whose page is its medium is never a storefront", () => {
		for (const type of ["text", "video", "music", "audio", "image", "comic", "ebook"]) {
			expect(
				isStorefrontOnly({ id: 7, type, title: "G", streamEnabled: true, embedUrl: "" }, NONE),
			).toBe(false);
		}
	});
});

describe("rows the rollup may already own", () => {
	const now = Date.parse("2026-11-12T12:00:00Z");
	const recent = { startedAt: new Date(now - 60_000), createdAt: new Date(now) };
	// 181 days back — past the 180-day retention window.
	const old = { startedAt: new Date(now - 181 * 86_400_000), createdAt: new Date(now) };

	test("a range inside retention is deletable", () => {
		expect(rolledUpRanges([recent], now)).toEqual([]);
	});

	test("a range past retention refuses the run", () => {
		expect(rolledUpRanges([recent, old], now)).toEqual([old]);
	});
});
