// SPDX-License-Identifier: Apache-2.0
/**
 * The rules a browser build's files obey, in one place because both ends of the pipeline
 * run them: the upload route validates every path before it becomes a storage key, and the
 * delivery route re-runs the same check before it serves one. A path that could escape a
 * build can therefore neither be registered nor resolve.
 *
 * They live in the shared package rather than the API because the Studio's pickers need
 * the same answer before a creator spends an upload on a name the server would refuse —
 * and because the route once carried its own weaker copy, so a `%` reached storage that
 * the delivery half would then never serve. One function, imported, is the fix.
 */

/**
 * How large a single build file may be. The cap is the transport's own bound (one
 * presigned PUT, no multipart), and it belongs in creator-facing copy as well as in the
 * route — a failure at the end of a long upload is the worst place to learn it.
 */
export const WEB_BUILD_FILE_MAX = 500 * 1024 * 1024;

/**
 * What is wrong with a build-relative path, or null when it is fine.
 *
 * 🚨 **A literal `%` is refused** because `isOwnStorageRef` and the serve path both meet
 * percent-encoding between this string and a URL: a stored `a%2Fb.js` decodes to two
 * segments at request time, and the two ends of the pipeline then disagree about which
 * string the file lives under. Refusing keeps the stored path and the requested path the
 * same string, always.
 */
export function buildPathProblem(value: string): string | null {
	if (value === "") return "Every file needs a name saying where it sits in the build.";
	if (value.startsWith("/") || value.endsWith("/")) {
		return "Paths are relative to the build's root, without leading or trailing slashes.";
	}
	if (value.includes("\\")) return "Paths use forward slashes.";
	if (value.includes("\0")) return "That path contains a character file names cannot carry.";
	if (value.includes("%")) return "Paths cannot carry a % sign.";
	const parts = value.split("/");
	if (parts.some((p) => p === "" || p === "." || p === "..")) {
		return "A path in a build cannot climb out of the build with .. or name an empty segment.";
	}
	if (parts.some((p) => p.includes("?") || p.includes("#"))) {
		return "A path in a build cannot carry ? or # — the browser cuts the URL at them.";
	}
	if (value.length > 250) return "That path is too long.";
	return null;
}
