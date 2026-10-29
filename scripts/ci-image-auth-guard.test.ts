// SPDX-License-Identifier: Apache-2.0
/**
 * Every image these workflows pull is pulled authenticated.
 *
 * 🚨 **Anonymous pulls are a merge outage, not a warning.** GitHub-hosted runners share
 * their egress addresses, so they contend for Docker Hub's per-IP allowance; on 2026-10-09
 * it ran out and every job that needed a container died at *Initialize containers* with
 * `429 Too Many Requests`, which red-gated every open pull request until the window cleared
 * hours later. Adding credentials is therefore a correctness rule, and the way it regresses
 * is silent: someone adds a service block, copies the two lines around it, and skips the
 * `credentials:` — the workflow still validates, still runs locally in a way nobody tests,
 * and the next rate-limit window takes the whole board down again.
 *
 * ⭐ **A source scan rather than a live pull**, for the same reason `fixture-hygiene.test.ts`
 * scans instead of counting rows: what matters is whether the file names credentials, and
 * that question is answerable without a runner, a secret or a network.
 *
 * Service containers are pulled before any step runs, so `docker/login-action` cannot reach
 * them — which is why the requirement is a `credentials:` on the image itself and a login
 * step only in the jobs that build one.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = join(import.meta.dir, "..", ".github", "workflows");

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

/**
 * Every `image:` in the file that has no `credentials:` beside it.
 *
 * The sibling key sits at the same indent as `image:`, and the mapping ends at the first
 * line indented less than that — which is what keeps one service's credentials from
 * vouching for the next service's image.
 */
function unauthenticatedImages(source: string): string[] {
	const lines = source.split("\n");
	const missing: string[] = [];
	for (const [index, line] of lines.entries()) {
		if (!/^\s+image:\s*\S+\s*$/.test(line)) continue;
		const keyIndent = indentOf(line);
		let authenticated = false;
		for (let next = index + 1; next < lines.length; next += 1) {
			const candidate = lines[next] ?? "";
			if (candidate.trim() === "") continue;
			if (indentOf(candidate) < keyIndent) break;
			if (indentOf(candidate) === keyIndent && /^credentials:\s*$/.test(candidate.trim())) {
				authenticated = true;
				break;
			}
		}
		if (!authenticated) missing.push(`line ${index + 1}: ${line.trim()}`);
	}
	return missing;
}

function read(name: string): string {
	return readFileSync(join(WORKFLOWS, name), "utf8");
}

describe("CI's image pulls", () => {
	it("finds the images this repository's CI actually pulls", () => {
		// Without this, a restructured workflow makes every assertion below pass over an
		// empty list — the scan equivalent of a green suite that tested nothing.
		const images = read("ci.yml")
			.split("\n")
			.filter((line) => /^\s+image:\s*\S+\s*$/.test(line));
		expect(images.length).toBe(7);
	});

	it("names credentials on every image ci.yml pulls", () => {
		expect(unauthenticatedImages(read("ci.yml"))).toEqual([]);
	});

	it("names credentials on every image ci-image.yml pulls", () => {
		expect(unauthenticatedImages(read("ci-image.yml"))).toEqual([]);
	});

	it("logs in to Docker Hub before every image build", () => {
		for (const name of ["ci.yml", "ci-image.yml"]) {
			const source = read(name);
			expect(source).toContain("docker/build-push-action");
			expect(source).toContain("username: ${{ secrets.DOCKERHUB_USERNAME }}");
			expect(source).toContain("password: ${{ secrets.DOCKERHUB_TOKEN }}");
		}
	});
});
