// SPDX-License-Identifier: Apache-2.0
/**
 * Where the wiki is, for the links that leave the app for it.
 *
 * `anthers.wiki` serves the vault published from `~/Anthers/wiki-anthers`, and since
 * 2026-10-20 the roadmap there is Anthers' roadmap: it is the page `/roadmap-status`
 * keeps current, while this app's `/roadmap` is unlisted and kept only as a surface
 * to build from again later. Every link out of the app to the roadmap goes through
 * this constant so the address is written once.
 */
export const WIKI_ROADMAP_URL = "https://anthers.wiki/roadmap";
