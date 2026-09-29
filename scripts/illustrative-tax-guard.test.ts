// SPDX-License-Identifier: Apache-2.0
/**
 * No charge path may use the illustrative sales-tax rate — a charge path calling it is the
 * defect, not a style slip.
 *
 * 🚨 **The rate this guards against is real enough to charge.** Every Work purchase added a
 * flat 6.5% to every buyer's total until 2026-09, whatever the buyer's jurisdiction —
 * over-collected wherever the real rate was lower, under-collected wherever it was higher,
 * and an over-collection is a liability that has to be remitted or refunded rather than a
 * harmless surplus. Real tax is now calculated by Stripe Tax at the Checkout Session, from
 * the buyer's billing address and the product tax code each line carries, and the constant
 * is an illustration only — the sample receipts, the case studies, the economics display.
 *
 * ⭐ **A source scan rather than a unit test, because the failure is a reference.** The
 * charged amount lives in Stripe at the moment of sale, so no test double can see which
 * rate produced it; what the repository *can* see is the import. The illustrative constant
 * is allowed exactly where the illustration is the point, and a charge path reaching for it
 * is a bug this fails the build for. `buyerTotal` in `calculateFees` is pinned to the bare
 * price by `economics.test.ts`; this catches the regression at its source — somebody adding
 * `ILLUSTRATIVE_SALES_TAX_RATE` back into a file whose job is taking money.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

/** Where the illustration is the point, and nowhere else. */
const ALLOWED = [
	"packages/shared/src/constants.ts", // the definition itself
	"packages/shared/src/scenarios.ts", // sample receipts and case studies
	"packages/shared/src/scenarios.test.ts",
	"packages/shared/src/figures.generated.ts", // generated from scenarios
	"packages/web-shared/src/components/economics/economics.tsx", // the economics display
	"scripts/econ-figures.ts", // renders the published figures
] as const;

/** Every import of the illustrative rate, with where it came from. */
async function importers(): Promise<{ file: string; line: number; text: string }[]> {
	const hits: { file: string; line: number; text: string }[] = [];
	const roots = ["apps", "packages", "scripts"];
	for (const root of roots) {
		for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
			if (rel.includes("node_modules/") || rel.endsWith(".test.ts") || rel.endsWith(".test.tsx"))
				continue;
			const file = join(root, rel);
			const source = await Bun.file(file).text();
			source.split("\n").forEach((text, i) => {
				if (text.includes("ILLUSTRATIVE_SALES_TAX_RATE")) {
					hits.push({ file, line: i + 1, text: text.trim() });
				}
			});
		}
	}
	return hits;
}

describe("The illustrative sales-tax rate", () => {
	it("is defined at all, so a rename cannot leave the scan matching nothing", async () => {
		const hits = await importers();
		expect(hits.length).toBeGreaterThan(0);
	});

	it("🚨 never appears in a charge path — only where an illustration is the point", async () => {
		const allowed = new Set<string>(ALLOWED);
		const offending = (await importers()).filter((h) => !allowed.has(h.file));
		expect(
			offending.map((h) => `${h.file}:${h.line} — ${h.text}`),
			"a charge path using the illustrative rate would charge every buyer a flat 6.5%: real tax is Stripe Tax's, resolved per buyer at the Checkout Session",
		).toEqual([]);
	});

	it("🚨 no charge path reaches for it even by its old name", async () => {
		// The rename is the moment the guard exists for: a merge or a memory that still
		// says `SALES_TAX_RATE` would resurrect the flat charge under the old identifier,
		// which compiles nowhere but reads as though it were checked. Any remaining
		// mention anywhere outside a test or the constant's own doc history is a stale
		// reference to a charged figure.
		const hits: string[] = [];
		for (const root of ["apps", "packages", "scripts"] as const) {
			for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
				if (rel.includes("node_modules/") || /\.(test|e2e)\.tsx?$/.test(rel)) continue;
				const file = join(root, rel);
				const source = await Bun.file(file).text();
				// Comments stripped naively for the same reason `node-env-guard` does:
				// a doc block that names the retired constant to warn about it is
				// correct prose, not a charge.
				const code = source
					.replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1")
					.replace(/(^|[^:])\/\/.*$/gm, "$1");
				// The illustrative rename CONTAINS the old identifier as a suffix, so the
				// check is on the old name standing alone, not preceded by the qualifier
				// that made it honest.
				if (/(?<!ILLUSTRATIVE_)SALES_TAX_RATE/.test(code)) hits.push(file);
			}
		}
		expect(hits).toEqual([]);
	});
});
