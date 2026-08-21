// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What /about may claim about the organization, given the organization we have.
//
// 🚨 **The failure this guards is subtler than a false statement, and the page had it
// for months.** Nothing on /about claimed the exemption. What it did instead was
// *presuppose governance we don't have*: three "?" board members with bios and a *Seeking
// candidates* tag, a footnote on staggered terms and ED recusal drawn from bylaws
// nobody has adopted, an "Independent Board" with "authority to override operational
// decisions", and a Reports & Compliance card promising an annual Form 990, Impact
// Report and independent audit. None of it was a lie about the future and all of it was
// a claim about the present, so a reader met a governed organization and would have
// found one person.
//
// That is the same shape as *"where a document claims an absence, that absence needs a
// test"*, arriving from the other side. An absence rots silently because there is no
// feature to exercise; a **premature presence** rots silently because there is no
// feature to contradict it. Both need a test for the same reason: nothing else in the
// repo can tell.
//
// ⚠️ **Every row below becomes sayable on a specific day.** When that day comes, delete
// the row **in the same commit as the milestone** — deliberately, because the
// organization changed. Never delete one to make a red test green, and never soften a
// phrase to slip past it: the phrase is a proxy for the claim, and a guard covers a
// phrasing rather than a claim (the lesson `RETIRED_COPY` paid for when its ATProto
// rule sailed straight past *"an open, distributed network"*). If this fails on wording
// you believe is honest, the question to ask is what a reader would conclude, not
// whether the regex was fair.
//
// Scoped to this one page on purpose. `RETIRED_COPY` in `scripts/econ-figures.ts` was
// the other candidate and is the wrong tool here: it runs repo-wide, and RoadmapPage
// says "first 990 filed" as a **future milestone on a timeline**, which is exactly
// correct there. A repo-wide rule would need an `econ:allow` on honest copy, which is
// how a guard becomes noise people route around.
//
// Sources: 63.01 § Claims & honesty (what may be said), 60.01 § Phase 1 (what is true).

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TIME_POOL_RATE } from "@anthers/shared/constants";

const SOURCE = readFileSync(join(import.meta.dir, "AboutPage.tsx"), "utf8");

// Comments are blanked before matching, the same way `econ-figures.ts` blanks them for
// RETIRED_COPY — and here it is load-bearing rather than a courtesy. The header
// docblock on AboutPage.tsx **names several of the phrases below**, to record what the
// page may not say and why, so a scan that read comments would fail on its own
// documentation and teach the next person to delete the explanation instead of the
// claim.
// 🚨 Whitespace is collapsed, and that is a fix rather than a convenience. JSX text wraps
// wherever the formatter decides, so `board of directors` split across two lines was
// invisible to a substring scan — the guard could be disarmed by a reflow nobody looked at,
// which is the quietest possible way for it to stop working. Found 2026-08-21 when a new
// assertion failed against copy that was plainly on the page.
const COPY = SOURCE.replace(/\/\*[\s\S]*?\*\//g, " ")
	.replace(/^\s*\/\/.*$/gm, " ")
	.replace(/\s+/g, " ")
	.toLowerCase();

/**
 * A claim the page may not make yet, and the day it becomes sayable.
 *
 * `phrases` are lowercase substrings. They are the wordings that actually appeared on
 * the page, not the ones we would have predicted — same rule 63.01 records for
 * `RETIRED_COPY`, for the same reason.
 */
const PREMATURE: { claim: string; phrases: string[]; sayableWhen: string }[] = [
	{
		claim: "a board of directors exists and oversees the organization",
		phrases: ["board of directors", "independent board", "board-approved", "board approves"],
		sayableWhen: "the founding board is seated (Parker is sole initial director today)",
	},
	{
		claim: "board terms and officer conduct are governed by adopted bylaws",
		phrases: ["staggered terms", "ex officio", "recused", "recusal"],
		sayableWhen: "the bylaws are adopted — they are drafted, and the board adopts them",
	},
	{
		claim: "there are named board seats waiting to be filled",
		phrases: ["seeking candidates"],
		// The org-chart-with-empty-chairs shape, which reads as a structure that exists
		// and is short-staffed. The honest form is an invitation in prose, and the page
		// carries one — so this row does not expire on the board being seated. It expires
		// never: a seated board gets real names, and an unseated one gets the invitation.
		sayableWhen: "never — a real board gets real names, and no board gets an invitation",
	},
	{
		claim: "Anthers files an annual federal return",
		phrases: ["990"],
		sayableWhen: "the first annual return is filed and public",
	},
	{
		claim: "Anthers publishes an annual impact report",
		phrases: ["impact report"],
		sayableWhen: "the first one is published",
	},
	{
		claim: "Anthers' financials are independently audited",
		phrases: ["independent audit", "independent auditor"],
		sayableWhen: "the first audit is complete",
	},
	{
		claim: "Anthers already holds federal tax-exempt status, or has applied for it",
		// 🚨 **This row was `["501(c)", "tax-exempt", …]` — the bare term — until 2026-08-21,
		// when Parker's call moved 63.01 off *"say nothing about federal status at all"*.
		// The page now states the intention to file, and the § What Anthers Is two-column
		// split (what binds us NOW / what recognition ADDS) is what makes that safe: it
		// partitions present from future on the page itself rather than leaving a reader to
		// work out which column a sentence belongs in.
		//
		// So what is forbidden is the **present tense**, in every form that would let a
		// reader conclude we hold the status or have asked for it. The Form 1023 has not
		// been filed. Note "another charitable organization" is fine and describes where the
		// assets go, not what we are; and the positive assertion below pins the future
		// framing, so a re-tensing breaks two tests rather than none.
		phrases: [
			"is a 501(c)",
			"are a 501(c)",
			"as a 501(c)",
			"501(c)(3) nonprofit",
			"501(c)(3) non-profit",
			"501(c)(3) organization",
			"501(c)(3) charity",
			"tax-exempt",
			"tax exempt",
			"exemption is pending",
			"application is pending",
			"pending 501(c)",
			"applied for 501(c)",
		],
		sayableWhen:
			"the IRS determination letter arrives — and 'applied for' only once the Form 1023 is actually filed",
	},
	{
		claim: "money given to Anthers is deductible today",
		// The half of the old row that did NOT relax. Deductibility is the claim with a
		// cash consequence for the reader, so only the future form survives, and it is
		// paired with its own correction — see the co-presence assertion below.
		phrases: [
			"is tax-deductible",
			"are tax-deductible",
			"is tax deductible",
			"are tax deductible",
			"tax-deductible donation",
			"tax deductible donation",
			"tax-deductible gift",
			"tax deductible gift",
		],
		sayableWhen: "the IRS determination letter arrives",
	},
];

describe("/about describes the organization as it is", () => {
	it("🚨 scans the page's copy and not its own explanation of these rules", () => {
		// Guard the guard, twice. A comment-stripper that blanked the file would pass
		// every assertion below while checking nothing, and one that blanked nothing
		// would fail on the docblock and get itself deleted.
		//
		// ⚠️ The second line names a sentence that exists ONLY in AboutPage's docblock. If
		// you rewrite that docblock, repoint this at a phrase the new one carries — dropping
		// the assertion leaves the stripper unchecked in one direction.
		expect(COPY).toContain("a colorado nonprofit corporation");
		expect(COPY).not.toContain("the honest move is to say less");
	});

	for (const { claim, phrases, sayableWhen } of PREMATURE) {
		it(`makes no claim that ${claim} — sayable when ${sayableWhen}`, () => {
			for (const phrase of phrases) {
				// Reported this way so a failure names the phrase rather than dumping the
				// whole page into the diff.
				expect(`${phrase}: ${COPY.includes(phrase) ? "on the page" : "absent"}`).toBe(
					`${phrase}: absent`,
				);
			}
		});
	}

	// The positive half of the federal-status rule, and it is what lets the negative half
	// above be narrow. Every mention of 501(c)(3) on this page has to sit inside the
	// explicit future framing; re-tense the sentence and this fails alongside whichever
	// present-tense phrase the reword reached for. Rewording is fine — update this line
	// with the reword rather than dropping it.
	it("states federal recognition as something ahead of us, never as something we hold", () => {
		expect(COPY).toContain("will be filing for federal 501(c)(3) recognition");
	});

	// 🚨 The co-presence rule, same shape as "free forever" beside the monthly limit: a
	// reader who meets "donations become tax-deductible" without the correction beside it
	// will hear that theirs is, and that one has a cash consequence. Conditional on the
	// mention, because deleting the deductibility line entirely is a legitimate edit —
	// what is not legitimate is keeping it and dropping the sentence that dates it.
	it("never says donations become deductible without saying they are not yet", () => {
		if (COPY.includes("tax-deductible") || COPY.includes("tax deductible")) {
			expect(COPY).toContain("until the determination letter arrives, they are not");
		}
	});

	// The one money figure this page states in words rather than deriving. `econ:figures`
	// cannot see it — its marker blocks generate tables and its typed-figure scan looks for
	// numerals — so the word gets pinned to the rate it describes here instead. Change
	// TIME_POOL_RATE and this turns red, which is the point: a prose fraction that has
	// quietly stopped being true is exactly the failure the generator exists to prevent.
	it("still describes the Time Pool share correctly in prose", () => {
		expect(TIME_POOL_RATE).toBe(0.5); // the rate the word "half" below is describing
		expect(COPY).toContain("half of it pays creators");
	});

	it("says plainly that Anthers is one person and Parker is its only director", () => {
		// The positive half, and it needs asserting for the same reason the negatives do:
		// every sentence above could be deleted without a single thing turning red, and
		// the page would then simply be silent about who runs Anthers — which is the state
		// it was in before, minus the fabrications. Rewording is fine; update this line
		// with the reword rather than dropping it.
		expect(COPY).toContain("anthers is one person");
		expect(COPY).toContain("only director");
	});
});
