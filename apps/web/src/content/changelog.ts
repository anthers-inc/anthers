// SPDX-License-Identifier: Apache-2.0
//
// The public changelog — one entry per calver release, newest first, each written by
// the public-pass layer rather than copied from anything mechanical.
//
// ⏳ **This file is a way station, exactly like `roadmap.ts` beside it.** The settled
// direction (Parker, 2026-09-03) is that content moves into the public vault and reaches
// the site through the exporter, so **do not invest in the shape of this TypeScript
// module, and do not add a field the exporter would have to reproduce.** An entry is:
// a version, a date, a short prose lede, grouped bullets, and roadmap references.
//
// The two layers, and the boundary between them:
//
// - The **raw changelist** — every squash commit between two tags, one line each, exact
//   and unedited — is generated at promote time and published as the GitHub release on
//   the tag (`scripts/release-changelist.sh`). It is the audit trail. **Never edit it
//   to match this file, and never derive this file from it mechanically** — the pass
//   is a person's judgment, which is the point of having one.
// - **This module is that judgment's output**: the reader-facing entries, grouped into
//   arcs rather than commits, filtered of what a reader cannot see (test machinery,
//   contributor tooling, internal rewrites), in Anthers' public voice.
//
// # The rules an entry has to follow
//
// 1. 🚨 **An entry names what a reader or a creator can see, do, or be affected by.**
//    Contributor-facing mechanics are filtered on purpose: a changelog that lists
//    pre-push hooks trains a reader to skim. Doubtful things go in with honest scope,
//    because silent omission is the page's failure mode — the raw list stays one click
//    away on the release.
// 2. **Group commits into arcs, one entry per arc.** The three Books tools are one
//    compliance story, not three rows. Order arcs by reader weight, most consequential
//    first.
// 3. **Past tense, plain declarative.** The changelog's whole subject is the past, and
//    it is the one page where describing a shipped thing plainly is the honest mode.
//    Nothing here announces; an entry that sells is an entry to rewrite.
// 4. 🚨 **A roadmap reference is earned by shipping, not by adjacency.** `roadmapIds`
//    names the roadmap items this release moved to `launched`, and the page links each
//    entry to `/roadmap#goal-<id>` — the two-way link is the point of this page. Most
//    entries map to nothing, and that is correct: do not stretch an entry to claim one.
//    If a referenced item is still `active` or `planned` in `roadmap.ts`, that is a
//    defect — move the item in the same PR (its rules apply: one short sentence, and
//    `launched` carries a quarter).
// 5. **Money figures are interpolated, never typed** — `econ:figures --check` scans
//    this directory and a typed figure fails the build. If an entry must name a number
//    the model generates, the scenario lives in `packages/shared/src/scenarios.ts` and
//    the entry interpolates the constant.
// 6. **The voice is the vault's public voice** — `82.01 How Anthers Talks About Itself`
//    in `Anthers-Wiki/80-89 Development/82 Brand/` governs claims and vocabulary
//    (Work, Post, Library, Badge, gate, Public Access, Review, time). The pass is
//    captured as the `anthers-changelog-pass` skill, which walks the whole procedure.

/**
 * One release. `lede` is the one-sentence frame under the version heading; each bullet
 * in `entries` is one arc, named by what it did for a reader or a creator.
 */
export interface ChangelogRelease {
	/** The calver version, matching the git tag the deploy job applies (`2026.10.0`). */
	version: string;
	/** The release date, ISO `YYYY-MM-DD`. */
	date: string;
	/** One short sentence framing the release. Not a summary of the bullets. */
	lede: string;
	/** One arc per bullet: what a reader or creator can now do, see, or no longer hits. */
	entries: string[];
	/** `roadmap.ts` item ids this release shipped; rendered as links both ways. See rule 4. */
	roadmapIds?: string[];
}

/**
 * Every release, newest first. A new release lands at the top with its entry written by
 * the public-pass skill — never pasted from the GitHub release.
 */
export const CHANGELOG: ChangelogRelease[] = [
	{
		version: "2026.10.0",
		date: "2026-10-02",
		lede: "Anthers' first numbered release — the changes that landed between opening this changelog's plan and the first calver tag.",
		entries: [
			"An emailed code is now the only way to sign in. No account holds a password, and nothing accepts one — sign-in, recovery and verification all run through the code Anthers emails.",
			"A profile's address is its handle. The separate Anthers username is gone, so a person is found at the handle they already own — an Anthers one, or a Bluesky one they brought — and a handle that changes keeps routing for ninety days while it settles.",
			"Comics open in a reader made for them. Panels are detected on each page and a reader can walk them one at a time, with the detection correctable page by page in the Studio.",
			"Spoken audio plays in a player made for talk: skip back and forward, a listening speed that carries across works, and a place to resume. A video can be listened to the same way, as a podcast.",
			"The Library gained a video lens beside the music one, and the music lens learned to include spoken word when a reader asks for it.",
			"Reviews sort by helpfulness first, with the newest order still available. The recommended share can be read over all time or over a recent window, so a Work that changed after release can be seen to have changed its readers' minds.",
			"An embed is a share link in a second shape. The Share button offers Link or Embed as peers, and the embed renders the same player through the same rules — a gated Work stays gated.",
			"Every charge now collects the sales tax it actually owes, in every state, replacing a flat illustrative rate — and the Books tools assemble what each jurisdiction is owed into a worksheet a person can review and file.",
			"Account suspension exists as a moderation action: recorded, reversible, and handled from a screen in the admin console alongside the earnings review it can require. A suspended account's works and posts go dark, its buyers keep their purchases, and money already owed holds for a bounded review rather than vanishing.",
			"Work credits are confirmed by the person they name. A credit is stored and published on the Work's record, and an identity credit a contributor has not accepted reaches only them and the Work's creator — never a stranger, and never as a bare DID.",
			"A Work now carries its original release date — when it first came out anywhere, not when it reached Anthers — and the catalog can sort by it.",
			"Account settings broke into four tabs: Account, Identity & Devices, Content & Safety, and Activity & Data.",
			"A rated Work's cover is covered on the Library shelf as it is everywhere else, so a kind of content a reader blurs stays blurred in their own library.",
			"The safety page's scan disclosure now names video alongside images, matching what the scan actually covers.",
			"Anthers started numbering its releases, and the number is visible in the logged-in footer — this entry is about the first one.",
		],
	},
];