// SPDX-License-Identifier: Apache-2.0
/**
 * The Work types and the groupings that decide how each is handled.
 *
 * `comic` and `music` were added beside `ebook` and `audio` on 2026-09-18, and everything
 * downstream of an upload reaches them only through these groupings, so a type missing from one
 * uploads a file that nothing processes or a player that never opens.
 */

import { describe, expect, test } from "bun:test";
import {
	FILE_WORK_TYPES,
	isListened,
	isPaged,
	processingFor,
	WORK_TYPES,
	workNeedsFile,
} from "./content.js";

describe("the Work types", () => {
	test("music and other audio are listened to, and share one pipeline", () => {
		expect(WORK_TYPES.filter(isListened)).toEqual(["music", "audio"]);
		expect(processingFor("music")).toBe("audio");
		expect(processingFor("audio")).toBe("audio");
	});

	test("comics and other books are read by the page, and share one pipeline", () => {
		expect(WORK_TYPES.filter(isPaged)).toEqual(["comic", "ebook"]);
		expect(processingFor("comic")).toBe("ebook");
		expect(processingFor("ebook")).toBe("ebook");
	});

	test("every kind that is its file is processed, except an image, which is used as uploaded", () => {
		for (const type of FILE_WORK_TYPES) {
			expect(workNeedsFile(type)).toBe(true);
			if (type === "image") expect(processingFor(type)).toBeNull();
			else expect(processingFor(type)).not.toBeNull();
		}
	});

	test("a kind with no file is never processed", () => {
		const fileless = WORK_TYPES.filter((t) => !workNeedsFile(t));
		expect(fileless).toEqual(["text", "game", "software", "physical", "service"]);
		for (const type of fileless) expect(processingFor(type)).toBeNull();
	});
});
