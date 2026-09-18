// SPDX-License-Identifier: Apache-2.0
/** Which Studio tab a page belongs to, so the sidebar says where the creator is. */
import { describe, expect, it } from "bun:test";
import { isStudioNavActive, STUDIO_NAV } from "./studio-nav";

const active = (pathname: string) =>
	STUDIO_NAV.filter((item) => isStudioNavActive(item, pathname)).map((item) => item.label);

describe("isStudioNavActive", () => {
	it("marks exactly one tab on each Studio page", () => {
		expect(active("/studio")).toEqual(["Dashboard"]);
		expect(active("/studio/catalog")).toEqual(["Catalog"]);
		expect(active("/studio/posts")).toEqual(["Posts"]);
		expect(active("/studio/analytics")).toEqual(["Analytics"]);
		expect(active("/studio/settings")).toEqual(["Settings"]);
	});

	it("counts an object's own pages as its tab's", () => {
		expect(active("/studio/works/new")).toEqual(["Catalog"]);
		expect(active("/studio/works/123456789/edit")).toEqual(["Catalog"]);
		expect(active("/studio/projects/an-album/edit")).toEqual(["Catalog"]);
		expect(active("/studio/posts/a-post/edit")).toEqual(["Posts"]);
	});
});
