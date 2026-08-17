// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The API image's manifest COPY list must name every workspace, and only real ones.
//
// 🚨 **This has now failed in both directions, which is why it is a test and not a
// comment.** The Dockerfile carried `apps/studio-desktop` after that app moved to its own
// repository, so the COPY referenced a path that no longer existed and every image build
// failed. Then on 2026-08-16 `scripts` became a workspace and was *not* added, so
// `bun install --frozen-lockfile` failed with `Workspace not found "scripts"` — because
// `--frozen-lockfile` compares the lockfile against the workspaces it can actually see,
// and a missing manifest reads as "the lockfile changed".
//
// The Dockerfile already warned about exactly this, in a comment ending "Adding or
// removing a workspace means editing here too. `make verify` cannot see this: it does not
// build images." That was true and it was not enough — the warning was in the file being
// edited, and it still went past two people. `make verify` can see *this*.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const REPO = join(import.meta.dir, "..");

/** Every workspace directory the root manifest declares, expanded. */
function declaredWorkspaces(): string[] {
	const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
		workspaces: string[];
	};
	const out: string[] = [];
	for (const pattern of root.workspaces) {
		if (!pattern.includes("*")) {
			out.push(pattern);
			continue;
		}
		// `packages/*` → each child holding a package.json.
		for (const hit of new Glob(`${pattern}/package.json`).scanSync(REPO)) {
			out.push(hit.replace(/[/\\]package\.json$/, "").replace(/\\/g, "/"));
		}
	}
	return out.sort();
}

/** Every workspace directory the Dockerfile copies a manifest for. */
function copiedWorkspaces(): string[] {
	const df = readFileSync(join(REPO, "apps/api/Dockerfile"), "utf8");
	const out: string[] = [];
	for (const m of df.matchAll(/^COPY\s+(\S+)\/package\.json\s+\S+$/gm)) {
		out.push(m[1]);
	}
	return out.sort();
}

describe("the API image's workspace manifests", () => {
	test("names every workspace the root package.json declares", () => {
		const missing = declaredWorkspaces().filter((w) => !copiedWorkspaces().includes(w));
		expect(
			missing,
			`apps/api/Dockerfile is missing a COPY for: ${missing.join(", ")} — ` +
				"`bun install --frozen-lockfile` fails with `Workspace not found`",
		).toEqual([]);
	});

	test("names no workspace that no longer exists", () => {
		const stale = copiedWorkspaces().filter((w) => !declaredWorkspaces().includes(w));
		expect(
			stale,
			`apps/api/Dockerfile copies a manifest for: ${stale.join(", ")} — ` +
				"that path is not a workspace, so the COPY fails outright",
		).toEqual([]);
	});

	// Cheap, and it catches the case where someone deletes the whole block rather than
	// one line: an empty list would satisfy "no stale entries" on its own.
	test("the list is not empty", () => {
		expect(copiedWorkspaces().length).toBeGreaterThan(3);
	});
});
