// SPDX-License-Identifier: Apache-2.0
/**
 * The two lists have to stay one list.
 *
 * `page-meta.ts` decides what a card and a sitemap name; `standing-pages.tsx` decides what
 * a reader without JavaScript is handed. They are separate files because `serve.ts` imports
 * one of them and must not import React, so nothing but this test keeps them equal — and a
 * page that drifted out of step would fail in production as a document with no body, which
 * is the silence this whole change exists to end.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { indexablePaths } from "../lib/page-meta";
import { renderStandingPages } from "../lib/render-standing-pages";
import { STANDING_PAGES } from "./standing-pages";

/** What a reader sees: tags gone, whitespace collapsed. */
function text(html: string): string {
	return html
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

let bodies: Record<string, string>;

beforeAll(() => {
	bodies = renderStandingPages();
});

describe("the standing pages", () => {
	it("are exactly the pages the sitemap names", () => {
		expect(Object.keys(STANDING_PAGES).sort()).toEqual(indexablePaths().sort());
	});

	it("each carry a body a reader can read", () => {
		for (const path of indexablePaths()) {
			// `/status` is one hand-written sentence, because its own answers are live.
			const floor = path === "/status" ? 100 : 1000;
			expect(text(bodies[path] ?? "").length).toBeGreaterThan(floor);
		}
	});

	it("carry no control that needs the bundle behind it", () => {
		for (const [path, body] of Object.entries(bodies)) {
			expect(`${path}: ${body}`).not.toMatch(/<(?:input|select|textarea|button)\b/i);
		}
	});

	it("sends a reader without JavaScript to the standalone status page", () => {
		expect(bodies["/status"]).toContain("status.anthers.org");
	});
});
