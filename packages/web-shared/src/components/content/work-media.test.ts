// SPDX-License-Identifier: Apache-2.0
/**
 * The file caps a Work's picker offers, because a cap nobody asserts is a cap that drifts.
 *
 * 🚨 **Each number is a claim about the pipeline behind the medium, not a UI preference** —
 * the reasoning lives on `fileRules` itself. This suite fails when somebody edits a cap
 * without revisiting that arithmetic: a PDF raising past 2 GB breaks the rasterize job's
 * disk budget (`apps/api/src/jobs/render-paged.ts` on App Platform's 4 GiB ephemeral
 * filesystem), and the image cap past 20 MB puts a full-size upload through the in-memory
 * direct route (`POST /api/content/media-upload/direct`). Change a number here only after
 * changing the constraint it encodes.
 */
import { describe, expect, it } from "bun:test";
import { acceptedVideoFormatsSentence } from "@anthers/shared/accepted-formats";
import { WORK_TYPES } from "@anthers/shared/content";
import { fileSizeSentence } from "../ui/FileUpload";
import { type FileWorkType, fileRules, workTypeFacts } from "./work-media";

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

	it("takes page images for a comic, and images, a PDF or an EPUB for a book", () => {
		// A comic's pages are images now (2026-10-19): the PDF is not offered, because the
		// rasterization it costs is the wait the page-image path removes.
		expect(fileRules("comic").accept).toBe("image/jpeg,image/png");
		// The ebook kind keeps the PDF and additionally takes an EPUB — the reflow path's
		// native source. The comic does not: its container formats (CBZ, EPUB 3 FXL) sit in
		// the format ladder's tail and ride their own tasks.
		expect(fileRules("ebook").accept).toBe(
			"image/jpeg,image/png,application/pdf,application/epub+zip,.epub",
		);
		expect(fileRules("video").accept).toBe("video/*");
		expect(fileRules("audio").accept).toBe("audio/*");
		expect(fileRules("image").accept).toBe("image/*");
	});

	it("states the video accepted set on the picker, as the page and the refusal state it", () => {
		// The formats sentence is the product sentence the picker, the upload page and
		// the transcode job's refusal all read; its content is pinned by the shared
		// module's own suite. Here: it is present, names the remux promise, and never
		// silently stops being said.
		const video = fileRules("video");
		expect(video.formats).toBeTruthy();
		expect(video.formats).toContain(acceptedVideoFormatsSentence());
		expect(video.formats).toContain("remuxed");
	});

	it("says audio is converted rather than refused", () => {
		expect(fileRules("audio").formats).toContain("MP3");
	});

	it("says a comic's PDF is not taken, and names the way out", () => {
		const points = workTypeFacts("comic").points.join(" ");
		expect(points).toContain("JPG or PNG page images");
		expect(points).toContain("PDF or a CBZ isn't taken");
	});
});

/**
 * The Upload page's card, which follows the kind rather than listing every kind at once.
 *
 * 🚨 **The caps are read from `fileRules` and the video set from the shared module**, so a
 * card's claim cannot drift from the pipeline it describes: a cap that moves in one place and
 * not the other fails here rather than surprising a creator at the picker.
 */
describe("workTypeFacts", () => {
	it("has a card for every Work kind, with a heading and at least one fact", () => {
		for (const type of WORK_TYPES) {
			const facts = workTypeFacts(type);
			expect(facts.heading, type).toBeTruthy();
			expect(facts.points.length, type).toBeGreaterThan(0);
			for (const point of facts.points) expect(point.trim(), type).not.toBe("");
		}
	});

	it("states each file kind's cap from the rules the picker enforces", () => {
		const fileKinds: FileWorkType[] = ["video", "music", "audio", "image", "comic", "ebook"];
		for (const type of fileKinds) {
			const points = workTypeFacts(type).points.join(" ");
			expect(points, type).toContain(fileSizeSentence(fileRules(type).maxSize));
		}
	});

	it("states the video set and the remux promise, never a widening of its own", () => {
		const video = workTypeFacts("video");
		const points = video.points.join(" ");
		expect(points).toContain(acceptedVideoFormatsSentence());
		expect(points).toContain("remuxed");
		expect(points).toContain("no audio track");
		expect(video.note).toContain("short on purpose");
	});

	it("follows the platform a build is labeled for", () => {
		const windows = workTypeFacts("game", "windows").points.join(" ");
		expect(windows).toContain(".exe");
		expect(windows).toContain(".zip");
		expect(workTypeFacts("game", "mac").points.join(" ")).toContain(".dmg");
		expect(workTypeFacts("game", "linux").points.join(" ")).toContain("AppImage");
		expect(workTypeFacts("game", "android").points.join(" ")).toContain(".apk");
		expect(workTypeFacts("game", "ios").points.join(" ")).toContain("iPhone");
		// A platform this build does not name still says something a creator can act on.
		expect(workTypeFacts("software", "unknown-platform").points.join(" ")).toContain(
			"any file people can run",
		);
	});

	it("talks about Web as the hosted build it is, not a downloadable asset", () => {
		const web = workTypeFacts("game", "web");
		const points = web.points.join(" ");
		expect(web.heading).toBe("What a browser build needs");
		expect(points).toContain("export folder");
		expect(points).toContain("index.html");
		expect(points).toContain("SharedArrayBuffer");
		expect(points).toContain(fileSizeSentence(500 * MB));
		expect(points).not.toContain("primary download");
	});

	it("names the Work's page as where a set grows", () => {
		expect(workTypeFacts("image").points.join(" ")).toContain("Work's page");
		expect(workTypeFacts("comic").points.join(" ")).toContain("set");
	});

	it("says plainly that writing, physical goods and services upload nothing", () => {
		for (const type of ["text", "physical", "service"] as const) {
			expect(workTypeFacts(type).points.join(" ")).toContain("Nothing is uploaded");
		}
	});
});
