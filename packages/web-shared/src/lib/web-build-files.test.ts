// SPDX-License-Identifier: Apache-2.0
/**
 * Turning a folder pick or a `.zip` into the file list a hosted build is, before any
 * bytes go up.
 *
 * 🚨 **The zip is the source that can carry a path the picker never saw.** An archive made
 * anywhere can hold `../`, an absolute name or a `%`, and the server refuses those — but
 * discovering it after a long upload is the cost this suite exists to prevent. So the
 * refusal is asserted here, at the pick, and the entry guess is pinned for the shapes an
 * engine export actually has (a root `index.html`, or a folder's own `web/index.html`).
 */
import { describe, expect, it } from "bun:test";
import { WEB_BUILD_FILE_MAX } from "@anthers/shared/web-build";
import { strToU8, zipSync } from "fflate";
import {
	formatBuildFileSize,
	guessBuildEntry,
	pickBuildFolder,
	pickBuildZip,
} from "./web-build-files";

/** A File the way a directory pick presents it: its build-relative path on `webkitRelativePath`. */
function directoryFile(path: string, bytes = "bytes"): File {
	const file = new File([bytes], path.split("/").pop() ?? path);
	Object.defineProperty(file, "webkitRelativePath", { value: path });
	return file;
}

function zipFile(entries: Record<string, Uint8Array>, name = "game.zip"): File {
	return new File([zipSync(entries)], name, { type: "application/zip" });
}

describe("guessBuildEntry", () => {
	it("takes a root index.html first", () => {
		expect(guessBuildEntry(["assets/logo.png", "index.html", "index.js"])).toBe("index.html");
	});

	it("takes a folder's own index.html when the pick kept the folder name", () => {
		expect(guessBuildEntry(["web/index.js", "web/index.html", "web/index.pck"])).toBe(
			"web/index.html",
		);
	});

	it("takes the shallowest html when there is no index", () => {
		expect(guessBuildEntry(["deep/a/start.html", "start.html", "deep/b.html"])).toBe("start.html");
	});

	it("returns nothing when the build carries no html at all", () => {
		expect(guessBuildEntry(["game.pck", "engine.wasm"])).toBe("");
	});
});

describe("pickBuildFolder", () => {
	it("keeps the folder's own paths, names the Work after it, and guesses its entry", () => {
		const pick = pickBuildFolder([
			directoryFile("web/index.html", "<html></html>"),
			directoryFile("web/index.js"),
			directoryFile("web/index.wasm"),
			directoryFile("web/index.pck"),
			directoryFile("web/index.audio.worklet.js"),
		]);
		expect(pick.source).toBe("folder");
		expect(pick.name).toBe("web");
		expect(pick.entryPath).toBe("web/index.html");
		expect(pick.files.map((f) => f.path)).toEqual([
			"web/index.html",
			"web/index.js",
			"web/index.wasm",
			"web/index.pck",
			"web/index.audio.worklet.js",
		]);
	});

	it("refuses a folder with no html entry", () => {
		expect(() => pickBuildFolder([directoryFile("web/game.pck")])).toThrow(/no HTML file/);
	});

	it("refuses a build file over the per-file ceiling before the upload starts", () => {
		const oversized = {
			name: "web/index.html",
			size: WEB_BUILD_FILE_MAX + 1,
			webkitRelativePath: "web/index.html",
		} as unknown as File;
		expect(() => pickBuildFolder([oversized])).toThrow(/over the 500 MB/);
	});
});

describe("pickBuildZip", () => {
	it("unpacks the archive into the same path list a folder pick produces", async () => {
		const pick = await pickBuildZip(
			zipFile(
				{
					"web/index.html": strToU8("<html></html>"),
					"web/index.js": strToU8("boot()"),
					"web/index.wasm": new Uint8Array([0, 97, 115, 109]),
					"web/index.pck": new Uint8Array([1, 2, 3]),
					"web/index.icon.png": new Uint8Array([4, 5]),
				},
				"anarkey-web.zip",
			),
		);
		expect(pick.source).toBe("zip");
		expect(pick.name).toBe("anarkey-web");
		expect(pick.entryPath).toBe("web/index.html");
		expect(pick.files.map((f) => f.path)).toEqual([
			"web/index.html",
			"web/index.js",
			"web/index.wasm",
			"web/index.pck",
			"web/index.icon.png",
		]);
		// The bytes survive the trip: a build's file is its bytes, not its name.
		expect(await pick.files[1].file.text()).toBe("boot()");
	});

	it("drops the archiver's own directory entries and noise", async () => {
		const pick = await pickBuildZip(
			zipFile({
				"web/": new Uint8Array(),
				"web/index.html": strToU8("<html></html>"),
				"__MACOSX/web/._index.html": new Uint8Array([9]),
				"web/.DS_Store": new Uint8Array([8]),
			}),
		);
		expect(pick.files.map((f) => f.path)).toEqual(["web/index.html"]);
	});

	it("refuses an archive whose entry path would escape the build", async () => {
		await expect(
			pickBuildZip(
				zipFile({
					"../evil.html": strToU8("<html></html>"),
					"index.html": strToU8("<html></html>"),
				}),
			),
		).rejects.toThrow(/can't be part of a build/);
	});

	it("refuses an archive with no html entry", async () => {
		await expect(pickBuildZip(zipFile({ "game.pck": new Uint8Array([1]) }))).rejects.toThrow(
			/no HTML file/,
		);
	});
});

describe("formatBuildFileSize", () => {
	it("reads a build file's size the way the picker and the list state it", () => {
		expect(formatBuildFileSize(500)).toBe("500 B");
		expect(formatBuildFileSize(1024 * 1024)).toBe("1.0 MB");
		expect(formatBuildFileSize(WEB_BUILD_FILE_MAX)).toBe("500.0 MB");
	});
});
