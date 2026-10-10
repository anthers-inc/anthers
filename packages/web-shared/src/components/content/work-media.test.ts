// SPDX-License-Identifier: Apache-2.0
/**
 * The file caps a Work's picker offers, because a cap nobody asserts is a cap that drifts.
 *
 * 🚨 **Each number is a claim about the pipeline behind the medium, not a UI preference** —
 * the reasoning lives on `fileRules` itself. This suite fails when somebody edits a cap
 * without revisiting that arithmetic: a PDF raising past 2 GB breaks the rasterize job's
 * disk budget (`apps/api/src/jobs/rasterize-ebook.ts` on App Platform's 4 GiB ephemeral
 * filesystem), and the image cap past 20 MB puts a full-size upload through the in-memory
 * direct route (`POST /api/content/media-upload/direct`). Change a number here only after
 * changing the constraint it encodes.
 */
import { describe, expect, it } from "bun:test";
import { fileRules } from "./work-media";

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

describe("fileRules", () => {
	it("caps every file Work type within what its processing pipeline tolerates", () => {
		expect(fileRules("video").maxSize).toBe(2 * GB);
		expect(fileRules("music").maxSize).toBe(500 * MB);
		expect(fileRules("audio").maxSize).toBe(500 * MB);
		expect(fileRules("image").maxSize).toBe(20 * MB);
		// Books and comics: bounded by the rasterize job's disk budget, not by R2.
		expect(fileRules("comic").maxSize).toBe(2 * GB);
		expect(fileRules("ebook").maxSize).toBe(2 * GB);
	});

	it("accepts the 2026-10-10 upload that motivated the caps surviving their current values", () => {
		// A real Kindle re-export of a graphic novel — the smallest file a serious
		// comic pipeline produces must fit under the cap the picker enforces.
		expect(fileRules("comic").maxSize).toBeGreaterThanOrEqual(1.5 * GB);
	});

	it("takes PDFs for paged kinds and nothing else", () => {
		expect(fileRules("comic").accept).toBe("application/pdf");
		expect(fileRules("ebook").accept).toBe("application/pdf");
		expect(fileRules("video").accept).toBe("video/*");
		expect(fileRules("audio").accept).toBe("audio/*");
		expect(fileRules("image").accept).toBe("image/*");
	});
});
