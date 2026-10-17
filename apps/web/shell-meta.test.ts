// SPDX-License-Identifier: Apache-2.0
//
// The app shell's link-preview tags are a claim about every shared link, and this is
// what keeps the claim true. The served head is identical on every route (a static SPA's
// catchall), so the tags below must name the site and can name no Work, creator or
// rating — that is a structural fact of the serving shape, not a copy choice, and it is
// why the per-route half of this work lives in the vault's Marketing Rendering lane.
//
// Two invariants are easy to lose without a feature to contradict them, and both get a
// test for the same reason the claims guards do: nothing else in the repo can tell.
//
// 1. **The description is quoted, not rewritten.** The claims document's standing
//    introduction is quoted everywhere one is needed, and the repository README carries
//    its first paragraph too — so the shell's og:description must equal that paragraph
//    exactly, and the shorter tag copies must be exact prefixes of it. A paraphrase that
//    drifts one claim at a time is exactly the failure the quote rule exists to stop.
// 2. **og:image names a stable address that exists.** Crawlers cache the asset and no
//    bundler rewrite can touch what a meta tag says, so the card lives in `public/brand/`
//    beside the identity server's email logo, generated and hash-recorded by
//    `bun run brand:logo`. If this test fails on a missing file, run it; if it fails on
//    a URL, the tags and the files have moved apart — read
//    `apps/web/public/brand/README.md` before renaming either half.

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SHELL = readFileSync(join(import.meta.dir, "index.html"), "utf8");
const MANIFEST = JSON.parse(readFileSync(join(import.meta.dir, "site.webmanifest"), "utf8"));
const README = readFileSync(join(import.meta.dir, "..", "..", "README.md"), "utf8");

const tag = (attr: "name" | "property", key: string): string | null => {
	const m = SHELL.match(new RegExp(String.raw`<meta\s[^>]*\b${attr}="${key}"[^>]*>`));
	if (!m) return null;
	return /content="([^"]*)"/.exec(m[0])?.[1] ?? null;
};

// The standing introduction's first paragraph, as the repository README carries it. The
// marketing pages quote it in whole; the shell's tags quote parts of it, and the
// assertions below check those parts stay exact prefixes of this line.
const standingIntro = README.split("\n").find((line) =>
	line.startsWith("Anthers is a nonprofit creative garden for everyone:"),
);
if (!standingIntro)
	throw new Error("the standing introduction paragraph is missing from the README");

describe("the shell's link-preview tags", () => {
	it("quotes the standing introduction, never a rewrite of it", () => {
		const ogDescription = tag("property", "og:description");
		const description = tag("name", "description");
		const twitterDescription = tag("name", "twitter:description");
		expect(ogDescription).toBe(standingIntro);
		expect(description).toBe(`${ogDescription?.split(". ")[0]}.`);
		expect(twitterDescription).toBe(description);
	});

	it("names the site, not a route or a Work", () => {
		expect(tag("property", "og:title")).toBe("Anthers");
		expect(tag("property", "og:site_name")).toBe("Anthers");
		expect(tag("property", "og:url")).toBe("https://anthers.org/");
		expect(tag("name", "twitter:card")).toBe("summary_large_image");
		expect(tag("name", "twitter:title")).toBe("Anthers");
	});

	it("points og:image at the stable-address card, which exists", () => {
		expect(tag("property", "og:image")).toBe("https://anthers.org/brand/og-card.png");
		expect(tag("property", "og:image:width")).toBe("1200");
		expect(tag("property", "og:image:height")).toBe("630");
		expect(existsSync(join(import.meta.dir, "public/brand/og-card.png"))).toBe(true);
	});

	it("the manifest's icons exist at the addresses it writes down", () => {
		expect(MANIFEST.name).toBe("Anthers");
		for (const icon of MANIFEST.icons as Array<{ src: string; sizes: string }>) {
			expect(icon.src.startsWith("/brand/")).toBe(true);
			expect(existsSync(join(import.meta.dir, "public", icon.src.slice(1)))).toBe(true);
		}
	});

	it("the head still carries the favicon links and the basic document meta", () => {
		expect(SHELL).toContain('rel="icon"');
		expect(SHELL).toContain('rel="apple-touch-icon"');
		expect(SHELL).toContain('rel="manifest"');
		expect(SHELL).toContain('<meta charset="UTF-8"');
	});
});
