// SPDX-License-Identifier: Apache-2.0
/**
 * Turning what a creator picks on the Upload page into the file list a hosted build is:
 * a folder of an engine export, or a `.zip` of that folder.
 *
 * 🚨 **Both sources end in the same shape.** A build is a list of relative paths and the
 * HTML entry the browser loads first; a zip cannot become one object, because delivery
 * resolves every request against `work_build_files` and serves the file the path names.
 * So a zip is unpacked here, in the browser, into the same `path` + bytes pairs a
 * directory pick produces, and the same presign/register/complete ceremony carries it.
 * The archive itself is never uploaded.
 *
 * ⚠️ **The path rule is the server's, imported rather than restated.** A zip is the one
 * source that can carry a path the picker never saw (`../`, an absolute name, a `%`), and
 * refusing it here turns a long upload's failure at the end into a sentence before it
 * starts. The same strings are refused again at the route.
 *
 * `formatBuildFileSize` lives here too because the picker, the upload progress and the
 * build list all read one size the same way.
 */

import { buildPathProblem, WEB_BUILD_FILE_MAX } from "@anthers/shared/web-build";
import { unzipSync } from "fflate";

/** One file of a build, with the path it will be served under. */
export interface WebBuildSourceFile {
	/** Relative to the build's root, forward slashes, as the export wrote it. */
	path: string;
	file: File;
}

/** What one pick yields: the files, the guessed entry, and a name for the Work. */
export interface WebBuildPick {
	/** A folder's own name, or a zip's name without its extension — the Work's title if none was typed. */
	name: string;
	source: "folder" | "zip";
	files: WebBuildSourceFile[];
	/** The HTML file the build loads first, guessed from the pick; empty when there is none. */
	entryPath: string;
}

/** What the browser's directory pick puts on each File; a plain pick leaves it empty. */
type DirectoryFile = File & { webkitRelativePath?: string };

/** A size as a creator reads it, used by every build surface. */
export function formatBuildFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** The entry a build most likely loads first: a root `index.html`, then the shallowest one. */
export function guessBuildEntry(paths: string[]): string {
	const depth = (p: string) => p.split("/").length;
	const byShallowness = (a: string, b: string) => depth(a) - depth(b) || a.localeCompare(b);
	const html = paths.filter((p) => /\.html?$/i.test(p)).sort(byShallowness);
	if (html.length === 0) return "";
	const root = html.find((p) => p.toLowerCase() === "index.html");
	if (root) return root;
	const index = html.find((p) => /(^|\/)index\.html?$/i.test(p));
	return index ?? html[0];
}

/**
 * A folder's name — the top segment a directory pick puts on every path, or the first
 * file's own stem when the pick carried no directory path.
 */
function folderName(paths: string[]): string {
	if (paths.length > 0 && paths.every((p) => p.includes("/"))) {
		const tops = new Set(paths.map((p) => p.split("/")[0]));
		if (tops.size === 1) return [...tops][0];
	}
	const stem = paths[0]?.split("/").pop() ?? "";
	const dot = stem.lastIndexOf(".");
	return (dot > 0 ? stem.slice(0, dot) : stem) || "Web build";
}

/** A zip's name without its `.zip` — the Work's fallback title. */
function zipName(fileName: string): string {
	const dot = fileName.lastIndexOf(".");
	return (dot > 0 ? fileName.slice(0, dot) : fileName) || "Web build";
}

/** Noise a desktop archiver adds that is not part of the build. */
function isArchiveNoise(path: string): boolean {
	const base = path.split("/").pop() ?? path;
	return path.startsWith("__MACOSX/") || base === ".DS_Store" || base === "Thumbs.db";
}

/** The cap as the copy says it — a whole number, where a file's own size carries a decimal. */
const BUILD_FILE_MAX_LABEL = `${WEB_BUILD_FILE_MAX / (1024 * 1024)} MB`;

/** Refuse a pick whose paths or sizes the server would refuse, before it starts. */
function checkPick(files: WebBuildSourceFile[], source: "folder" | "zip"): void {
	if (files.length === 0) {
		throw new Error(
			source === "zip"
				? "That zip is empty. A build needs at least its entry file and the files beside it."
				: "That folder is empty. Choose the folder the engine's export wrote.",
		);
	}
	// The register route takes at most 1,000 files; refusing here names the number before the
	// bytes start rather than at the end of an upload the server would discard.
	if (files.length > 1000) {
		throw new Error(
			`That build has ${files.length} files, and a build registers at most 1,000. Remove what the export doesn't need and try again.`,
		);
	}
	for (const { path, file } of files) {
		const problem = buildPathProblem(path);
		if (problem) throw new Error(`${path} can't be part of a build: ${problem}`);
		if (file.size > WEB_BUILD_FILE_MAX) {
			throw new Error(
				`${path} is ${formatBuildFileSize(file.size)} — over the ${BUILD_FILE_MAX_LABEL} a build file may carry.`,
			);
		}
	}
	const entry = guessBuildEntry(files.map((f) => f.path));
	if (!entry) {
		throw new Error(
			"That build has no HTML file in it, so there is nothing for a browser to open. A build needs an entry file — usually index.html.",
		);
	}
}

/**
 * Read a directory pick into a build. Paths keep the folder's own name, exactly as the
 * existing Hosted Build lane has always stored them, so the entry and every relative
 * reference resolve the same way.
 */
export function pickBuildFolder(files: File[]): WebBuildPick {
	const picked: WebBuildSourceFile[] = files
		.map((file) => ({ path: (file as DirectoryFile).webkitRelativePath || file.name, file }))
		.filter((f) => !isArchiveNoise(f.path));
	checkPick(picked, "folder");
	return {
		name: folderName(picked.map((f) => f.path)),
		source: "folder",
		files: picked,
		entryPath: guessBuildEntry(picked.map((f) => f.path)),
	};
}

/**
 * Unpack a zip into a build. The archive's own directory entries are dropped (only files
 * are registered), desktop-archiver noise is dropped, and every remaining path runs the
 * build rule before any bytes go up.
 */
export async function pickBuildZip(file: File): Promise<WebBuildPick> {
	if (file.size > WEB_BUILD_FILE_MAX) {
		throw new Error(
			`That zip is ${formatBuildFileSize(file.size)} — over the ${BUILD_FILE_MAX_LABEL} a build file may carry. Export the folder and choose it directly instead.`,
		);
	}
	const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
		// The filter runs before an entry is inflated, so an oversized file is refused
		// without its bytes ever reaching memory. Directory entries and desktop-archiver
		// noise are dropped here rather than registered as files of the build.
		filter: (entry) => {
			if (entry.name.endsWith("/") || isArchiveNoise(entry.name)) return false;
			if (entry.originalSize > WEB_BUILD_FILE_MAX) {
				throw new Error(
					`${entry.name} is ${formatBuildFileSize(entry.originalSize)} — over the ${BUILD_FILE_MAX_LABEL} a build file may carry.`,
				);
			}
			return true;
		},
	});
	const picked: WebBuildSourceFile[] = [];
	for (const [path, bytes] of Object.entries(entries)) {
		picked.push({
			path,
			file: new File([bytes], path, { type: "application/octet-stream" }),
		});
	}
	checkPick(picked, "zip");
	return {
		name: zipName(file.name),
		source: "zip",
		files: picked,
		entryPath: guessBuildEntry(picked.map((f) => f.path)),
	};
}
