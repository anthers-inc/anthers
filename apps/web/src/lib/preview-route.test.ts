// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { previewRoute } from "./preview-route.js";

describe("previewRoute", () => {
	it("names the Work a work page is about, with its canonical path", () => {
		expect(previewRoute("/works/a-quiet-year-12")).toEqual({
			kind: "work",
			param: "a-quiet-year-12",
			canonicalPath: "/works/a-quiet-year-12",
		});
	});

	it("takes a slug without its public id, which the card endpoint also resolves", () => {
		expect(previewRoute("/works/the-crash")).toEqual({
			kind: "work",
			param: "the-crash",
			canonicalPath: "/works/the-crash",
		});
	});

	it("drops a trailing slash from the canonical path rather than carrying it", () => {
		expect(previewRoute("/works/the-crash/")).toEqual({
			kind: "work",
			param: "the-crash",
			canonicalPath: "/works/the-crash",
		});
	});

	it("reads a share link's token, because that is the address a sharer pastes", () => {
		expect(previewRoute("/s/8367cc846696bd9cd5abef363e3b6fd1")).toEqual({
			kind: "share",
			token: "8367cc846696bd9cd5abef363e3b6fd1",
		});
	});

	it("reads the embed shape's token, which is the same token in a second rendering", () => {
		expect(previewRoute("/embed/8367cc846696bd9cd5abef363e3b6fd1")).toEqual({
			kind: "share",
			token: "8367cc846696bd9cd5abef363e3b6fd1",
		});
	});

	it("tolerates a trailing slash on a share link", () => {
		expect(previewRoute("/s/abc123/")).toEqual({ kind: "share", token: "abc123" });
	});

	it("leaves every other document route alone", () => {
		for (const pathname of [
			"/",
			"/for-creators",
			"/about",
			"/posts/hello-there-534000269",
			"/@parkerhdavis.com",
			"/release-notes",
		]) {
			expect(previewRoute(pathname)).toBeNull();
		}
	});

	it("does not match a prefix or a deeper path, which would name something else", () => {
		for (const pathname of [
			"/works",
			"/works/",
			"/works/a/b",
			"/s",
			"/s/",
			"/s/tok/extra",
			"/share/tok",
			"/embedding/tok",
		]) {
			expect(previewRoute(pathname)).toBeNull();
		}
	});
});
