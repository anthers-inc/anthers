// SPDX-License-Identifier: Apache-2.0
/**
 * Which Work pages may raise a presence claim.
 *
 * Presence is the evidence that somebody spent time *with a Work*, so a page that
 * renders no deliverable must raise none — otherwise opening a download-only build's
 * storefront writes a range saying a person played a Work they never started, and the
 * Time Pool pays for a page view. The API refuses the same claims at intake
 * (`workEarnsTime` in `@anthers/shared/attention`); this is the browser half.
 */
import { describe, expect, test } from "bun:test";
import { pageShowsDeliverable } from "./attention";

describe("presence claims follow the deliverable", () => {
	test("a page that mounts the medium raises one", () => {
		expect(pageShowsDeliverable({ type: "text", bodyHtml: "<p>prose</p>" })).toBe(true);
		expect(pageShowsDeliverable({ type: "image", sourceKey: "creators/1/image.png" })).toBe(true);
		expect(pageShowsDeliverable({ type: "game", webPlayable: true, webPlayPath: "inline" })).toBe(
			true,
		);
		expect(pageShowsDeliverable({ type: "software", embedUrl: "https://example.com/play" })).toBe(
			true,
		);
	});

	test("a download-only build's storefront raises none", () => {
		// Its files are the deliverable; the media area is the download card.
		expect(pageShowsDeliverable({ type: "game", assets: [{ id: 1 }] })).toBe(false);
		expect(pageShowsDeliverable({ type: "software", assets: [{ id: 1 }] })).toBe(false);
	});

	test("a build that plays on /play raises none here", () => {
		// The isolation build's tracker runs on the server-rendered page, not this one.
		expect(pageShowsDeliverable({ type: "game", webPlayable: true, webPlayPath: "page" })).toBe(
			false,
		);
	});

	test("an empty or withheld deliverable raises none", () => {
		expect(pageShowsDeliverable({ type: "text", bodyHtml: "" })).toBe(false);
		expect(pageShowsDeliverable({ type: "image" })).toBe(false);
		expect(pageShowsDeliverable({ type: "comic", sourceKey: "" })).toBe(false);
	});
});
