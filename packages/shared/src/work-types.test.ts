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
	deliverableIsEmpty,
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

describe("deliverableIsEmpty", () => {
	/**
	 * The emptiness question the editor's silhouette and the user's Record both ask (the
	 * preview task, 2026-10-17 — the Record had no answer at all and rendered nothing).
	 * The store kinds are never empty: their buying panel renders whatever is in stock.
	 */
	test("the played kinds are answered by what plays, never by the stored key", () => {
		// The meter-spent payload's own shape (the gauntlet's red caught this as a wall
		// replaced by the silhouette): the key blanked by policy while the playable
		// address survives, so the player can mount and draw its own wall.
		expect(
			deliverableIsEmpty({
				type: "video",
				sourceKey: "",
				originalUrl: "/api/content/works/1/original",
			}),
		).toBe(false);
		expect(deliverableIsEmpty({ type: "video" })).toBe(true);
		expect(
			deliverableIsEmpty({ type: "music", originalUrl: "/api/content/works/1/original" }),
		).toBe(false);
		expect(deliverableIsEmpty({ type: "audio", transcoding: { outputFileUrl: "/x.mp3" } })).toBe(
			false,
		);
		expect(deliverableIsEmpty({ type: "audio" })).toBe(true);
	});

	test("the picture and the book kinds are answered by their key", () => {
		for (const type of ["image", "comic", "ebook"]) {
			expect(deliverableIsEmpty({ type })).toBe(true);
			expect(deliverableIsEmpty({ type, sourceKey: "creators/4/file.pdf" })).toBe(false);
		}
	});

	test("a store kind is never empty", () => {
		expect(deliverableIsEmpty({ type: "physical" })).toBe(false);
		expect(deliverableIsEmpty({ type: "service" })).toBe(false);
	});

	test("a piece of writing is its body, an image aside — the markup counts until set aside", () => {
		expect(deliverableIsEmpty({ type: "text" })).toBe(true);
		expect(deliverableIsEmpty({ type: "text", bodyHtml: "  " })).toBe(true);
		expect(deliverableIsEmpty({ type: "text", bodyHtml: "<p>Something.</p>" })).toBe(false);
		// An image's markup is the same rule's answer: a picture in the prose fills it.
		expect(deliverableIsEmpty({ type: "text", bodyHtml: "<img src='/x'>" })).toBe(false);
	});

	test("a build kind is its embed, its builds, or its hosted build", () => {
		expect(deliverableIsEmpty({ type: "game" })).toBe(true);
		expect(deliverableIsEmpty({ type: "game", embedUrl: "https://example.itch.io/x" })).toBe(false);
		expect(deliverableIsEmpty({ type: "game", assets: [{ id: 1 }] })).toBe(false);
		expect(deliverableIsEmpty({ type: "software", webPlayable: true })).toBe(false);
	});
});
