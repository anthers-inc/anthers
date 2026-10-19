// SPDX-License-Identifier: Apache-2.0
/**
 * The build-path rules both ends of the pipeline run, and the per-file ceiling.
 *
 * 🚨 **These are the strings that become storage keys and delivery URLs**, so every
 * refusal here is a path that can neither escape a creator's build prefix nor mean two
 * different things at upload time and at serve time. A literal `%` is the one that used
 * to slip through: the route's own copy did not refuse it, and the delivery half decoded
 * it, so the file registered under one string and was never served under another.
 */
import { describe, expect, it } from "bun:test";
import { buildPathProblem, WEB_BUILD_FILE_MAX } from "./web-build";

describe("buildPathProblem", () => {
	const bad: [string, string][] = [
		["", "empty"],
		["/abs.html", "leading slash"],
		["a/../b.js", "dot-dot climb"],
		["./a.js", "dot segment"],
		["dir\\win.js", "backslash"],
		["a?b.js", "question mark"],
		["a#b.js", "fragment"],
		["a%2Fb.js", "percent"],
		["a/%2e%2e/b.js", "encoded climb"],
		["a//b.js", "empty segment"],
		["trailing/", "trailing slash"],
		["\0x.js", "NUL"],
		[`${"a".repeat(251)}.js`, "too long"],
	];
	for (const [path, why] of bad) {
		it(`refuses ${why}`, () => {
			expect(buildPathProblem(path)).not.toBeNull();
		});
	}

	it("accepts a build's own relative paths", () => {
		expect(buildPathProblem("index.html")).toBeNull();
		expect(buildPathProblem("assets/logo.png")).toBeNull();
		expect(buildPathProblem("game/index.audio.worklet.js")).toBeNull();
	});
});

describe("WEB_BUILD_FILE_MAX", () => {
	it("is the 500 MB a single build file may carry", () => {
		expect(WEB_BUILD_FILE_MAX).toBe(500 * 1024 * 1024);
	});
});
