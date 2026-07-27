// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The guard on this codebase's most-repeated bug: a hand-rolled API base URL.
 *
 * `rpc.ts` exists to be the ONE place the API origin and credentials are resolved, and
 * the failure mode is not that someone breaks it — it's that someone quietly writes
 * another copy. The copy always looks like `hostname === "localhost" ? ":8000" : ""`,
 * and it is always *correct in dev and on the consumer site*, which is exactly why it
 * survives review. What it silently drops is the `studio.`-stripping branch (so the
 * Studio calls its own origin and parses `index.html` as JSON), the desktop branch
 * (`tauri://localhost` resolves to the app itself), and the bearer header that the
 * desktop has instead of a cookie.
 *
 * Seven copies were found and fixed once; the seventh took a live desktop 401 to
 * notice. Eight more were found in `apps/web` after that. This test is the "so the
 * ninth copy can't be written" half — a sweep alone has already been done twice and
 * did not hold.
 *
 * A grep-shaped test rather than a lint rule because the rule is about a *value*
 * appearing anywhere in client code, which is what makes it cheap to state here and
 * awkward to express as an AST pattern. If it ever needs to allow a new file, add it
 * to `ALLOWED` with a reason — the point is that the exception is deliberate and
 * reviewed, not that the pattern is impossible.
 */
import { describe, expect, it } from "bun:test";
import { join, relative, resolve } from "node:path";
import { Glob } from "bun";

const REPO = resolve(import.meta.dir, "../../../..");

/** Client source trees. The API and scripts legitimately talk about ports. */
const ROOTS = ["apps/web/src", "apps/studio-web/src", "packages/web-shared/src"];

/** The single legitimate resolver. */
const ALLOWED = new Set(["packages/web-shared/src/lib/rpc.ts"]);

/**
 * Both halves of the anti-pattern. The literal catches the common shape; the hostname
 * comparison catches a copy that moved the port into a variable or an env var.
 */
const FORBIDDEN: Array<{ pattern: RegExp; what: string }> = [
	{ pattern: /"http:\/\/localhost:8000"/, what: "a hard-coded dev API origin" },
	{
		pattern: /(?:location|window\.location)\.hostname\s*===\s*["']localhost["']/,
		what: "a hand-rolled hostname sniff",
	},
];

async function offendingFiles() {
	const hits: string[] = [];
	for (const root of ROOTS) {
		const glob = new Glob("**/*.{ts,tsx}");
		for await (const file of glob.scan({ cwd: join(REPO, root), absolute: true })) {
			const rel = relative(REPO, file);
			if (ALLOWED.has(rel) || rel.endsWith(".test.ts")) continue;
			const text = await Bun.file(file).text();
			for (const { pattern, what } of FORBIDDEN) {
				if (pattern.test(text)) hits.push(`${rel} — ${what}`);
			}
		}
	}
	return hits.sort();
}

describe("API origin resolution is centralised", () => {
	it("has no hand-rolled API base outside rpc.ts", async () => {
		// Failure message is the fix: route the call through `apiFetch` from
		// `@anthers/web-shared/rpc`, which resolves the origin per request and carries
		// the cookie or the bearer token as appropriate.
		expect(await offendingFiles()).toEqual([]);
	});

	it("actually scans something — a silent empty scan would pass forever", async () => {
		// The assertion above is a "no results" check, so it stays green if the glob
		// breaks, a root is renamed, or the repo root resolves wrong. Pin that the
		// scan sees real files, and that it sees the one file it is meant to exempt.
		const glob = new Glob("**/*.{ts,tsx}");
		const seen = [...glob.scanSync({ cwd: join(REPO, "apps/web/src") })];
		expect(seen.length).toBeGreaterThan(50);
		expect(await Bun.file(join(REPO, "packages/web-shared/src/lib/rpc.ts")).exists()).toBe(true);
	});
});
