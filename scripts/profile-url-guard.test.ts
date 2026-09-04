// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every profile URL comes from `@anthers/web-shared/profile`, never from a string built at the
 * call site.
 *
 * 🚨 **A profile link built inline does not fail, it points somewhere else.** `/name` and
 * `/@name` are both valid paths and both render a page, so a link that forgets the prefix
 * navigates, renders the 404, and passes every other assertion around it — which is the same
 * shape of defect that let the Studio's nav point at `/projects/new` for six days and Connect's
 * `return_url` point at `/studio/payouts` from the day it was written. There were 24 of these
 * literals before the prefix landed, spread across cards, players, tables and two packages, and
 * nothing tied them together except that each began with a slash.
 *
 * ⭐ **This is half a guard and it says so.** Here: no profile path is typed inline, so the `@`
 * exists in exactly one module. There: `apps/web/tests/e2e/profile-urls.e2e.ts` walks the real
 * app and asserts `/@name` reaches a profile while a bare `/name` reaches a 404. Neither half
 * works alone — this one would pass on a helper that returned nonsense, and that one cannot see
 * a link that was never rendered on the page it happened to visit.
 *
 * ⚠️ **Scope is URLs, not printed handles.** `displayHandle` exists for the `@name` a reader
 * sees in a byline, but a stray `@${…}` in copy is a cosmetic slip that shows itself, while a
 * missing one in a path is invisible. The one deliberate exception is an ATProto handle
 * (`SettingsPage`), which belongs to a different namespace entirely and must not be routed
 * through a helper that means "an Anthers profile".
 *
 * `scripts` deliberately depends on no workspace package, so this stays a pure source scan.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const ROOTS = ["apps/web/src", "packages/web-shared/src"] as const;

/** The module that is allowed to write the prefix, and this file, which has to quote it. */
const EXEMPT = ["packages/web-shared/src/lib/profile.ts", "profile-url-guard.test.ts"];

/**
 * A root-level path whose first segment is interpolated from something user-shaped.
 *
 * Anchored on the backtick and the leading slash, so it matches a path being *built* and not a
 * path being described in a comment. The `[Uu]sername|creator|[Hh]andle` alternation is what
 * separates a profile link from the other root-dynamic template in the tree — the moderation
 * queue's `` `/${kind === "work" ? "works" : "posts"}/…` `` — which names no person and is
 * correctly not a profile URL.
 */
const INLINE_PROFILE_PATH = /`\/\$\{[^}]*(?:[Uu]sername|creator|[Hh]andle)[^}]*\}/;

async function sourceFiles(): Promise<string[]> {
	const found: string[] = [];
	for (const root of ROOTS) {
		const glob = new Bun.Glob("**/*.{ts,tsx}");
		for await (const rel of glob.scan({ cwd: root })) {
			const path = join(root, rel);
			if (rel.includes("node_modules/") || EXEMPT.some((e) => path.endsWith(e))) continue;
			found.push(path);
		}
	}
	return found;
}

describe("profile URLs", () => {
	it("scans a plausible number of files, so a broken glob cannot pass silently", async () => {
		// Without this every assertion below is satisfied by an empty file list.
		const files = await sourceFiles();
		expect(files.length).toBeGreaterThan(100);
	});

	it("finds the helper's call sites, so the rule cannot rot into checking nothing", async () => {
		// If nothing imports the module, either the prefix was abandoned or the scan is
		// pointed at the wrong tree — and the assertion below would pass in both cases.
		let importers = 0;
		for (const file of await sourceFiles()) {
			if ((await Bun.file(file).text()).includes("web-shared/profile")) importers++;
			else if ((await Bun.file(file).text()).includes('from "../lib/profile"')) importers++;
		}
		expect(importers).toBeGreaterThanOrEqual(15);
	});

	it("🚨 builds every one of them through the helper rather than an inline path", async () => {
		const inline: string[] = [];
		for (const file of await sourceFiles()) {
			const lines = (await Bun.file(file).text()).split("\n");
			lines.forEach((text, i) => {
				if (INLINE_PROFILE_PATH.test(text)) inline.push(`${file}:${i + 1} — ${text.trim()}`);
			});
		}
		expect(
			inline,
			"a profile path typed inline renders a 404 instead of erroring; use @anthers/web-shared/profile",
		).toEqual([]);
	});
});
