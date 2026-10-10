// SPDX-License-Identifier: Apache-2.0
//
// The Resources marketing page — the Meadow-styled hub for everything that shows
// our work: explainers (the platform, drawn), calculators (run it yourself) and
// comparisons (how we stack up). The page is wrapped in the shared <MeadowDecor>
// (pollen + woven side vines) at the route level, so this file styles content only.
//
// Two axes, kept deliberately separate — the section says what *format* a resource
// is, the card's tag says what *subject* it covers. Don't tag a card with its own
// section name; that collapses the axes and is what made this page read as a pile
// of posts.
//
// ⚠️ **The demos' replacement is now fully in place.** An Explainers section stood
// first until 2026-08-30, holding three /demo-* pages; all four demos were deleted
// rather than rebuilt, because each modeled the economics in its own hardcoded
// numbers, so each could go wrong on its own while every generated figure on the
// site stayed right. The rule out of that deletion: a resource builds against the
// shared model, or it does not exist. Creator financials became the monetization
// calculator; the revenue resource is the drawing of where Anthers' own money
// goes. The Explainers section below is back with one card in it, which is more
// honest than a section holding demos that could lie.

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

/** The drawn resources: they explain rather than compute, and they draw from the
 * shared model — the rule out of the demos' deletion (see the file's header). */
const EXPLAINERS: ResourceCard[] = [
	{
		to: "/resources/revenue",
		title: "Where the money goes",
		blurb:
			"The whole pool, drawn: what comes in by Badge rung, what leaves at cost, and what funds free access, free storage and the other charitable programs, at each scale of the plan. Targets and estimates, not actuals.",
		tag: "Money",
		icon: BanknotesIcon,
	},
];

interface ResourceCard {
	to: string;
	title: string;
	blurb: string;
	/** The card's *subject*, never its format — the section heading carries that. */
	tag: string;
	icon: typeof CircleStackIcon;
}

/** The interactive tools — put numbers in, get numbers out. */
const CALCULATORS: ResourceCard[] = [
	{
		to: "/resources/video-storage",
		title: "Video Storage Calculator",
		blurb:
			"What it costs to store a source video plus its full AV1 transcode ladder, per source-hour and across a whole library.",
		tag: "Infrastructure",
		icon: CircleStackIcon,
	},
	{
		to: "/resources/creator-monetization",
		title: "Creator Monetization Calculator",
		blurb:
			"How time with a creator becomes revenue under the Time Pool + support model — from one user up to a creator's monthly earnings.",
		tag: "Economics",
		icon: BanknotesIcon,
	},
];

/**
 * Head-to-heads. The two /compare/* pages previously surfaced only in the footer,
 * even though the pay comparison — the same genre — was already on this page.
 */
const COMPARISONS: ResourceCard[] = [
	{
		to: "/resources/pay-comparison",
		title: "How our pay compares",
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
							Everything behind Anthers, in the open — what it costs to host the work, how time with
							a creator turns into money that reaches them, and how that compares to the platforms
							you are already using. No login, no sign-up: run the numbers yourself, and hold us to
							them.
						</Lede>
					</Reveal>
				</div>
			</header>

			{/* Explainers — the drawing of the platform itself; formerly the demos' home,
			restored with the revenue resource (the demos' rule: build on the shared model,
			or don't exist). Plain: it sits between the tinted hero and the calculators. */}
			<Section>
				<Reveal>
					<Eyebrow>Explainers</Eyebrow>
					<H2>The platform, drawn</H2>
					<Lede>
						Where the money goes, one pool at a time: what supporters bring in, what leaves at cost
						first, and what the charitable programs receive from everything that remains.
					</Lede>
				</Reveal>
				<ResourceGrid cards={EXPLAINERS} />
			</Section>

			{/* Calculators */}
			<Section tint>
				<Reveal>
					<Eyebrow>Calculators</Eyebrow>
					<H2>Run the numbers yourself</H2>
					<Lede>
						Open planning tools with our real rates wired in. Change the assumptions and watch the
						totals move — every figure on this site comes out of the same math.
					</Lede>
				</Reveal>
				<ResourceGrid cards={CALCULATORS} />
			</Section>

			{/* Comparisons */}
			<Section>
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
			<Section tint>
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

/** The card grid shared by every section — staggered reveal, equal-height tiles. */
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

/** A single resource card — a clickable Meadow rounded card. */
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
