// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The public roadmap — every high-level goal Anthers is working toward, sorted into
// three buckets and four groups.
//
// ⏳ **This file is a way station.** The settled direction (Parker, 2026-09-03) is that
// the documentation, the roadmap and the task board all become public together, authored
// in `Anthers-Wiki` in Obsidian and pushed to the site by an exporter — because publishing
// three surfaces separately means maintaining the links between them by hand. The plan is
// *Publishing the Wiki, Roadmap and Tasks 20260903* in the vault's Transient folder. **The
// content below is written to survive that move; the TypeScript around it is not.** Do not
// invest in the shape of this module, and do not add a field the exporter would have to
// reproduce.
//
// 🚨 **It is still not derived from the private roadmap, and that is permanent.** The
// public and private roadmaps have different audiences, granularity and voice, and a
// generator between them would entrench the private-source arrangement Anthers is
// dismantling. What changes under the plan above is that the *source moves to the public
// vault* — which is the inversion that rule was pointing at, not a breach of it.
//
// # The rules a new entry has to follow
//
// 1. 🚨 **`launched` carries a quarter; `active` and `planned` carry none, ever.** A
//    quarter on something shipped is retrospective fact. A quarter on something planned is
//    a promise, and Anthers does not hold global phases internally precisely because lanes
//    do not advance in lockstep. The page this replaced put *"federation functioning"*
//    inside a dated bar, which was both a schedule nobody held and a present-tense claim.
// 2. 🚨 **Say it in one short sentence.** `MAX_BLURB` is enforced, and the limit is the
//    honesty mechanism rather than a style preference. The first draft of this file ran
//    three or four sentences per goal, and the length is what made it read as marketing —
//    a persuasive paragraph about something unbuilt is indistinguishable from a
//    description of something that works, which is exactly the failure the wiki's *nothing
//    unbuilt is described in the present tense* exists to prevent. **Concision plus the
//    status pill on the card is what carries the tense now.**
// 3. **A `note` is for a partial state that would otherwise mislead** — something that
//    exists but does not do what its name implies, or something blocked rather than merely
//    unscheduled. It is not for restating that a planned thing is not built; the pill says
//    that. Roughly a third of the entries earn one.
// 4. **`doc` names the wiki page that explains the thing**, by its Johnny.Decimal id and
//    title rather than by a URL. The wiki is not served yet and how it will be served is
//    an open decision, so inventing a path now would bake in a guess — see {@link docHref}.
// 5. **Money figures are interpolated, never typed** — `bun run econ:figures --check`
//    scans this directory and a typed figure fails the build.

import { FREE_STORAGE_GIB, PUBLIC_ACCESS_PRICE } from "@anthers/shared/constants";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";

/** Where a goal stands. Rendered as a pill on the card, so every card carries its tense. */
export type Bucket = "launched" | "active" | "planned";

/**
 * A page in `Anthers-Wiki`, named by identity rather than by address.
 *
 * 🚨 **Deliberately not a URL.** The wiki is not served from this site, and *how* it will
 * be served is one of the open decisions — so a path written here today would be a guess
 * that hardens into a broken link. The Johnny.Decimal id and the page title are stable
 * facts about the vault, and `roadmap.test.ts` checks every one of them against the real
 * files when the vault is present.
 */
export interface DocRef {
	/** Johnny.Decimal id, e.g. `"30.02"`. */
	id: string;
	/** The page's title with the id stripped, e.g. `"Releasing a Work"`. */
	title: string;
}

export interface LaunchedItem {
	id: string;
	title: string;
	blurb: string;
	bucket: "launched";
	quarter: string;
	note?: string;
	doc?: DocRef;
}

export interface UnbuiltItem {
	id: string;
	title: string;
	blurb: string;
	bucket: "active" | "planned";
	note?: string;
	doc?: DocRef;
}

export type RoadmapItem = LaunchedItem | UnbuiltItem;

export interface RoadmapSubgroup {
	label: string;
	items: RoadmapItem[];
}

export interface RoadmapGroup {
	id: string;
	label: string;
	blurb: string;
	subgroups: RoadmapSubgroup[];
}

/** One short sentence. See rule 2 — this is the honesty mechanism, not a style rule. */
export const MAX_BLURB = 150;

/** A note is a correction to an impression, not a second description. */
export const MAX_NOTE = 95;

/**
 * The quarter everything shipped so far belongs to. Anthers has one, because nothing of
 * note predates July 2026.
 */
export const SHIPPED_SO_FAR = "Q3 2026";

/**
 * Where a wiki page can be read, or `null` while the wiki is not served.
 *
 * ⏳ Returns `null` today for every page, which is why the documentation buttons render as
 * inert chips rather than links. That is deliberate and visible: an inert chip naming a
 * real page tells a reader the documentation exists and has not been published, which is
 * true and is itself one of the goals on this page. **A button that navigated to a 404
 * would be the failure this avoids** — a route reference nothing can follow typechecks,
 * lints, and passes every test, which is how Connect's onboarding pointed at a Studio page
 * that had never existed.
 *
 * When the wiki ships, this one function learns the scheme and every button on the page
 * becomes a link. Nothing else changes.
 */
export function docHref(_doc: DocRef): string | null {
	return null;
}

/** What each bucket means, said once, above the goals it holds. */
export const BUCKETS: { id: Bucket; label: string; blurb: string }[] = [
	{
		id: "active",
		label: "Active",
		blurb: "Being worked on now. Nothing in this column works yet.",
	},
	{
		id: "planned",
		label: "Planned",
		blurb:
			"Committed to, and not started. Nothing here carries a date — a quarter on something planned is a promise, and Anthers would rather give you the order of things.",
	},
	{
		id: "launched",
		label: "Launched",
		blurb:
			"Built and running in production. Anthers has not opened to the public yet, so this is what exists rather than what you can go and use today.",
	},
];

export const ROADMAP: RoadmapGroup[] = [
	{
		id: "creators",
		label: "For Creators",
		blurb: "Publishing your work, being paid for it, and reaching the people who want it.",
		subgroups: [
			{
				label: "Publishing",
				items: [
					{
						id: "catalog",
						title: "A Catalog of Works",
						blurb:
							"Each Work has its own page, dates and access. Nothing has to be announced in a post to exist.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "30.02", title: "Releasing a Work" },
					},
					{
						id: "media-kinds",
						title: "Every Medium, One Set of Rules",
						blurb:
							"Games, software, video, audio, images, ebooks and writing, through one editor into one catalog.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "30.01", title: "What You Can Publish" },
					},
					{
						id: "studio",
						title: "The Creator Studio",
						blurb: "Everything you publish, edit, schedule and price, in one place.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "projects",
						title: "Projects",
						blurb: "Group Works and posts: an album and its tracks, a game and its devlogs.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "30.03", title: "Projects" },
					},
					{
						id: "posts",
						title: "Devlogs and Announcements",
						blurb:
							"A rich-text editor with scheduling and a visible edit history. A post announces a Work; it never gates one.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "importers",
						title: "Bringing Your Catalog Across",
						blurb: "One-step imports from itch.io, Patreon, Substack and YouTube.",
						bucket: "active",
						note: "None of the four works yet.",
					},
					{
						id: "desktop",
						title: "Anthers on Your Desktop",
						blurb:
							"A native window, so a large upload and its encoding happen outside a browser tab.",
						bucket: "active",
						note: "Builds for Linux and is packaged for nothing else.",
					},
					{
						id: "web-games",
						title: "Serving Web Games Ourselves",
						blurb:
							"Every file of a web build served through the same access check as everything else.",
						bucket: "planned",
						note: "Today a web game is a frame pointing at a host we do not control.",
					},
					{
						id: "linux-manifest",
						title: "Running a Windows Build on Linux",
						blurb:
							"An openly specified manifest per title, so Heroic, Lutris and Bottles can support Anthers without our involvement.",
						bucket: "planned",
					},
					{
						id: "work-versions",
						title: "Versions of a Work",
						blurb: "Release notes, and the older build still reachable by somebody who wants it.",
						bucket: "planned",
						note: "A new build replaces the files today, with no history to return to.",
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
							"Set a price and see the take-home beside it. Anthers takes no cut of a sale, and never will.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "31.01", title: "Selling a Work" },
					},
					{
						id: "creator-gates",
						title: "Your Own Badges, and Gating by Them",
						blurb:
							"A monthly threshold on a Work, and rungs you design. There is one kind of gate and it points only at you.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "32.01", title: "Gating a Work" },
					},
					{
						id: "payouts",
						title: "Payouts to Your Own Account",
						blurb:
							"Money reaches your bank rather than a platform balance. Completing setup is also what lets you release.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "31.02", title: "Payouts" },
					},
					{
						id: "time-pool",
						title: "Earning from the Time Pool",
						blurb:
							"Ungated streaming work earns by time spent, with reading, listening, playing and watching on one clock.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "40.02", title: "What the Time Pool Pays For" },
					},
					{
						id: "refunds",
						title: "Refunds a Buyer Can Ask For",
						blurb: "A window, a policy, and arithmetic that reverses the payout correctly.",
						bucket: "active",
						note: "The policy runs. Nothing in the interface reaches it.",
						doc: { id: "31.01", title: "Selling a Work" },
					},
					{
						id: "storage-billing",
						title: "Knowing What Your Storage Costs",
						blurb: `Your first ${FREE_STORAGE_GIB} GiB is free. Above it you pay the object store's rate plus half again, and nothing for delivery.`,
						bucket: "active",
						note: "No invoice, no charge, and nowhere to see your usage.",
						doc: { id: "31.04", title: "How Much Space Your Work Takes" },
					},
					{
						id: "publish-anywhere",
						title: "Publishing from Anywhere",
						blurb: "Publishing without needing to be somewhere our payment processor operates.",
						bucket: "planned",
						note: "It currently blocks people who never meant to sell anything.",
						doc: { id: "31.02", title: "Payouts" },
					},
					{
						id: "processor-independence",
						title: "Not Depending on One Payment Company",
						blurb:
							"Payment details that can be carried elsewhere, and a second rail arranged before it is needed rather than during an incident.",
						bucket: "planned",
						doc: { id: "70.09", title: "How Money Moves" },
					},
					{
						id: "cheaper-rails",
						title: "Cheaper Ways to Pay",
						blurb:
							"Bank payments, several months at once, and instant rails. None of the saving becomes Anthers' income.",
						bucket: "planned",
						doc: { id: "40.01", title: "What a Creator Takes Home" },
					},
				],
			},
			{
				label: "Reaching People",
				items: [
					{
						id: "profile",
						title: "A Public Profile and Catalog",
						blurb: "Your Works, your posts and your followers, on one page at your own name.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "analytics",
						title: "Your Own Numbers",
						blurb: "Views, purchases and time spent, charted per Work.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "70.05", title: "How Attention Is Counted" },
					},
					{
						id: "notifications",
						title: "Being Told Something Happened",
						blurb:
							"Hearing when somebody engages with your work, or a creator you follow publishes.",
						bucket: "active",
						note: "Carries a refund and a report. Almost nothing else reaches anybody.",
					},
					{
						id: "custom-pages",
						title: "A Page That Looks Like You",
						blurb: "A layout you choose, work you feature, and your own links.",
						bucket: "active",
						note: "Every creator profile is the same shape today.",
					},
					{
						id: "audience-export",
						title: "Taking Your Audience With You",
						blurb:
							"An export of who follows you, so leaving costs you as little of that as possible. Never payment or consumption data.",
						bucket: "planned",
					},
					{
						id: "contests",
						title: "Contests and Calls for Content",
						blurb:
							"Open calls across every medium, with judging and prizes held where neither side controls them.",
						bucket: "planned",
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
						blurb: "Filter everything published by medium, tag and project.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "feed",
						title: "A Feed in the Order Things Happened",
						blurb: "Newest first. Nothing reorders it and nothing is promoted into it.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "24.00", title: "Your Feed" },
					},
					{
						id: "share-links",
						title: "Sharing Something You Found",
						blurb:
							"A link opens what you could already open, and nothing more. A gated Work stays gated.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "20.02", title: "Share Links" },
					},
					{
						id: "search",
						title: "Search That Finds People and Posts",
						blurb: "One box covering Works, the people who made them, and what they wrote.",
						bucket: "active",
						note: "It says it covers creators and posts. It does not.",
					},
					{
						id: "layered-feeds",
						title: "Feeds You Choose",
						blurb:
							"A layer beyond who you already follow, and feeds a person can build and hand to somebody else.",
						bucket: "planned",
						doc: { id: "24.00", title: "Your Feed" },
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
							"Adaptive video, an audio player that survives navigation, a page reader for comics and books, and games in the browser.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "70.04", title: "How a File Reaches You" },
					},
					{
						id: "library",
						title: "Your Library",
						blurb:
							"What you saved and what you bought, a lens that reads a project as an album, and a queue that keeps playing.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "22.01", title: "What Stays Yours" },
					},
					{
						id: "purchases-outlive",
						title: "What You Bought Stays Yours",
						blurb:
							"A purchase outlives the Work, the creator's account, and whatever the creator decides later.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "22.03", title: "What Owning It Means Elsewhere" },
					},
					{
						id: "accessibility",
						title: "Accessibility Worth the Name",
						blurb:
							"A stated conformance level, tooling that catches a regression, and every medium usable.",
						bucket: "active",
						note: "Reduced motion is honored. Very little else is.",
						doc: { id: "23.01", title: "Accessibility" },
					},
					{
						id: "captions",
						title: "Captions and Transcripts",
						blurb:
							"For video and audio, with a way to supply your own rather than accept what a machine heard.",
						bucket: "planned",
						note: "There are no captions anywhere on Anthers.",
						doc: { id: "23.01", title: "Accessibility" },
					},
					{
						id: "playlists",
						title: "Playlists and a History",
						blurb: "Across every medium rather than only music, and yours to keep or delete.",
						bucket: "planned",
						doc: { id: "22.02", title: "Listening to Music" },
					},
					{
						id: "edge-entitlement",
						title: "Video That Starts Faster",
						blurb:
							"Moving the access check closer to you, so video can be cached near you. The check moves; it does not disappear.",
						bucket: "planned",
						doc: { id: "70.04", title: "How a File Reaches You" },
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
							"A monthly amount to a creator or to Anthers. What you give a creator reaches them, less only card processing.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "11.01", title: "What You Give, and Where It Goes" },
					},
					{
						id: "public-access",
						title: "Public Access",
						blurb: `Ungated streaming work is free to everybody. Every account gets ${FREE_PUBLIC_ACCESS_HOURS} hours a month forever, and $${PUBLIC_ACCESS_PRICE} removes the limit.`,
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "11.02", title: "What Is Free, and What Is Gated" },
					},
					{
						id: "badges",
						title: "Badges",
						blurb: "What you give Anthers each month is your Badge. There is no plan to choose.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "21.01", title: "Badges" },
					},
					{
						id: "directing",
						title: "Directing Your Support",
						blurb:
							"Split what you give across the creators you spend time with, and see where it went.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "21.02", title: "Directing Your Support" },
					},
					{
						id: "own-amount",
						title: "Giving an Amount of Your Own",
						blurb: "Deciding what Anthers is worth to you, at any number rather than one of ours.",
						bucket: "active",
						note: "A creator's page takes any amount. Anthers' page does not.",
						doc: { id: "21.01", title: "Badges" },
					},
					{
						id: "badge-perks",
						title: "What a Higher Badge Carries",
						blurb:
							"Giving above the Public Access price buys no more access, by design. What it carries instead must make nobody else poorer.",
						bucket: "planned",
						note: "The perks listed beside the higher rungs are not built.",
						doc: { id: "21.01", title: "Badges" },
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
							"Declared by its creator and correctable by an operator. A Mature rating is a warning, never a paywall.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "50.01", title: "The Rating Standard" },
					},
					{
						id: "adult",
						title: "Adult Work Is Invisible Until You Ask for It",
						blurb:
							"Not the work, its title or its cover, to anybody who has not opted in and verified. It is otherwise ordinary work.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "50.01", title: "The Rating Standard" },
					},
					{
						id: "parental",
						title: "Parental Controls",
						blurb:
							"Block a creator or a medium, cap time per day, and lock it behind a PIN. The controls sit on the account, not the work.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "50.01", title: "The Rating Standard" },
					},
					{
						id: "family-profiles",
						title: "Profiles Under One Account",
						blurb: "Separate profiles for a household, each with its own history and settings.",
						bucket: "planned",
						note: "A household sharing an account shares its history today.",
					},
					{
						id: "video-moderation",
						title: "Moderating Video at Scale",
						blurb:
							"A review queue and a sampling policy rather than an automatic classifier, because a machine that guesses at context removes art.",
						bucket: "planned",
						note: "Anthers does not yet know how it will do this.",
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
							"Report a comment, a rating, a person or a Work, and block anybody from anywhere they appear.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "51.01", title: "Reporting Something" },
					},
					{
						id: "abuse-route",
						title: "Reporting Abuse Without an Account",
						blurb:
							"A public route for anything serious, reachable by somebody who never signed up.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "51.01", title: "Reporting Something" },
					},
					{
						id: "removal-state",
						title: "Removal Is a State, Never a Deletion",
						blurb:
							"So an appeal years later has a record to read rather than an absence to argue with.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "51.02", title: "How Removal Works" },
					},
					{
						id: "operator-console",
						title: "An Operator Console Worth Using",
						blurb: "Every moderation control reachable from a screen rather than by hand.",
						bucket: "active",
						note: "Two queues have a screen. The rest are API calls.",
						doc: { id: "51.02", title: "How Removal Works" },
					},
				],
			},
			{
				label: "Copyright",
				items: [
					{
						id: "dmca",
						title: "A Copyright Process That Runs",
						blurb:
							"A registered agent, a public notice form, counter-notices, clocks on a timer, and every buyer refunded if a notice becomes final.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "54.01", title: "Filing a Notice" },
					},
					{
						id: "dmca-transparency",
						title: "Published Transparency Counts",
						blurb:
							"How many notices arrived, how many were contested and how many stood, updating itself.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "54.03", title: "What Anthers Does Not Do" },
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
							"A registered provider with NCMEC. Uploads are matched against known illegal material, and a match is quarantined and reported.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "52.00", title: "Child Safety" },
					},
					{
						id: "export-delete",
						title: "Take Your Data and Go",
						blurb:
							"Export everything, and schedule deletion with room to change your mind before it runs.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
					},
					{
						id: "retention",
						title: "Records Kept Only as Long as They Are Needed",
						blurb:
							"An overnight job removes what has aged out, and a legal hold stops it where the law requires.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "63.00", title: "Policies" },
					},
					{
						id: "legal-dates",
						title: "Dating the Legal Documents",
						blurb: "An effective date on the Privacy Policy, the Terms and the Creator Terms.",
						bucket: "active",
						note: "All three are published without one, and say so.",
						doc: { id: "63.00", title: "Policies" },
					},
					{
						id: "eu-duties",
						title: "Meeting the European and UK Duties in Full",
						blurb:
							"The obligations that come with serving people there, met rather than approximated.",
						bucket: "planned",
						note: "The reporting route is built. The risk assessment is not.",
					},
				],
			},
		],
	},
	{
		id: "organization",
		label: "The Organization",
		blurb:
			"What Anthers is as a corporation, where its own money goes, and what it does in the open.",
		subgroups: [
			{
				label: "Becoming a Nonprofit",
				items: [
					{
						id: "incorporated",
						title: "Incorporated, with a Federal Identification Number",
						blurb:
							"A Colorado nonprofit corporation. No investors and no profit-taking: it cannot be acquired.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "60.00", title: "Who We Are" },
					},
					{
						id: "board-policies",
						title: "A Board, and Policies It Has Adopted",
						blurb:
							"More than one director, and governance documents adopted rather than merely written.",
						bucket: "active",
						note: "Seven policies drafted, none adopted. The board is one person.",
						doc: { id: "63.00", title: "Policies" },
					},
					{
						id: "federal-recognition",
						title: "Filing for Federal Recognition",
						blurb: "Anthers will be filing for federal 501(c)(3) recognition.",
						bucket: "active",
						note: "Not filed. Money given to Anthers is not deductible yet.",
						doc: { id: "10.04", title: "Why a Nonprofit" },
					},
					{
						id: "going-live",
						title: "Moving Real Money",
						blurb:
							"The corporation's bank account, and live payments — among the last things before opening.",
						bucket: "active",
						note: "Payments run in test mode, so nothing here can charge you.",
						doc: { id: "70.09", title: "How Money Moves" },
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
							"Distributed daily by time spent and settled monthly. The remainder funds free access and the programs.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "40.00", title: "The Support Model" },
					},
					{
						id: "generated-figures",
						title: "Every Published Money Figure Is Generated",
						blurb:
							"No figure on this site is typed by hand, and a check fails the build if a page and the model disagree.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "81.02", title: "The Figures Guard" },
					},
					{
						id: "real-cycle",
						title: "A Full Month Against Real Revenue",
						blurb: "Money in, time counted, creators paid, the remainder settled.",
						bucket: "active",
						note: "Proven by test and never run against real revenue.",
						doc: { id: "40.00", title: "The Support Model" },
					},
					{
						id: "programs",
						title: "The Charitable Programs",
						blurb:
							"Helping creators who cannot carry their own costs, and work benefiting people who are not on Anthers.",
						bucket: "planned",
						note: "The funding arithmetic runs. No program has started.",
						doc: { id: "42.03", title: "What the Programs Will Do" },
					},
					{
						id: "donations",
						title: "Accepting Donations",
						blurb: "A way to give Anthers money without it being support for anything in return.",
						bucket: "planned",
						note: "Blocked on charitable-solicitation registration.",
						doc: { id: "42.01", title: "How the Programs Are Funded" },
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
							"One safe path to production, and hourly checks comparing what is running against what is committed.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "83.01", title: "The Description Is Not the Thing" },
					},
					{
						id: "scale",
						title: "Growing Without Falling Over",
						blurb:
							"Indexed search, paging on the listings without it, and a stated point to add capacity.",
						bucket: "active",
						note: "Search scans rather than indexes, and listings do not page.",
						doc: { id: "70.02", title: "Where Anthers Runs" },
					},
					{
						id: "backups",
						title: "Backups You Can Trust",
						blurb:
							"Copies kept elsewhere on a schedule, a restore rehearsed and timed, and a failure that reaches a person.",
						bucket: "planned",
						doc: { id: "83.00", title: "Operations" },
					},
					{
						id: "observability",
						title: "Knowing Something Broke",
						blurb:
							"Error tracking, metrics and alerts, plus rate limits on the paths without them.",
						bucket: "planned",
						note: "Finding out today means somebody thinking to read logs.",
						doc: { id: "83.02", title: "Checks That Can Actually Fail" },
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
							"Everything that runs Anthers, on GitHub under the AGPL. Not a mirror and not a subset.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "80.00", title: "The Codebase" },
					},
					{
						id: "wiki",
						title: "Documentation Anybody Can Read",
						blurb:
							"How the model works, what the policies say, what the standards are, and why each was chosen.",
						bucket: "active",
						note: "Written and thorough, and not yet served from this site.",
					},
					{
						id: "public-planning",
						title: "Planning in the Open",
						blurb:
							"The roadmap and the task board published from the same place they are written, rather than summarized by hand.",
						bucket: "active",
						note: "Decided and not built. This page is hand-written today.",
					},
					{
						id: "changelog",
						title: "A Changelog",
						blurb:
							"What actually shipped, and when, so progress is checkable rather than asserted.",
						bucket: "planned",
						note: "Does not exist.",
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
							"Sign in, sign up, or link an identity you have. Anthers still verifies every signup with its own emailed code.",
						bucket: "launched",
						quarter: SHIPPED_SO_FAR,
						doc: { id: "70.06", title: "Signing In from Somewhere Else" },
					},
					{
						id: "network-catalog",
						title: "Your Catalog as Records You Own",
						blurb:
							"A listing of your work in a repository you control, so it outlives any one host. The listing only, never the work.",
						bucket: "planned",
						note: "Blocked: the protocol offers no permission at the right grain.",
						doc: { id: "70.07", title: "What Anthers Would Put on the Network" },
					},
					{
						id: "identity-hosting",
						title: "Hosting Identities Here",
						blurb: "Anthers running the identity server, which unblocks the above in one step.",
						bucket: "planned",
						doc: { id: "70.01", title: "Federation and Creator Nodes" },
					},
					{
						id: "creator-hosted",
						title: "Creators Serving Their Own Files",
						blurb:
							"Delivering your work from your own machine. Pay depends on whether you gated it, never on who served the bytes.",
						bucket: "planned",
						note: "Signposted rather than scheduled.",
						doc: { id: "70.01", title: "Federation and Creator Nodes" },
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

/** How many goals sit in `bucket`, across every group. */
export function countIn(bucket: Bucket): number {
	return allItems().filter((i) => i.bucket === bucket).length;
}
