// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Resources marketing page — the Meadow-styled hub for everything that shows
// our work: calculators (run it yourself) and comparisons (how we stack up). The
// page is wrapped in the shared <MeadowDecor> (pollen + woven side vines) at the
// route level, so this file styles content only.
//
// Two axes, kept deliberately separate — the section says what *format* a resource
// is, the card's tag says what *subject* it covers. Don't tag a card with its own
// section name; that collapses the axes and is what made this page read as a pile
// of posts. A Documentation section lands here once the wiki has content behind it
// (/wiki is currently a shell — no /api/wiki route, no markdown), which is why the
// closing band points at the FAQ instead.
//
// ⚠️ **An Explainers section stood first here until 2026-08-30**, holding the three
// `/demo-*` pages. All four demos were deleted rather than rebuilt: each modeled the
// economics in its own hardcoded numbers, so each could go wrong on its own while
// every generated figure on the site stayed right. Two resources replace them —
// creator financials, and where Anthers' own revenue goes — and both are built
// against the shared model rather than typed. Until they land this page is honestly
// two sections rather than three, which is better than a section advertising pages
// that do not exist. The section is missing, not empty: an empty one would read as
// a rendering bug.

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
			"How time with a creator becomes revenue under the Time Pool + support model — from one viewer up to a creator's monthly earnings.",
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

			{/* Calculators */}
			<Section>
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
						shipping next, why we're built as a non-profit — start with the FAQ.
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
