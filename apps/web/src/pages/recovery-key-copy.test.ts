// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the recovery key card has to say, and what it must never say.
//
// 🚨 **This copy is the safety mechanism, which is why it gets a test at all.** A recovery key
// somebody loses is worse than one they never had: it sits at the top of the identity's
// authority list where nothing beneath it — including both of Anthers' own keys — can remove
// it or undo what it signs. The only thing standing between a person and that outcome is
// whether they understood the warning before they pressed the button. Soften the warning and
// the feature becomes a trap, with nothing failing and no test going red.
//
// ⚠️ **This is the same shape as `about-claims.test.ts`**, arriving from the other side: that
// one guards against a claim the page may not make yet, and this guards a warning the page may
// not stop making. Neither has a feature to exercise, so nothing else in the repo can tell.
//
// ⚠️ **A phrase here is a proxy for a meaning, and a guard covers a phrasing rather than a
// claim.** If this fails on wording that is honestly better, change the phrase in the same
// commit as the copy — deliberately. Never soften the copy to make the test green, and never
// delete a row because it is inconvenient.
//
// Sources: the wiki's *The Anthers PDS and Creator Nodes* on what the offer owes somebody, and
// `services/hosted-recovery-key.ts` on what is actually true of the key.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "SettingsPage.tsx"), "utf8");

// Comments are blanked before matching, and it is load-bearing rather than tidy: the docblocks
// on the card explain what it must say and why, so a scan that read them would pass on its own
// documentation while the visible copy said nothing. Whitespace is collapsed because JSX text
// wraps wherever the formatter decides, and a phrase split across two lines is invisible to a
// substring scan — the quietest possible way for a guard to stop working.
const COPY = SOURCE.replace(/\/\*[\s\S]*?\*\//g, " ")
	.replace(/^\s*\/\/.*$/gm, " ")
	.replace(/\s+/g, " ")
	.toLowerCase();

/** Something the card must tell somebody before they can act, and why it matters. */
const MUST_SAY: { warning: string; phrases: string[]; because: string }[] = [
	{
		warning: "a lost key cannot be replaced",
		phrases: ["cannot be replaced"],
		because:
			"Anthers' keys rank below it, so nothing Anthers holds can seat a replacement over it.",
	},
	{
		warning: "a lost key cannot be removed either",
		phrases: ["or removed"],
		because:
			"This is the half people assume is recoverable. It is not: the key stays at the top of " +
			"the rotation list forever, usable by whoever has it and by nobody else.",
	},
	{
		warning: "Anthers never sees the private half",
		phrases: ["anthers never sees it"],
		because:
			"It is the whole reason the key is generated in the browser, and a person deciding " +
			"whether to trust the arrangement is entitled to be told rather than to infer it.",
	},
	{
		warning: "the key is shown exactly once",
		phrases: ["only time it is shown"],
		because: "Somebody who scrolls past it has lost it, and the page is what tells them so.",
	},
	{
		warning: "the key outranks Anthers'",
		phrases: ["ranks above"],
		because:
			"Without this the offer reads as a backup code rather than as the thing that makes " +
			"leaving possible without Anthers' cooperation.",
	},
];

describe("what the recovery key card must tell somebody", () => {
	for (const { warning, phrases, because } of MUST_SAY) {
		it(`says ${warning}`, () => {
			const found = phrases.some((p) => COPY.includes(p));
			expect(found, `${warning} — ${because}`).toBe(true);
		});
	}
});

/**
 * Something the card must not imply, and what a reader would wrongly conclude.
 *
 * 🚨 **Every one of these would be a comforting sentence and a false one.** The temptation is
 * real, because the honest version of this card is alarming and the obvious edit is to
 * reassure — which would leave somebody believing Anthers can fix a loss it cannot fix.
 */
const MUST_NOT_IMPLY: { claim: string; pattern: RegExp; because: string }[] = [
	{
		claim: "Anthers can recover or reset a lost key",
		pattern: /anthers can (recover|reset|restore|replace)/,
		because: "Anthers' keys rank below the holder's, so it cannot act on it at all.",
	},
	{
		claim: "the key can be regenerated later",
		pattern: /generate a new (one|key) (if|when) you lose/,
		because:
			"A second key can be seated, and the lost one still outranks everything and cannot be " +
			"removed — so this would answer the wrong question reassuringly.",
	},
	{
		claim: "Anthers keeps a copy",
		pattern: /(we|anthers) (keep|store|hold) a copy/,
		because: "It would contradict the one property the whole design exists to provide.",
	},
];

describe("what the recovery key card must not imply", () => {
	for (const { claim, pattern, because } of MUST_NOT_IMPLY) {
		it(`does not suggest that ${claim}`, () => {
			expect(pattern.test(COPY), `${claim} — ${because}`).toBe(false);
		});
	}
});
