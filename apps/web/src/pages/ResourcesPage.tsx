// SPDX-License-Identifier: Apache-2.0
//
// The Resources marketing page — the Meadow-styled hub for everything that shows
// our work, organized by audience rather than by format (the revamp's ruling): one
// section apiece for the two people the money questions belong to — For Users, For
// Creators — one for the organization's own money (Inside Anthers), and the
// comparisons, which both audiences read, in a strip of their own. Each of the three
// categories opens with its flagship resource.
//
// ⚠️ **A resource builds against the shared model, or it does not exist.** The
// three /demo-* pages were deleted on 2026-08-30 because each modeled the
// economics in its own hardcoded numbers, so each could go wrong on its own while
// every generated figure on the site stayed right. The same rule took down the
// revenue drawing on 2026-10-15 from the other side: its figures were generated,
// but they were the financial plan's *projections*, and projections this early and
// this in flux make a public page muddier rather than more transparent.
//
// 🚨 **Nothing unbuilt is described in the present tense here.** The creator
// category's flagship — one financials calculator joining the explanation to the
// numbers — is its own build (the board task "Build the creator financials
// calculator, absorbing the monetization and storage pages"), so this page stages
// the two incumbent calculators it will absorb until it lands, and says nothing on
// the public page about the one that is coming.
//
// The page is wrapped in the shared <MeadowDecor> (pollen + woven side vines) at
// the route level, so this file styles content only.

import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Card, Eyebrow, H2, Lede, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link } from "@anthers/web-shared/router";
import {
	ArrowRightIcon,
	BanknotesIcon,
	CircleStackIcon,
	NewspaperIcon,
	PuzzlePieceIcon,
	ScaleIcon,
} from "@heroicons/react/24/outline";

const serif = { fontFamily: FONTS.fraunces };

interface ResourceCard {
	to: string;
	title: string;
	blurb: string;
	/** The card's *subject*, never its audience — the section heading carries that. */
	tag: string;
	icon: typeof CircleStackIcon;
}

/** The user category's flagship: the reader's own spending, compared, which the
 * wiki's *What It Costs, Against What You Pay Now* links to from its page. */
const USER_FLAGSHIP: ResourceCard = {
	to: "/resources/media-month",
	title: "Your Media Month",
	blurb:
		"The spend calculator: build your month out of what you already pay — subscriptions, purchases, pledges — and see what each line pays out today (with the gaps standing where nothing is published) against the same money on Anthers, computed exactly.",
	tag: "Money",
	icon: BanknotesIcon,
};

/**
 * Head-to-heads. The two /compare/* pages previously surfaced only in the footer,
 * even though the pay comparison — the same genre — was already on this page.
 */
const COMPARISONS: ResourceCard[] = [
	{
		to: "/resources/pay-comparison",
		title: "How Our Pay Compares",
		blurb:
			"What reaches you on Anthers versus YouTube, Spotify, Steam, Bandcamp, Patreon, and Substack — our current math, head to head.",
		tag: "Economics",
		icon: ScaleIcon,
	},
	{
		to: "/compare/itch-io",
		title: "Anthers vs itch.io",
		blurb:
			"Where we're carrying itch.io's creator-first mission forward, and where we've chosen to do it differently.",
		tag: "Games",
		icon: PuzzlePieceIcon,
	},
	{
		to: "/compare/ghost",
		title: "Anthers vs Ghost",
		blurb:
			"Two platforms, two philosophies — focused independent publishing, versus a home for work across every medium.",
		tag: "Publishing",
		icon: NewspaperIcon,
	},
];

/** The two creator calculators, staged as this category's cards until their flagship —
 * one financials calculator absorbing both — replaces them (see the file header). */
const CREATOR_RESOURCES: ResourceCard[] = [
	{
		to: "/resources/creator-monetization",
		title: "Creator Monetization Calculator",
		blurb:
			"How time with a creator becomes revenue under the Time Pool + support model — from one user up to a creator's monthly earnings.",
		tag: "Economics",
		icon: BanknotesIcon,
	},
	{
		to: "/resources/video-storage",
		title: "Video Storage Calculator",
		blurb:
			"What it costs to store a source video plus its full AV1 transcode ladder, per source-hour and across a whole library.",
		tag: "Infrastructure",
		icon: CircleStackIcon,
	},
];

/** The Anthers category's flagship: the mechanism, drawn — the one page whose
 * subject is the organization's own money, no projections. */
const ANOTHERS_FLAGSHIP: ResourceCard = {
	to: "/resources/how-money-moves",
	title: "How the Money Moves",
	blurb:
		"The whole flow, drawn to the percentage: what a monthly subscription to Anthers splits into, what a subscription to a creator and a purchase pass through with, and what funds the charitable programs. Right now, with no projections — hold it to the arithmetic.",
	tag: "Money",
	icon: BanknotesIcon,
};

export default function ResourcesPage() {
	return (
		<div>
			{/* Hero */}
			<header className="bg-base-200/70">
				<div className="mx-auto max-w-5xl px-6 pt-24 pb-16 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-5 h-11 w-11 text-primary/60" />
						<p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
							Resources
						</p>
						<h1
							style={serif}
							className="text-balance text-4xl font-light leading-tight sm:text-5xl"
						>
							Check our math
						</h1>
					</Reveal>
					<Reveal delay={150}>
						<Lede>
							Everything behind Anthers, in the open — what your money does as a user and as a
							creator, and where the organization's own share of it goes. No login, no sign-up: run
							the numbers yourself, and hold us to them.
						</Lede>
					</Reveal>
				</div>
			</header>

			{/* For Users — the reader's own money, flagship first. */}
			<Section>
				<Reveal>
					<Eyebrow>For Users</Eyebrow>
					<H2>Follow your own money</H2>
					<Lede>
						What you already pay for the work you watch, hear, read and play — laid out line by
						line, against what the same money would do on Anthers.
					</Lede>
				</Reveal>
				<FlagshipCard r={USER_FLAGSHIP} />
			</Section>

			{/* For Creators — the numbers to run before bringing work here. The two
			    incumbent calculators stage this category until their flagship absorbs them. */}
			<Section tint>
				<Reveal>
					<Eyebrow>For Creators</Eyebrow>
					<H2>What working here pays</H2>
					<Lede>
						How an audience's support and purchases become money that reaches you, and what storing
						your catalog costs. Run the numbers against your own situation.
					</Lede>
				</Reveal>
				<ResourceGrid cards={CREATOR_RESOURCES} />
			</Section>

			{/* Inside Anthers — the mechanism, drawn; the organization's own money. */}
			<Section>
				<Reveal>
					<Eyebrow>Inside Anthers</Eyebrow>
					<H2>The mechanism, drawn</H2>
					<Lede>
						How money actually moves on Anthers today — where a subscription goes, what a purchase
						passes through with, and what funds the programs — every figure generated from the same
						math the checkout runs.
					</Lede>
				</Reveal>
				<FlagshipCard r={ANOTHERS_FLAGSHIP} />
			</Section>

			{/* Comparisons — both audiences read these, so they keep a strip of their own. */}
			<Section tint>
				<Reveal>
					<Eyebrow>Comparisons</Eyebrow>
					<H2>How we stack up</H2>
					<Lede>
						Head-to-head with the platforms you're likely using already — what reaches you, what it
						costs, and where the models genuinely differ.
					</Lede>
				</Reveal>
				<ResourceGrid cards={COMPARISONS} />
			</Section>

			{/* The way onward when the tools above don't have the answer. */}
			<Section>
				<Reveal>
					<Eyebrow>Still looking?</Eyebrow>
					<H2>Not finding what you need?</H2>
					<Lede>
						The tools above cover the numbers. For everything else — how accounts work, what's
						shipping next, why we're built as a nonprofit — start with the FAQ.
					</Lede>
					<div className="mt-9 flex flex-wrap justify-center gap-3">
						<Link to="/faq" className="btn btn-primary rounded-lg px-7">
							Read the FAQ
						</Link>
						<Link to="/about" className="btn btn-ghost rounded-lg px-7">
							About Anthers
						</Link>
						<Link to="/roadmap" className="btn btn-ghost rounded-lg px-7">
							Roadmap
						</Link>
					</div>
				</Reveal>
			</Section>
		</div>
	);
}

/** The card grid shared by the multi-card sections — staggered reveal, equal-height tiles. */
function ResourceGrid({ cards }: { cards: ResourceCard[] }) {
	return (
		<div className="mt-12 grid grid-cols-1 gap-6 text-left sm:grid-cols-2 lg:grid-cols-3">
			{cards.map((r, i) => (
				<Reveal key={r.to} delay={i * 100} className="h-full">
					<ResourceTile r={r} />
				</Reveal>
			))}
		</div>
	);
}

/** A resource card in a grid — a clickable Meadow rounded card. */
function ResourceTile({ r }: { r: ResourceCard }) {
	const Icon = r.icon;
	return (
		<Link to={r.to} className="group block h-full">
			<Card className="h-full transition-colors hover:border-primary/40">
				<div className="flex items-start justify-between gap-3">
					<span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
						<Icon className="h-5 w-5" />
					</span>
					<span className="rounded-full bg-base-200 px-3 py-1 text-xs font-medium text-base-content/55">
						{r.tag}
					</span>
				</div>
				<h3
					style={serif}
					className="mt-4 text-lg font-medium transition-colors group-hover:text-primary"
				>
					{r.title}
				</h3>
				<p className="mt-1 text-sm leading-relaxed text-base-content/65">{r.blurb}</p>
				<span className="mt-3 inline-flex items-center gap-1 text-sm text-primary opacity-0 transition-opacity group-hover:opacity-100">
					Open <ArrowRightIcon className="h-4 w-4" />
				</span>
			</Card>
		</Link>
	);
}

/** The full-width, primary-accented card a category opens with — the section's
 * flagship resource, carrying its blurb at a larger size than a grid tile. */
function FlagshipCard({ r }: { r: ResourceCard }) {
	const Icon = r.icon;
	return (
		<Reveal>
			<Link to={r.to} className="group mx-auto mt-12 block max-w-4xl text-left">
				<Card className="border-primary/30 bg-primary/[0.04] transition-colors hover:border-primary/50">
					<div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-7">
						<span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
							<Icon className="h-6 w-6" />
						</span>
						<div className="flex-1">
							<div className="flex flex-wrap items-center gap-3">
								<h3
									style={serif}
									className="text-xl font-medium transition-colors group-hover:text-primary sm:text-2xl"
								>
									{r.title}
								</h3>
								<span className="rounded-full bg-base-200 px-3 py-1 text-xs font-medium text-base-content/55">
									{r.tag}
								</span>
							</div>
							<p className="mt-2 text-sm leading-relaxed text-base-content/65">{r.blurb}</p>
						</div>
						<span className="hidden items-center gap-1 text-sm font-medium text-primary sm:inline-flex">
							Open <ArrowRightIcon className="h-4 w-4" />
						</span>
					</div>
				</Card>
			</Link>
		</Reveal>
	);
}
