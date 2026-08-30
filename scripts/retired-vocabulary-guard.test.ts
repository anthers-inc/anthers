// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Retired vocabulary may not accumulate in comments.
 *
 * 🚨 **`econ:figures` blanks comments before it scans, deliberately and correctly** — its
 * job is published copy, and an identifier that legitimately says `seed_allocations` is not
 * a claim to a reader. The cost of that choice is that comments were the one surface where
 * the retired model could pile up unwatched, and it did: **440 comment lines named a retired
 * mechanism** by 2026-08-29, most of them narrating a rename nobody reading today needs.
 *
 * ⚠️ **A flat ban is not available, and pretending otherwise is how a guard becomes noise.**
 * Some mentions genuinely earn their place — a rule that says *never floor this, a whole-unit
 * floor turned $2.50 into $2* stops somebody reintroducing the bug, and it cannot say so
 * without naming what it is warning about. A regex cannot tell that from *"this used to be
 * called a Seed"*, because the difference is intent rather than wording.
 *
 * ⭐ **So this is a RATCHET rather than a rule.** Each file carries the number of mentions it
 * had when the corpus was pruned; the test fails if a file grows past its budget, and fails
 * *equally loudly* if a budget is now too high, which is what makes the number fall over time
 * rather than sit there. Adding a comment that names a retired mechanism is not forbidden —
 * it is a line in this file, in a diff, with a reason. That is the whole point: **the cost of
 * the next one is that somebody has to look at it.**
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

/**
 * The retired vocabulary, matched as a NOUN rather than as a word.
 *
 * `Seed` is capital-S and in a counted or qualified form, which is what separates prose from
 * the identifiers that kept the name — `seed_allocations`, `works.seed_access`, `picks.seed`
 * and `seedGatedAccess` are all live and all out of reach here. The bare imperative is out of
 * reach too: *"Seed the database"* is ordinary English and this repository's dev fixtures are
 * full of it.
 *
 * ⚠️ **`watch-time` and `watch-hour` are deliberately absent.** The Copy Style Guide bans them
 * in user-facing copy and `econ:figures` enforces that; a byte-derived engineering figure may
 * say "per watch-hour" because there it names a real unit of streaming cost. Putting them here
 * would flag the one place they are correct.
 */
const RETIRED = [
	// ⚠️ **Case-SENSITIVE, and the `/i` it used to carry was a bug.** The capital S is the
	// whole discriminator between the retired unit and ordinary English, and with `/i` this
	// matched *"deterministic per seed"* in a test that seeds a pseudo-random generator —
	// a false positive that would have been "fixed" by renaming a variable to please a lint.
	/\b(?:a|the|one|whole|per|each|every|\$3|counted?|indivisible)[- ]Seeds?\b/,
	/\bSeeds?\b(?=\s+(?:count|price|gate|rung|model|retirement|era|unit))/i,
	/\bSeed[- ]?(?:count|price|gated?|Gate|rung)s?\b/,
	/\bAnthers[- ][Gg]ates?\b/,
	/\bBadge plans?\b/,
	/\bpay-what-you-want\b|\bpwyw\b/i,
	/\bbandwidth (?:allowance|wallet|floor|line|term)\b/i,
];

const ROOTS = ["apps/api/src", "apps/web/src", "apps/web/tests", "packages", "scripts"] as const;
const SELF = "retired-vocabulary-guard.test.ts";

/**
 * Files exempt outright, each because naming the retired vocabulary is their subject.
 *
 * Kept short on purpose — a file-level exemption is a place new narration can hide, so it has
 * to be a file whose *job* is the vocabulary rather than one that merely has a lot of it.
 */
const EXEMPT: { pattern: RegExp; why: string }[] = [
	{
		pattern: /scripts\/econ-figures\.ts$/,
		why: "carries the RETIRED_COPY rules themselves — it cannot forbid a phrase without spelling it",
	},
	{ pattern: new RegExp(`${SELF}$`), why: "this file" },
];

/** How many mentions each file is allowed. A file absent from here is allowed none. */
const BUDGET: Record<string, number> = {
	"packages/shared/src/constants.ts": 3,
	"packages/db/src/seed.ts": 1,
	"apps/api/src/__tests__/access-staircase.test.ts": 2,
	"apps/api/src/__tests__/creator-preview.test.ts": 2,
	"apps/api/src/routes/subscriptions.ts": 2,
	"apps/api/src/services/access.ts": 1,
	"apps/api/src/services/billing.ts": 2,
	"apps/web/src/components/calculators/video-model.ts": 2,
	"apps/api/src/__tests__/distribute-pool.test.ts": 1,
	"apps/api/src/__tests__/unlock-offer.test.ts": 1,
	"apps/api/src/__tests__/payments-stripe.test.ts": 1,
	"apps/api/src/__tests__/support-split.test.ts": 1,
	"apps/api/src/routes/content.ts": 1,
	"apps/api/src/jobs/distribute-pool.ts": 1,
	"apps/web/src/content/faq.tsx": 1,
	"apps/web/src/content/faq.test.ts": 1,
	"apps/web/src/pages/ForCreatorsPage.tsx": 1,
	"apps/web/src/pages/CreatorMonetizationCalculatorPage.tsx": 1,
	"apps/web/src/pages/CreatorPayComparisonPage.tsx": 1,
	"apps/web/src/pages/SubscriptionPage.tsx": 1,
	"apps/web/src/components/subscribe/SubscriptionPaymentModal.tsx": 1,
	"apps/web/src/components/creator/PreviewBar.tsx": 1,
	"apps/web/tests/e2e/calculators.e2e.ts": 1,
	"packages/shared/src/badges.test.ts": 1,
	"packages/shared/src/figures.generated.ts": 1,
	"packages/shared/src/public-access.test.ts": 1,
	"packages/shared/src/public-access.ts": 1,
	"packages/web-shared/src/components/post/BadgeLadderEditor.tsx": 1,
	"packages/web-shared/src/components/economics/SupportStepper.tsx": 1,
	"packages/web-shared/src/components/economics/economics.tsx": 1,
};

async function sourceFiles(): Promise<string[]> {
	const found: string[] = [];
	for (const root of ROOTS) {
		for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
			const file = join(root, rel);
			if (rel.includes("node_modules/") || EXEMPT.some((e) => e.pattern.test(file))) continue;
			found.push(file);
		}
	}
	return found;
}

/** Every comment line naming a retired mechanism, by file. */
async function mentions(): Promise<Map<string, string[]>> {
	const byFile = new Map<string, string[]>();
	for (const file of await sourceFiles()) {
		const hits: string[] = [];
		(await Bun.file(file).text()).split("\n").forEach((line, i) => {
			// Comment lines only. Code is `econ:figures`' problem and identifiers are fine.
			if (!/^\s*(\/\/|\*|\/\*)/.test(line)) return;
			if (RETIRED.some((re) => re.test(line))) hits.push(`${file}:${i + 1} — ${line.trim()}`);
		});
		if (hits.length > 0) byFile.set(file, hits);
	}
	return byFile;
}

describe("retired vocabulary in comments", () => {
	it("scans a plausible number of files, so a broken glob cannot pass silently", async () => {
		expect((await sourceFiles()).length).toBeGreaterThan(200);
	});

	it("still finds the mentions it is budgeting, so the patterns cannot rot into matching nothing", async () => {
		// A ratchet whose matcher has stopped matching reports every budget as slack and
		// quietly ratchets itself to zero, which looks exactly like success.
		const total = [...(await mentions()).values()].reduce((n, hits) => n + hits.length, 0);
		expect(total).toBeGreaterThan(20);
	});

	it("🚨 lets no file grow past its budget", async () => {
		const over: string[] = [];
		for (const [file, hits] of await mentions()) {
			const allowed = BUDGET[file] ?? 0;
			if (hits.length > allowed) {
				over.push(
					`${file}: ${hits.length} mention(s), budget ${allowed}\n    ${hits.join("\n    ")}`,
				);
			}
		}
		expect(
			over,
			"a comment naming a retired mechanism earns its place by stopping a regression or explaining an oddity — not by recording a rename. If this one does, raise the budget in scripts/retired-vocabulary-guard.test.ts and say why in the diff",
		).toEqual([]);
	});

	it("⭐ keeps no budget larger than the file needs, so the numbers can only fall", async () => {
		// The half that makes it a ratchet rather than a ceiling. Without it a budget set
		// during a prune stays as permanent headroom for the next person to fill.
		const found = await mentions();
		const slack = Object.entries(BUDGET)
			.map(([file, allowed]) => [file, allowed, found.get(file)?.length ?? 0] as const)
			.filter(([, allowed, actual]) => actual < allowed)
			.map(([file, allowed, actual]) => `${file}: budget ${allowed}, actual ${actual}`);
		expect(slack, "lower these budgets — a ratchet only ratchets if the slack comes out").toEqual(
			[],
		);
	});
});
