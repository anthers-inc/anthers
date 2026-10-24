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
 * tab links to the Rating Standard. The page is `30.04 Crediting a Work` in the vault, and
 * the publishing host's two-level slug strips the Johnny.Decimal prefix from the category
 * and the page alike.
 */
export const CREDITS_WIKI_URL = "https://anthers.wiki/publishing/crediting-a-work";
