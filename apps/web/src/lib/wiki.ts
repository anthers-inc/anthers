// SPDX-License-Identifier: Apache-2.0
/**
 * Where the wiki is, for the links that leave the app for it.
 *
 * `anthers.wiki` serves the vault published from `~/Anthers/wiki-anthers`, and its
 * roadmap is Anthers' only roadmap (2026-10-23): the app keeps no roadmap page of its
 * own, so every link to the roadmap goes through this constant and the address is
 * written once.
 */
export const WIKI_ROADMAP_URL = "https://anthers.wiki/roadmap";

/**
 * The credits policy, linked from the credits editor above its table the way the Rating
 * tab links to the Rating Standard. The page is `35.01 Crediting a Work` under
 * `35 Credits` in the vault, and the publishing host's two-level slug strips the
 * Johnny.Decimal prefixes from the category and the page alike.
 */
export const CREDITS_WIKI_URL = "https://anthers.wiki/credits/crediting-a-work";

/**
 * The reader's walkthrough, linked from the orientation checklist in the shell's corner.
 *
 * The page is `20.01 Your First Visit` under `20 First Steps`, and it is the long form of
 * the same first session the checklist draws as four rows. The guide link is how a reader
 * who wants the whole path follows it instead of treating four rows as the whole thing.
 */
export const READER_GUIDE_URL = "https://anthers.wiki/first-steps/your-first-visit";

/**
 * The creator's walkthrough, linked from the Studio's checklist in the same corner.
 *
 * The page is `30.01 Releasing Your First Work` under `30 Getting Started`, and it covers
 * the profile, the first Work, the release, the announcement and the first Badge in
 * order. The follow-up checklist is the short form of that path.
 */
export const CREATOR_GUIDE_URL = "https://anthers.wiki/getting-started/releasing-your-first-work";
