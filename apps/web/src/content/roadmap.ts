// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The public roadmap — every high-level goal Anthers is working toward, sorted into
// three buckets and four groups.
//
// 🚨 **This is a hand-authored artifact and it is deliberately NOT derived from the
// planning roadmap in the vault** (Parker, 2026-08-30). That document is granular
// internal tracking — eighty-odd lanes, seven states, progress bars — written for the
// person doing the work. This one is high-level product goals written for somebody
// deciding whether to move their livelihood here. Different audience, different
// granularity, different voice, and a generator between them would have entrenched
// exactly the private-source arrangement Anthers is moving away from. The repository is
// public and `content/` already holds the legal instruments and the FAQ pool as their own
// primary source; the roadmap joins them.
//
// ⚠️ **The accepted cost, recorded rather than left to be discovered: nothing will notice
// when this page goes stale.** There is no check that can, because there is no second
// copy to disagree with. The mitigation is a prompt at the moment the information exists
// — `/roadmap-status` ends by naming the lanes that flipped to shipped and asking whether
// this file wants a `launched` entry — and never a pipeline.
//
// # The rules a new entry has to follow
//
// 1. 🚨 **`launched` carries a quarter; `active` and `planned` carry none, ever.** A
//    quarter on something shipped is retrospective fact. A quarter on something planned is
//    a promise, and Anthers does not hold global phases internally precisely because lanes
//    do not advance in lockstep. The page this replaced put *"federation functioning"*
//    inside a dated bar, which was both a schedule nobody held and a present-tense claim
//    about something that is signposted rather than scheduled.
// 2. 🚨 **Every unbuilt goal carries a `standing`, and the type will not let you omit
//    it.** *Nothing unbuilt is described in the present tense* is the wiki's rule, and a
//    prose-only entry breaks it by accident every time: a well-written blurb about a thing
//    that does not exist reads exactly like a description of a thing that does. Making the
//    absence a separate field rather than a sentence somebody remembers to add is what
//    makes the rule survive the next person. It failed on this file's own first draft —
//    nine entries described a feature with no hint it was missing.
// 3. **Goals, never tasks.** If an entry would be finished by one afternoon's work it is
//    too small; if it names a file, a table or an endpoint it is written for the wrong
//    person.
// 4. **Money figures are interpolated, never typed** — `bun run econ:figures --check`
//    scans this directory and a typed figure fails the build.
// 5. **Groups and subgroups are invented for a public audience.** They are not the vault
//    roadmap's track names: *Internal Practice* and *Reconciliation* mean nothing to a
//    creator.
//
// `roadmap.test.ts` enforces 1 and 2, so "make it consistent" cannot quietly undo either.

import { FREE_STORAGE_GIB, PUBLIC_ACCESS_PRICE } from "@anthers/shared/constants";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";

/**
 * Where a goal stands.
 *
 * Three, and there is deliberately no fourth. The page this replaced carried an
 * "Exploring" state alongside these, which in practice meant *planned, but we would like
 * room to change our minds* — a distinction that serves the writer and not the reader.
 * Something Anthers wants without having committed to it says so in its own `standing`.
 */
export type Bucket = "launched" | "active" | "planned";

/** A goal that is built and running. Dated, because a shipping date is a fact. */
export interface LaunchedItem {
	/** Stable across rewordings — it is the anchor a link can point at. */
	id: string;
	title: string;
	blurb: string;
	bucket: "launched";
	quarter: string;
}

/** A goal that is not built. Undated by rule 1, and honest by rule 2. */
export interface UnbuiltItem {
	id: string;
	title: string;
	/** What the goal is, and why it is worth wanting. */
	blurb: string;
	bucket: "active" | "planned";
	/**
	 * Where it actually stands today, in one sentence, leading with what is missing.
	 *
	 * This is the sentence a reader needs and the one a writer skips. Write *"None of it
	 * is built"* rather than *"we are working toward it"*, and name the thing that is
	 * absent rather than the state of the effort.
	 */
	standing: string;
}

export type RoadmapItem = LaunchedItem | UnbuiltItem;

export interface RoadmapSubgroup {
	label: string;
	items: RoadmapItem[];
}

export interface RoadmapGroup {
	id: string;
	label: string;
	/** One sentence, in the second person where the group is addressed to somebody. */
	blurb: string;
	subgroups: RoadmapSubgroup[];
}

/**
 * The quarter everything shipped so far belongs to.
 *
 * Anthers has exactly one, because nothing of note predates July 2026. When a second
 * arrives this stops being the only value anybody passes and becomes a field people fill
 * in — the type already allows that, so nothing changes but the data.
 */
export const SHIPPED_SO_FAR = "Q3 2026";

/** What each bucket means, said once, on the page, above the goals it holds. */
export const BUCKETS: { id: Bucket; label: string; blurb: string }[] = [
	{
		id: "active",
		label: "Active",
		blurb:
			"Being worked on now. Every one of them says where it actually stands, because a goal in this column does not work yet.",
	},
	{
		id: "planned",
		label: "Planned",
		blurb:
			"Committed to, and not started. Nothing here carries a date. Anthers does not run to global phases internally, so publishing quarters it does not hold would be a schedule nobody keeps.",
	},
	{
		id: "launched",
		label: "Launched",
		blurb:
			"Built, deployed, and running in production. Anthers has not opened to the public yet, so read this as what exists rather than what you can go and use this afternoon.",
	},
];

export const ROADMAP: RoadmapGroup[] = [
	{
		id: "creators",
		label: "For Creators",
		blurb: "Publishing your work here, being paid for it, and reaching the people who want it.",
		subgroups: [
			{
				label: "Publishing",
				items: [
					{
						id: "catalog",
						title: "Your Catalog of Works",
						blurb:
							"A game, an album, a film, a comic, an essay: each is a Work with its own page, its own dates and its own access. Nothing has to be announced in a post to exist, and nothing you publish is trapped inside a feed.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "media-kinds",
						title: "Every Medium, One Set of Rules",
						blurb:
							"Games, software, video, audio, images, ebooks and writing publish through the same editor into the same catalog. Video is transcoded for adaptive streaming, audio is normalized and given a waveform, and an uploaded PDF becomes a page-turning reader.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "studio",
						title: "The Creator Studio",
						blurb:
							"Everything you publish, edit, schedule and price, in one place, in the browser or in the desktop app.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "projects",
						title: "Projects",
						blurb:
							"Group Works and posts together: an album and its tracks, a game and its devlogs, a series and its episodes.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "posts",
						title: "Devlogs and Announcements",
						blurb:
							"A rich-text editor with scheduling and a visible edit history. A post announces a Work; it never owns one and it never gates one.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "importers",
						title: "Bringing Your Catalog Across",
						blurb:
							"One-step importers for what you already have somewhere else, starting with itch.io and going on to Patreon, Substack and YouTube. Some things cannot come across at all — a pledge relationship is one — and an importer should say so at the start rather than let you find out afterwards.",
						bucket: "active",
						standing:
							"None of the four works. The itch.io one is furthest along and its page is not reachable yet.",
					},
					{
						id: "desktop",
						title: "Anthers on Your Desktop",
						blurb:
							"The site and the Studio in a native window, so a large upload and the encoding before it happen outside a browser tab.",
						bucket: "active",
						standing:
							"It builds for Linux and is packaged for nothing else, so most people cannot install it.",
					},
					{
						id: "web-games",
						title: "Serving Web Games Ourselves",
						blurb:
							"Serving every file of a web build through the same access check as everything else, so that a gated web game is genuinely gated.",
						bucket: "planned",
						standing:
							"Not started. A browser-playable game here today is a sandboxed frame pointing at a host Anthers does not control, which makes a gated web game unlisted rather than protected.",
					},
					{
						id: "linux-manifest",
						title: "Running a Windows Build on Linux",
						blurb:
							"A published, openly specified manifest for each title, so a Windows-only build runs on Linux and so Heroic, Lutris, Bottles and anything nobody has written yet can support Anthers without our involvement. The specification comes before the tool, deliberately: shipping the tool first would rebuild launcher lock-in under a friendlier name.",
						bucket: "planned",
						standing: "Not started. Neither the specification nor the tool exists.",
					},
					{
						id: "work-versions",
						title: "Versions of a Work",
						blurb:
							"Versions with release notes, and the older build still reachable by somebody who wants it.",
						bucket: "planned",
						standing:
							"Not started. A game shipping a new build replaces the files on the same Work, with no history a buyer can see or return to.",
					},
				],
			},
			{
				label: "Getting Paid",
				items: [
					{
						id: "selling",
						title: "Selling a Work",
						blurb:
							"Set a price and the take-home sits next to it: what a buyer pays, what card processing costs, and what reaches you. Anthers takes no cut of a sale, and never will — that is a structural commitment rather than an introductory rate.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "creator-gates",
						title: "Your Own Badges, and Gating by Them",
						blurb:
							"Put a monthly threshold on a Work and design the rungs that clear it, with art you drew or a badge assembled from a shape, a field and an emblem. There is one kind of gate on Anthers and it points only at you.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "payouts",
						title: "Payouts to Your Own Account",
						blurb:
							"Onboard once and money reaches your bank rather than sitting in a platform balance. Completing that setup is also what lets you release anything, because it is how Anthers knows a creator is an adult without asking you for identification itself.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "time-pool",
						title: "Earning from the Time Pool",
						blurb:
							"Streaming work you left ungated earns in proportion to the time people spend with it, with a minute of reading, listening, playing and watching counted on the same clock. A creator working in text is not quietly worth less than a creator working in video.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "refunds",
						title: "Refunds a Buyer Can Ask For",
						blurb:
							"A stated policy, a window, and arithmetic that reverses the payout correctly rather than leaving a creator owing money they were told was theirs.",
						bucket: "active",
						standing:
							"The policy and the arithmetic run. Nothing in the interface reaches them, so a refund today is one person asking another.",
					},
					{
						id: "storage-billing",
						title: "Knowing What Your Storage Costs",
						blurb: `Your first ${FREE_STORAGE_GIB} GiB is free and paid for out of what users give Anthers. Above that you pay the object store's own rate plus half again, and nothing else — there is no charge for delivery, at any volume.`,
						bucket: "active",
						standing:
							"The arithmetic runs on a schedule. There is no invoice, no charge, and nowhere you can see your own usage against the allowance.",
					},
					{
						id: "publish-anywhere",
						title: "Publishing from Anywhere",
						blurb:
							"Somebody who never intends to sell anything should be able to publish from anywhere in the world.",
						bucket: "planned",
						standing:
							"Not started, and it is a live limit rather than a theoretical one: releasing a Work needs completed payout setup, and payout setup needs a country our payment processor supports. That gate does real work — it is the only adult check Anthers has — and it currently catches people it was never aimed at.",
					},
					{
						id: "processor-independence",
						title: "Not Depending on One Payment Company",
						blurb:
							"An interface in front of the processor is the cheapest and least useful third of this. The other two are payment details that can actually be carried somewhere else, and a second rail arranged before it is needed rather than during an incident. This is not a prediction about our processor, who have been good to work with. It is that the time to build an exit is while nothing is wrong.",
						bucket: "planned",
						standing: "Not started. All three parts are unbuilt.",
					},
					{
						id: "cheaper-rails",
						title: "Cheaper Ways to Pay",
						blurb:
							"A card's flat fee is the largest leak in the model and it bites hardest on the smallest payments. Paying by bank carries no flat fee, paying for several months at once replaces several fees with one, and instant bank-to-bank rails cost pennies and cannot be reversed months later. None of that saving would become Anthers' income, because it was never a cut we took — it would leave more for free access, or come back to the person paying.",
						bucket: "planned",
						standing: "Not started. A card is the only way to pay Anthers today.",
					},
				],
			},
			{
				label: "Reaching People",
				items: [
					{
						id: "profile",
						title: "A Public Profile and Catalog",
						blurb:
							"Your Works, your posts and the people who follow you, on one page at your own name.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "analytics",
						title: "Your Own Numbers",
						blurb:
							"Views, purchases and time spent, charted per Work, so you can see what people actually did rather than what a platform decided to tell you.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "notifications",
						title: "Being Told Something Happened",
						blurb:
							"Hearing when somebody engages with your work, and when a follower publishes something of theirs.",
						bucket: "active",
						standing:
							"Notifications exist and carry a handful of things — a refund, a report you filed, a purchase withdrawn from under you. Almost nothing else reaches anybody.",
					},
					{
						id: "custom-pages",
						title: "A Page That Looks Like You",
						blurb:
							"Choosing a layout, featuring particular work, and carrying your own links, so a profile reads as yours rather than as ours.",
						bucket: "active",
						standing: "Not built. Every creator profile is the same shape today.",
					},
					{
						id: "audience-export",
						title: "Taking Your Audience With You",
						blurb:
							"An export of who follows and supports you, so that leaving costs you as little of that relationship as it possibly can. Handles and follow dates always; a way to reach somebody only where they explicitly chose to share it, off by default; never payment or consumption data. Support is arranged between a person and Anthers rather than between a person and you, so what you get is an index over other people's own choices and not a customer list.",
						bucket: "planned",
						standing: "Not started, and the shape above is a commitment rather than a design.",
					},
					{
						id: "contests",
						title: "Contests and Calls for Content",
						blurb:
							"Open calls and contests across every medium, with judging, and with prizes held somewhere neither side controls.",
						bucket: "planned",
						standing:
							"Not started. This is something Anthers wants rather than something scheduled.",
					},
				],
			},
		],
	},
	{
		id: "audience",
		label: "For Readers, Players & Viewers",
		blurb:
			"Finding work worth your time, spending time with it, and paying the people who made it.",
		subgroups: [
			{
				label: "Finding Things",
				items: [
					{
						id: "browse",
						title: "Browsing the Catalog",
						blurb:
							"Filter everything published by medium, by tag, and by the project it belongs to.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "feed",
						title: "A Feed in the Order Things Happened",
						blurb:
							"Follow creators and see what they publish, newest first. Nothing reorders it and nothing is promoted into it.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "share-links",
						title: "Sharing Something You Found",
						blurb:
							"Send somebody a link and it opens what you could already open, and nothing more. A gated Work stays gated for whoever you sent it to, because the link is a way to reach a thing rather than a permission to have it.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "search",
						title: "Search That Finds People and Posts",
						blurb:
							"One search box that covers Works, the people who made them, and the things they wrote about them.",
						bucket: "active",
						standing:
							"Search finds Works. It says it also covers creators and posts and it does not, which is a promise the page is making that the code is not keeping. Several discovery views behind it are placeholders.",
					},
					{
						id: "layered-feeds",
						title: "Feeds You Choose",
						blurb:
							"A layer beyond the people you already follow, and feeds a person can assemble and hand to somebody else.",
						bucket: "planned",
						standing: "Not started. The chronological layer is the whole of what runs.",
					},
				],
			},
			{
				label: "Watching, Playing & Reading",
				items: [
					{
						id: "players",
						title: "A Real Player for Every Medium",
						blurb:
							"Adaptive video with a quality you can pick, an audio player that survives navigating away and draws the actual waveform, a page-turning reader for comics and books, and a sandboxed frame for a game you play in the browser.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "library",
						title: "Your Library",
						blurb:
							"A shelf for what you saved and what you bought, a lens that reads a project as an album, and a queue that keeps playing while you move around the site. Saving is curation and never entitlement, so nothing disappears from your shelf because of the view you are looking at it through.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "purchases-outlive",
						title: "What You Bought Stays Yours",
						blurb:
							"A purchase outlives the Work, the creator's account, and whatever the creator decides later. That is the floor, it holds today, and it is not waiting on anything.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "accessibility",
						title: "Accessibility Worth the Name",
						blurb:
							"A stated conformance level Anthers can be held to, tooling in the build that catches a regression, and every medium usable by somebody who does not use a mouse or a screen the way we assumed.",
						bucket: "active",
						standing:
							"Reduced motion is honored throughout and that is nearly all of it. There is no stated level, no tooling, and no captions.",
					},
					{
						id: "captions",
						title: "Captions and Transcripts",
						blurb:
							"For video and audio, with a way for a creator to supply their own rather than accept whatever a machine heard.",
						bucket: "planned",
						standing: "Not started. There are no captions anywhere on Anthers.",
					},
					{
						id: "playlists",
						title: "Playlists and a History",
						blurb:
							"Across every medium rather than only music, and yours to keep or delete like anything else about you.",
						bucket: "planned",
						standing:
							"Not started. The queue holds what you are playing now and remembers nothing after it.",
					},
					{
						id: "edge-entitlement",
						title: "Video That Starts Faster",
						blurb:
							"Every piece of a video is fetched through an address minted for that one request, which is what stops a locked file being handed to somebody who should not have it — and it is also why those pieces cannot be cached near you the way an ordinary file is. Moving the access check nearer to you fixes the wait and the cost together. The constraint that will not be traded away: the check moves, it does not disappear.",
						bucket: "planned",
						standing:
							"Not started. Simply caching the pieces is the version that quietly removes the gate, and it is the version Anthers will not ship.",
					},
				],
			},
			{
				label: "Supporting Creators",
				items: [
					{
						id: "support",
						title: "One Amount, Pointed Where You Want",
						blurb:
							"Give a monthly amount, in dollars, to a creator or to Anthers. What you give a creator reaches them with nothing taken by Anthers; the only deduction is card processing, and it is paid to the processor rather than to us.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "public-access",
						title: "Public Access",
						blurb: `Every streaming Work its creator left ungated is free to everybody. Every account gets ${FREE_PUBLIC_ACCESS_HOURS} hours of it a month, free forever, and $${PUBLIC_ACCESS_PRICE} a month to Anthers removes that limit — nothing above it buys any more access. Downloads are unlimited and are not metered at all.`,
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "badges",
						title: "Badges",
						blurb:
							"What you give Anthers each month is your Badge. There is no plan to choose and no menu of features to compare: the amount is the level, and you can change it whenever you like.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "directing",
						title: "Directing Your Support",
						blurb:
							"Split what you give across the creators you actually spend time with, and see where each dollar went.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "own-amount",
						title: "Giving an Amount of Your Own",
						blurb:
							"Deciding for yourself what Anthers is worth to you each month, at any number rather than at one of ours.",
						bucket: "active",
						standing:
							"A creator's page already takes any amount. The page where you set what you give Anthers still offers a fixed ladder, with no box to type your own number into.",
					},
					{
						id: "badge-perks",
						title: "What a Higher Badge Carries",
						blurb:
							"Giving Anthers more than the Public Access price buys no more access, deliberately: money must not buy standing in the commons. What it carries instead has to be something nobody else is made poorer by.",
						bucket: "planned",
						standing:
							"Not built. The perks listed beside the higher rungs today are an intention rather than a description, and nothing behind any of them exists.",
					},
				],
			},
		],
	},
	{
		id: "trust",
		label: "Trust & Safety",
		blurb:
			"What Anthers accepts, how it answers when something is wrong, and what happens to your data.",
		subgroups: [
			{
				label: "Content Standards",
				items: [
					{
						id: "ratings",
						title: "A Rating on Every Work",
						blurb:
							"Its creator declares it and an operator can correct it, and a correction changes the rating and nothing else. A Mature rating is a warning and something to filter on, never a price and never a paywall.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "adult",
						title: "Adult Work Is Invisible Until You Ask for It",
						blurb:
							"Not the work, not its title, not its cover art, to anybody who has not opted in and verified their age. It is otherwise ordinary work: it may be free, it may be Public Access, and it earns from the Time Pool like anything else. Restricting who may reach it is the whole of what the rating does.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "parental",
						title: "Parental Controls",
						blurb:
							"Block a creator or a whole medium, cap how long a day something may be used for, and lock all of it behind a PIN. The controls sit on the account doing the looking and never on the work being looked at, so one household's settings never reach anybody else's catalog.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "family-profiles",
						title: "Profiles Under One Account",
						blurb:
							"Separate profiles for a household, each with its own history and its own settings.",
						bucket: "planned",
						standing:
							"Not started. A household sharing an account today shares its history and its settings along with it.",
					},
					{
						id: "video-moderation",
						title: "Moderating Video at Scale",
						blurb:
							"What is being explored is a review queue and a sampling policy rather than an automatic classifier, because a machine that guesses at context is a machine that removes art, and slow is the better way to be wrong. It is signposted here because it needs solving before it is urgent rather than after.",
						bucket: "planned",
						standing:
							"Not started, and Anthers does not yet know how it will do this. Today a rating is the creator's own declaration corrected by report, and the only automatic scanning is the child-safety matching below, which finds known material and nothing else. That is honest at this size and it will not survive a catalog one person cannot watch.",
					},
				],
			},
			{
				label: "Reporting & Moderation",
				items: [
					{
						id: "reporting",
						title: "Reporting Something, and Blocking Somebody",
						blurb:
							"Report a comment, a rating, a person or a Work, and block anybody, from anywhere they appear.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "abuse-route",
						title: "Reporting Abuse Without an Account",
						blurb:
							"A public route for anything serious, reachable by somebody who has never signed up and never intends to.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "removal-state",
						title: "Removal Is a State, Never a Deletion",
						blurb:
							"Something taken down is marked rather than erased, so that an appeal years later has a record to read instead of an absence to argue with.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "operator-console",
						title: "An Operator Console Worth Using",
						blurb:
							"Every moderation control reachable from a screen, so that this work does not depend on one person knowing how to drive it by hand.",
						bucket: "active",
						standing:
							"The moderation queue and the rating appeals have a real interface. Most of the other controls exist as an endpoint and nothing else.",
					},
				],
			},
			{
				label: "Copyright",
				items: [
					{
						id: "dmca",
						title: "A Copyright Process That Actually Runs",
						blurb:
							"A registered agent, a public form for a notice, counter-notices, the statutory clocks running on a timer rather than on somebody remembering, access denied while a notice stands, and every buyer refunded if it becomes final.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "dmca-transparency",
						title: "Published Transparency Counts",
						blurb:
							"How many notices arrived, how many were contested, and how many stood — published on the site and updating itself rather than waiting on an annual report.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
				],
			},
			{
				label: "Your Data",
				items: [
					{
						id: "child-safety",
						title: "Child Safety at the Statutory Floor",
						blurb:
							"Anthers is a registered electronic service provider with the National Center for Missing & Exploited Children. Uploaded images and video frames are matched against known illegal material before anything is released, and a match is quarantined and reported. Nobody here is ever shown the material, which is deliberate, and is why no screen exists that could display it.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "export-delete",
						title: "Take Your Data and Go",
						blurb:
							"Export everything you have here, and schedule your account's deletion with room to change your mind before it runs. Deleting an account also withdraws any authorization Anthers holds elsewhere rather than leaving it live on a server you no longer deal with.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "retention",
						title: "Records Kept Only as Long as They Are Needed",
						blurb:
							"An overnight job removes what has aged out of its retention window, and a legal hold stops it where the law requires a record to survive.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "legal-dates",
						title: "Dating the Legal Documents",
						blurb:
							"An effective date on the Privacy Policy, the Terms and the Creator Terms, so that they bind rather than describe.",
						bucket: "active",
						standing:
							"All three are published in full and carry no effective date, with a banner on each saying so. What they wait on is a board adopting them and an outside review, not more drafting — and a date is a deliberate act rather than a tidy-up, which is why one has not quietly been added.",
					},
					{
						id: "eu-duties",
						title: "Meeting the European and UK Duties in Full",
						blurb:
							"The obligations that come with serving people in those places, met rather than approximated.",
						bucket: "planned",
						standing:
							"The public reporting route those regimes require is built and served. The risk assessment meant to sit behind it has not been done.",
					},
				],
			},
		],
	},
	{
		id: "organization",
		label: "The Organization",
		blurb:
			"What Anthers is as a corporation, where its own money goes, and what it has committed to doing in the open.",
		subgroups: [
			{
				label: "Becoming a Nonprofit",
				items: [
					{
						id: "incorporated",
						title: "Incorporated, with a Federal Identification Number",
						blurb:
							"Anthers, Inc. is a Colorado nonprofit corporation with an EIN. There are no investors and no profit-taking: it cannot be acquired, and it cannot take corrupting investment.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "board-policies",
						title: "A Board, and Policies It Has Adopted",
						blurb:
							"A real board of more than one person, and the governance documents adopted by it rather than merely written.",
						bucket: "active",
						standing:
							"Bylaws and seven policies are drafted and none of them is adopted, because adopting one is an act of a board and the board is one person. Anthers says that plainly rather than describing governance it does not have.",
					},
					{
						id: "federal-recognition",
						title: "Filing for Federal Recognition",
						blurb: "Anthers will be filing for federal 501(c)(3) recognition.",
						bucket: "active",
						standing:
							"It has not filed. Until a determination letter arrives, money given to Anthers is not deductible, and nobody here will tell you otherwise.",
					},
					{
						id: "going-live",
						title: "Moving Real Money",
						blurb:
							"Opening the corporation's bank account and turning on live payments — among the last things standing between Anthers and opening its doors.",
						bucket: "active",
						standing:
							"Payments run against the processor's test mode, which is why nothing you do here can charge you. The account is not open and the switch has not been thrown.",
					},
				],
			},
			{
				label: "Where the Money Goes",
				items: [
					{
						id: "time-pool-half",
						title: "Half of What You Give Anthers Pays Creators",
						blurb:
							"The Time Pool is a fixed half of what is given to Anthers, distributed daily by the time people spent and settled monthly. The rest covers the at-cost payments line and leaves a remainder, and that remainder funds free access and Anthers' charitable programs. None of it is platform profit, because there is no such thing here.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "generated-figures",
						title: "Every Published Money Figure Is Generated",
						blurb:
							"No figure on this site is typed by hand. They all come out of one model, and a check fails the build if a page and the model ever disagree — which makes it a promise you can verify rather than one you have to take.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "real-cycle",
						title: "A Full Month Against Real Revenue",
						blurb:
							"One complete cycle — money in, time counted, creators paid, the remainder settled — run against money somebody actually gave.",
						bucket: "active",
						standing:
							"The arithmetic runs on a schedule and is proven by test, and it has never once run against real revenue. That is the point at which it stops being theoretical.",
					},
					{
						id: "programs",
						title: "The Charitable Programs",
						blurb:
							"What the remainder funds beyond free access: helping creators who cannot carry their own costs, and work that benefits people who are not on Anthers at all.",
						bucket: "planned",
						standing: "The funding arithmetic runs. No program has started.",
					},
					{
						id: "donations",
						title: "Accepting Donations",
						blurb: "A way to give Anthers money without it being support for anything in return.",
						bucket: "planned",
						standing:
							"Not started, and blocked rather than merely unscheduled: charitable-solicitation registration has to come before Anthers asks anybody for anything.",
					},
				],
			},
			{
				label: "Running It Well",
				items: [
					{
						id: "deploy-safety",
						title: "Deploys That Cannot Quietly Go Wrong",
						blurb:
							"Configuration reaches production down one safe path, and checks run every hour comparing what is actually running against what is committed. Both exist because the obvious path once emptied every production secret in a single command, and because a check that has stopped watching anything looks exactly like one that is passing.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "scale",
						title: "Growing Without Falling Over",
						blurb:
							"Indexed search, paging on the listings that have none, and a stated point at which each part of the system is given more room.",
						bucket: "active",
						standing:
							"Search runs a scan rather than an index, several listings have no paging at all, and the database's connection budget binds before anything anybody expects. None of it matters at today's size, and all of it matters well before Anthers is three times bigger.",
					},
					{
						id: "backups",
						title: "Backups You Can Trust",
						blurb:
							"Copies kept somewhere else on a schedule, a restore rehearsed and timed so the recovery time is a measurement rather than a hope, and a failure that reaches a person instead of passing quietly.",
						bucket: "planned",
						standing:
							"Not started, and it is the work on this page Anthers would least like to be caught without.",
					},
					{
						id: "observability",
						title: "Knowing Something Broke",
						blurb:
							"Error tracking, metrics, and alerts that reach somebody, plus rate limits on the few public paths that still have none.",
						bucket: "planned",
						standing:
							"Not started. Finding out that something is wrong currently means reading logs, which means somebody thinking to look.",
					},
				],
			},
			{
				label: "Building in the Open",
				items: [
					{
						id: "open-source",
						title: "The Source Is Public",
						blurb:
							"Everything that runs Anthers is on GitHub under the AGPL. Not a mirror and not a subset: the thing itself, so anybody can check whether the platform does what these pages say it does.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "wiki",
						title: "Documentation Anybody Can Read",
						blurb:
							"How the model works, what the policies say, what the standards are, and why each was chosen that way.",
						bucket: "active",
						standing:
							"It is written and it is thorough, and it is not served from this site, which makes it the largest thing Anthers knows and has not published.",
					},
					{
						id: "changelog",
						title: "A Changelog Beside This Page",
						blurb:
							"A record of what actually shipped and when, so that progress is checkable rather than asserted.",
						bucket: "active",
						standing:
							"It does not exist. This page is written by hand and derived from nothing, which is deliberate and is also the risk: nothing will notice when it drifts away from what is true.",
					},
				],
			},
			{
				label: "Federation & Portability",
				items: [
					{
						id: "bluesky-identity",
						title: "Signing In with Bluesky",
						blurb:
							"Sign in, sign up, or link an identity you already have. Anthers still verifies every signup with its own emailed code, because another server's word about your address is that server's assertion rather than proof — and nobody is ever turned away for not having one.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "network-catalog",
						title: "Your Catalog as Records You Own",
						blurb:
							"A listing of your work published into a repository you control, so that the listing outlives any one host. The listing only, and never the work itself, which no repository on that network could hold privately.",
						bucket: "planned",
						standing:
							"Not started, and blocked on permissions the protocol does not yet offer at the right grain: the only scope available today is power over somebody's whole account, and that is not a thing to ask a creator for.",
					},
					{
						id: "identity-hosting",
						title: "Hosting Identities Here",
						blurb:
							"Anthers running the identity server for anybody who wants one, which resolves the permission problem above in a single step rather than one schema at a time.",
						bucket: "planned",
						standing: "Not started.",
					},
					{
						id: "creator-hosted",
						title: "Creators Serving Their Own Files",
						blurb:
							"Delivering your own work from your own machine while everything else stays here. What decides pay is whether you gated the work and never who served the bytes, so a creator hosting their own delivery still earns from the Time Pool.",
						bucket: "planned",
						standing:
							"Not started. It is signposted rather than scheduled, and it will never be sold to you as a way to save Anthers money.",
					},
				],
			},
		],
	},
];

/** Every subgroup of `group` that holds an item in `bucket`, in authored order. */
export function itemsIn(group: RoadmapGroup, bucket: Bucket): RoadmapSubgroup[] {
	return group.subgroups
		.map((sub) => ({ ...sub, items: sub.items.filter((i) => i.bucket === bucket) }))
		.filter((sub) => sub.items.length > 0);
}

/** Every item on the roadmap, flattened. */
export function allItems(): RoadmapItem[] {
	return ROADMAP.flatMap((g) => g.subgroups.flatMap((s) => s.items));
}

/** How many goals sit in `bucket`, across every group. Rendered as a count on the page. */
export function countIn(bucket: Bucket): number {
	return allItems().filter((i) => i.bucket === bucket).length;
}

/**
 * The distinct quarters holding launched work, oldest label first.
 *
 * Sorting the label works because the labels are `Q<n> <year>` and everything is this
 * century; when that stops being good enough there will be more than one of them and a
 * real comparator will be obvious.
 */
export function shippedQuarters(): string[] {
	const seen = new Set<string>();
	for (const item of allItems()) if (item.bucket === "launched") seen.add(item.quarter);
	return [...seen].sort((a, b) => a.slice(3).localeCompare(b.slice(3)) || a.localeCompare(b));
}
