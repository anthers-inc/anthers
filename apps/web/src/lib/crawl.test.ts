// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { robotsTxt, sitemapXml } from "./crawl.js";
import { indexablePaths, pageMeta } from "./page-meta.js";

const ORIGIN = "https://anthers.org";

describe("robotsTxt", () => {
	const policy = robotsTxt(ORIGIN);

	it("allows the public site and names the sitemap it is read beside", () => {
		expect(policy).toContain("User-agent: *");
		expect(policy).toContain("Allow: /");
		expect(policy).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
	});

	it("keeps the app's own surfaces out", () => {
		for (const path of ["/studio", "/settings", "/basket", "/login", "/signup", "/api/"]) {
			expect(policy).toContain(`Disallow: ${path}`);
		}
	});

	it("keeps the locator and the player out, because neither is a page", () => {
		expect(policy).toContain("Disallow: /s/");
		expect(policy).toContain("Disallow: /embed/");
	});
});

describe("sitemapXml", () => {
	const xml = sitemapXml(ORIGIN);

	it("is a urlset with one entry per indexable path", () => {
		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
		expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
		expect(xml.split("<url>")).toHaveLength(indexablePaths().length + 1);
	});

	it("names each page at its own absolute address", () => {
		for (const path of indexablePaths()) {
			expect(xml).toContain(`<loc>${ORIGIN}${path}</loc>`);
		}
	});

	it("leaves the doors and the app out", () => {
		for (const path of ["/login", "/signup", "/studio", "/basket"]) {
			expect(xml).not.toContain(`${ORIGIN}${path}<`);
		}
	});

	it("lists no path twice", async () => {
		const paths = indexablePaths();
		expect(new Set(paths).size).toBe(paths.length);
	});
});

describe("the sitemap and the card table", () => {
	it("agree about which pages describe themselves", () => {
		for (const path of indexablePaths()) {
			// The homepage is the one page whose card is the shell's own, by design.
			if (path === "/") continue;
			expect(pageMeta(path), `${path} has a card to go with its sitemap entry`).not.toBeNull();
		}
	});
});
