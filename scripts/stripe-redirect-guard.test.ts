// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every URL the server hands Stripe comes from `STRIPE_RETURN_PATHS`, never from a string
 * typed at the call site.
 *
 * 🚨 **The defect this exists for was invisible to every other kind of test, and that is the
 * whole argument for scanning source.** Connect's onboarding returned creators to
 * `/studio/payouts` from the day it was written until 2026-08-29, and no such route has ever
 * existed. A `return_url` is composed, handed to a third party, and navigated by the person's
 * browser some minutes later — so the typecheck sees a valid string, the lint sees valid
 * syntax, and no route test can fire because our server never makes the request. It was
 * survivable only while payouts were optional; PR #105 put it between a creator and their
 * first released Work.
 *
 * ⭐ **This is half a guard and it says so.** Here: no redirect URL is typed inline, so every
 * one of them is a key in the shared record. There:
 * `apps/web/tests/e2e/stripe-return-paths.authed.e2e.ts` visits every value in that record and
 * asserts a real page answers with the thing its query parameter produces. Neither half works
 * alone — this one would pass on a constant pointing at nonsense, and that one cannot see a
 * URL that never became a constant. The record's own shape is asserted beside it, in
 * `packages/shared/src/redirect-paths.test.ts`; `scripts` deliberately depends on no workspace
 * package, so this half stays a pure source scan.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

/**
 * The Stripe fields that take a URL we own.
 *
 * `return_url` and `refresh_url` are the account-link and billing-portal legs; `success_url`
 * and `cancel_url` belong to Checkout Sessions, which this app does not use today — named
 * anyway, so that adopting Checkout later arrives already covered rather than quietly
 * outside the rule.
 */
const REDIRECT_FIELDS = ["return_url", "refresh_url", "success_url", "cancel_url"] as const;

const ROOTS = ["apps/api/src", "packages"] as const;
const SELF = "stripe-redirect-guard.test.ts";

async function sourceFiles(): Promise<string[]> {
	const found: string[] = [];
	for (const root of ROOTS) {
		const glob = new Bun.Glob("**/*.ts");
		for await (const rel of glob.scan({ cwd: root })) {
			if (rel.includes("node_modules/") || rel.endsWith(SELF)) continue;
			found.push(join(root, rel));
		}
	}
	return found;
}

/** Every line assigning one of the redirect fields, with where it came from. */
async function redirectAssignments(): Promise<{ file: string; line: number; text: string }[]> {
	const hits: { file: string; line: number; text: string }[] = [];
	for (const file of await sourceFiles()) {
		const lines = (await Bun.file(file).text()).split("\n");
		lines.forEach((text, i) => {
			// The field name followed by a colon, at the start of an object property. A
			// mention inside a comment or a doc block reads as prose and does not match,
			// which is why the assertion below can be strict about what a hit must contain.
			if (REDIRECT_FIELDS.some((field) => new RegExp(`^\\s*${field}:`).test(text))) {
				hits.push({ file, line: i + 1, text: text.trim() });
			}
		});
	}
	return hits;
}

describe("Stripe redirect URLs", () => {
	it("scans a plausible number of files, so a broken glob cannot pass silently", async () => {
		// Without this every assertion below is satisfied by an empty file list.
		const files = await sourceFiles();
		expect(files.length).toBeGreaterThan(100);
	});

	it("finds the redirect assignments at all, so the pattern cannot rot into matching nothing", async () => {
		// The account link's two legs and the billing portal's one. A refactor that renames
		// the field or reshapes the call should fail here rather than silently leaving the
		// rule below with nothing to check.
		const hits = await redirectAssignments();
		expect(hits.length).toBeGreaterThanOrEqual(3);
	});

	it("🚨 builds every one of them from STRIPE_RETURN_PATHS rather than an inline path", async () => {
		const hits = await redirectAssignments();
		const inline = hits.filter((h) => !h.text.includes("STRIPE_RETURN_PATHS."));
		expect(
			inline.map((h) => `${h.file}:${h.line} — ${h.text}`),
			"a redirect URL typed inline is a route reference nothing can follow; add it to packages/shared/src/redirect-paths.ts",
		).toEqual([]);
	});
});
