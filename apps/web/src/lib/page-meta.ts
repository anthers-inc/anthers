// SPDX-License-Identifier: Apache-2.0
/**
 * What each standing page says about itself in a link preview.
 *
 * The shell ships one site-level card because a folder of files cannot know which page a URL
 * names. The web origin can, so a route listed here serves its own title, its own line of
 * description, and its own address as the canonical one. The values are the served head's
 * copy rather than the tab's: a page's `usePageTitle` label is what a browser tab shows, and
 * these are the words a person sees when the link is pasted somewhere.
 *
 * 🚨 **A route with no entry keeps the site card**, which is correct for the homepage (the
 * shell's block already names it) and for every page nobody would paste. The doors that exist
 * and must NOT be previewed are listed as an explicit set below rather than left out, so a
 * later reader can tell "considered and refused" from "forgotten".
 *
 * Descriptions are user-facing copy, written under *How Anthers Talks About Itself*: one
 * complete sentence each, no figure a generator should own, and no claim the page itself does
 * not make.
 */

import { LEGAL_DOCUMENTS } from "../content/legal/index.js";

/** One standing page's share card. */
export interface PageMeta {
	/** The page's own name, without the site suffix the renderer appends. */
	title: string;
	/** One sentence: what reading the page gets you. */
	description: string;
}

/**
 * The pages that describe themselves, by path.
 *
 * Deliberately exact paths rather than patterns: these are the standing marketing, resource
 * and policy pages, and a new sibling should have to be added here to get a card rather than
 * inheriting one from a prefix it happens to sit under.
 */
const PAGES: Record<string, PageMeta> = {
	"/for-creators": {
		title: "For Creators",
		description:
			"Publish games, videos, music, and writing under one identity, with no platform cut on what your audience gives you.",
	},
	"/compare/itch-io": {
		title: "Compared to itch.io",
		description:
			"Where Anthers carries itch.io's creator-first publishing forward, and where the two platforms differ.",
	},
	"/compare/ghost": {
		title: "Compared to Ghost",
		description:
			"Two platforms with different missions: Ghost publishes writing, and Anthers publishes games, video, audio, and writing.",
	},
	"/about": {
		title: "About",
		description:
			"A nonprofit creative garden for everyone: what Anthers is, what its Articles require of it, and who it answers to.",
	},
	"/supporters": {
		title: "Supporters",
		description:
			"The people who support Anthers, with no amounts shown, and what their support funds.",
	},
	"/faq": {
		title: "FAQ",
		description:
			"Where the money goes, what supporting does, and what is not built yet, answered without dodging.",
	},
	"/parents": {
		title: "For Parents and Guardians",
		description:
			"What Anthers is, in plain language for parents and guardians, including the parts we cannot promise.",
	},
	"/abuse": {
		title: "Report Abuse",
		description:
			"How to report content that breaks the law or our rules, without an account and without saying who you are.",
	},
	"/copyright": {
		title: "Copyright & DMCA",
		description: "How to report copyright infringement on Anthers, and what happens next.",
	},
	"/resources": {
		title: "Resources",
		description:
			"The arithmetic behind Anthers, in the open: what a reader's money does, what a creator keeps, and where the organization's share goes.",
	},
	"/resources/pay-comparison": {
		title: "How Our Pay Compares",
		description:
			"What reaches a creator on Anthers compared with YouTube, Spotify, Steam, Bandcamp, Patreon, and Substack, on the current numbers.",
	},
	"/resources/creator-financials": {
		title: "Your Financials on Anthers",
		description:
			"A creator's year computed on their own audience, catalog, and sales, with the storage they would pay for shown beside it.",
	},
	"/resources/how-money-moves": {
		title: "How the Money Moves",
		description:
			"The money flow drawn to the percentage: what a subscription splits into, what a purchase passes through with, and what funds the charitable programs.",
	},
	"/resources/media-month": {
		title: "Your Media Month",
		description:
			"A month of media spending built out of what somebody already pays, and what each line pays out today against the same money on Anthers.",
	},
	"/release-notes": {
		title: "Release Notes",
		description:
			"Every numbered release, month by month, and what a user or a creator can do now that they could not before.",
	},
	"/status": {
		title: "Status",
		description: "What is running and what is not, answered fresh each time the page loads.",
	},
};

/**
 * Routes that exist and deliberately keep the site card.
 *
 * A sign-in or sign-up page is a door rather than a document: a preview of one would be
 * describing a form, and the address somebody pastes when they mean "come here and make an
 * account" is the page they were already on.
 */
const NO_CARD = new Set([
	"/login",
	"/signup",
	"/finish",
	"/welcome",
	"/subscribe",
	"/auth/atproto/callback",
	"/unsubscribe",
	"/desktop/authorize",
]);

/**
 * The served instruments, by the address that carries them.
 *
 * Their titles and summaries come from `content/legal` rather than being repeated here: an
 * instrument's own name is the one thing a second copy would eventually get wrong, and the
 * page already states it in the voice a card wants.
 */
const LEGAL_PATHS: Record<string, string> = {
	"/privacy": "privacy",
	"/terms": "terms",
	"/creator-terms": "creator-terms",
};

/** The page a path names, or null for the site card. */
export function pageMeta(pathname: string): PageMeta | null {
	const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
	if (NO_CARD.has(path)) return null;
	const page = PAGES[path];
	if (page) return page;
	const slug = LEGAL_PATHS[path];
	const legal = slug ? LEGAL_DOCUMENTS[slug] : undefined;
	return legal ? { title: legal.title, description: legal.summary } : null;
}
