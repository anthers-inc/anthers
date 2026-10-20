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

/**
 * The anchor a wiki heading answers to.
 *
 * ⚠️ **This is a copy of the publishing host's `slugifyHeading`** in
 * `anthers-obsidian/src/client/lib/heading-slug.ts`, because the release notes link into
 * the roadmap's lanes from this app and the two have to agree to the character. Change
 * the scheme there and change this function in the same breath. It is GitHub's: lowercase;
 * letters, numbers, `_` and `-` survive; every other punctuation mark is dropped; each
 * space becomes a hyphen — which is why an ampersand leaves a double hyphen.
 */
export function wikiAnchor(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s/g, "-");
}
