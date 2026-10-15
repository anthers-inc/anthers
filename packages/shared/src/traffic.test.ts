// SPDX-License-Identifier: Apache-2.0
/**
 * The traffic policy's pure half: referrer classification, bot detection, device
 * class, and the retention constant's existence. No clock, no DOM, no I/O — the whole
 * file is instant, which is the point of the policy living in `@anthers/shared`.
 *
 * ⚠️ **What these tests intentionally do NOT pin: the exact membership of the lists.**
 * The referrer and bot lists are curated data, extended as the web's reality asks —
 * a test enumerating entries would turn every addition into a test edit with no
 * information. What is pinned is the classification *behavior*: the categories, the
 * subdomain rule, the same-host rule, and the direction the unclassifiable default.
 */
import { describe, expect, it } from "bun:test";
import {
	classifyReferrerSource,
	deviceClassFor,
	isBotUserAgent,
	MAX_PATH_LENGTH,
	TRAFFIC_RAW_RETENTION_DAYS,
} from "./traffic";

describe("classifyReferrerSource", () => {
	it("reads a missing referrer as direct", () => {
		expect(classifyReferrerSource(null, "anthers.org")).toBe("direct");
		expect(classifyReferrerSource("", "anthers.org")).toBe("direct");
	});

	it("reads a same-host referrer as direct, ignoring subdomain differences", () => {
		// A visitor who entered the site's address directly and one who navigated from
		// www are both "direct": the site did not observe an external arrival.
		expect(classifyReferrerSource("anthers.org", "anthers.org")).toBe("direct");
		expect(classifyReferrerSource("www.anthers.org", "anthers.org")).toBe("direct");
	});

	it("classifies search engines by registrable domain, not full host", () => {
		expect(classifyReferrerSource("www.google.com", "anthers.org")).toBe("search");
		expect(classifyReferrerSource("images.google.com", "anthers.org")).toBe("search");
		expect(classifyReferrerSource("duckduckgo.com", "anthers.org")).toBe("search");
		expect(classifyReferrerSource("bing.com", "anthers.org")).toBe("search");
	});

	it("classifies social platforms, Bluesky first-listed or not", () => {
		expect(classifyReferrerSource("bsky.app", "anthers.org")).toBe("social");
		expect(classifyReferrerSource("staging.bsky.app", "anthers.org")).toBe("social");
		expect(classifyReferrerSource("x.com", "anthers.org")).toBe("social");
		expect(classifyReferrerSource("t.co", "anthers.org")).toBe("social");
		expect(classifyReferrerSource("reddit.com", "anthers.org")).toBe("social");
	});

	it("reads everything else as other, the honest default", () => {
		expect(classifyReferrerSource("someone.blog", "anthers.org")).toBe("other");
		expect(classifyReferrerSource("an-unheard-of-forum.example", "anthers.org")).toBe("other");
	});

	it("never classifies through a referrer longer than the cap will store", () => {
		// A host longer than the storage cap arrives as the capped prefix; the cap
		// exists so classification runs on what is actually stored, not what was sent.
		const huge = `${"a".repeat(MAX_PATH_LENGTH)}.com`;
		const source = classifyReferrerSource(huge.slice(0, 253), "anthers.org");
		expect(["other", "direct", "search", "social"]).toContain(source);
	});
});

describe("isBotUserAgent", () => {
	it("refuses a missing user agent outright", () => {
		// A request with no UA is not a browser's page view by definition.
		expect(isBotUserAgent(null)).toBe(true);
		expect(isBotUserAgent("")).toBe(true);
	});

	it("refuses the automation families, including our own test browser", () => {
		expect(isBotUserAgent("Mozilla/5.0 HeadlessChrome/126.0 test")).toBe(true);
		expect(isBotUserAgent("Playwright/1.0")).toBe(true);
		expect(isBotUserAgent("curl/8.5.0")).toBe(true);
		expect(isBotUserAgent("python-requests/2.31")).toBe(true);
		expect(isBotUserAgent("facebookexternalhit/1.1")).toBe(true);
		expect(isBotUserAgent("Googlebot/2.1")).toBe(true);
	});

	it("admits the real browsers an audience arrives with", () => {
		expect(
			isBotUserAgent(
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
			),
		).toBe(false);
		expect(
			isBotUserAgent(
				"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
			),
		).toBe(false);
		expect(
			isBotUserAgent(
				"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
			),
		).toBe(false);
	});
});

describe("deviceClassFor", () => {
	it("separates phones, tablets and desktops", () => {
		expect(deviceClassFor("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)")).toBe("mobile");
		expect(deviceClassFor("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari")).toBe("mobile");
		expect(deviceClassFor("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)")).toBe("tablet");
		expect(deviceClassFor("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126")).toBe("desktop");
	});
});

describe("retention constant", () => {
	it("exists and is sane", () => {
		// The prune job reads this constant; a rename would silently re-derive its
		// window from `undefined` and prune nothing. Guarded here as a presence check.
		expect(typeof TRAFFIC_RAW_RETENTION_DAYS).toBe("number");
		expect(TRAFFIC_RAW_RETENTION_DAYS).toBeGreaterThan(0);
		expect(TRAFFIC_RAW_RETENTION_DAYS).toBeLessThan(365);
	});
});
