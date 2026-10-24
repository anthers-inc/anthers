// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pageMeta } from "./page-meta.js";

const APP = readFileSync(resolve(import.meta.dir, "../App.tsx"), "utf8");

/** Every path the table carries, as the table itself sees them. */
const PATHS = [
	"/for-creators",
	"/compare/itch-io",
	"/compare/ghost",
	"/about",
	"/supporters",
	"/faq",
	"/parents",
	"/abuse",
	"/privacy",
	"/terms",
	"/creator-terms",
	"/copyright",
	"/resources",
	"/resources/pay-comparison",
	"/resources/creator-financials",
	"/resources/how-money-moves",
	"/resources/media-month",
	"/release-notes",
	"/status",
];

describe("pageMeta", () => {
	it("names every page it carries, with a line to go with it", () => {
		for (const path of PATHS) {
			const meta = pageMeta(path);
			expect(meta, `${path} has a card`).not.toBeNull();
			expect(meta!.title.trim().length, `${path} has a title`).toBeGreaterThan(0);
			expect(meta!.description.trim().length, `${path} has a description`).toBeGreaterThan(0);
			// An unfurler truncates again at roughly this length, so a card that needs more
			// has written a line nobody will finish reading.
			expect(meta!.description.length, `${path}'s line fits a card`).toBeLessThanOrEqual(200);
		}
	});

	it("carries a path the app actually mounts, so no card is written for nothing", () => {
		for (const path of PATHS) {
			expect(APP, `${path} is a mounted route`).toContain(`path="${path}"`);
		}
	});

	it("takes a trailing slash as the same page", () => {
		expect(pageMeta("/about/")).toEqual(pageMeta("/about"));
	});

	it("leaves the homepage to the shell's own card, which already names it", () => {
		expect(pageMeta("/")).toBeNull();
	});

	it("keeps the site card on the doors rather than describing a form", () => {
		for (const path of ["/login", "/signup", "/finish", "/unsubscribe", "/desktop/authorize"]) {
			expect(pageMeta(path), `${path} is a door`).toBeNull();
		}
	});

	it("answers nothing for a page it does not carry", () => {
		expect(pageMeta("/studio/works")).toBeNull();
		expect(pageMeta("/no-such-page")).toBeNull();
		expect(pageMeta("/resources/no-such-resource")).toBeNull();
	});
});
