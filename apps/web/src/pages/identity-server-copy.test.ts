// SPDX-License-Identifier: Apache-2.0
//
// What the identity server card and the disconnect confirmation have to say.
//
// 🚨 **The confirmation is the safety mechanism, which is why it gets a test at all.**
// `stopPublishingFor` takes every Work, post and project record out of the repository before it
// hands the OAuth grant back, and revoking a grant ends every write rather than only publishing.
// Somebody who read the button as "turn off publishing" would lose their listings and their
// ability to comment in one press, with nothing failing and no test going red.
//
// ⚠️ **The hosted paragraph is the other half, and it is honesty rather than safety.** The
// password on an identity Anthers hosts is the holder's, and the card is where they set it. What
// the copy has to make clear is the custody split: the password works in Bluesky and anywhere
// else the identity signs in, and Anthers keeps a session for its own writes rather than a copy
// of the password.
//
// ⚠️ **This is the same shape as `recovery-key-copy.test.ts`**, with the same caveat: a phrase
// here is a proxy for a meaning. If this fails on wording that is honestly better, change the
// phrase in the same commit as the copy, deliberately.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "SettingsPage.tsx"), "utf8");

// Comments are blanked before matching, because the docblocks explain what the cards must say
// and a scan that read them would pass on its own documentation. Whitespace is collapsed
// because JSX text wraps wherever the formatter decides.
const COPY = SOURCE.replace(/\/\*[\s\S]*?\*\//g, " ")
	.replace(/^\s*\/\/.*$/gm, " ")
	.replace(/\s+/g, " ")
	.toLowerCase();

/** Something the cards must tell somebody before they can act, and why it matters. */
const MUST_SAY: { about: string; phrases: string[]; because: string }[] = [
	{
		about: "a hosted identity's password is the person's, and Anthers keeps a session not a copy",
		phrases: ["keeps a session, not a copy"],
		because:
			"Without it, the password door reads as another Anthers password rather than the " +
			"credential that makes the identity usable outside Anthers, and the session the hub " +
			"holds would be mistaken for a stored password.",
	},
	{
		about: "disconnecting takes the published records down",
		phrases: ["take down the works, posts and projects"],
		because:
			"The route removes every record before revoking, and a person pressing a button that " +
			"reads only as a permission change has not been told that their listings go.",
	},
	{
		about: "disconnecting ends every write, not only publishing",
		phrases: ["comments, reviews, votes and follows"],
		because:
			"One OAuth session carries both tiers, so revoking it stops commenting, reviewing, " +
			"voting and following until it is granted again.",
	},
	{
		about: "disconnecting deletes nothing in the account",
		phrases: ["nothing in your anthers account is deleted"],
		because:
			"A destructive-sounding action needs its boundary stated, or the warning reads as a " +
			"threat to everything the person has on Anthers.",
	},
];

describe("what the identity server and disconnect cards must say", () => {
	for (const { about, phrases, because } of MUST_SAY) {
		it(`says ${about}`, () => {
			const found = phrases.some((p) => COPY.includes(p));
			expect(found, `${about} — ${because}`).toBe(true);
		});
	}
});
