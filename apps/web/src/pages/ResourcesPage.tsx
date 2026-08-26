// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Resources marketing page — the Meadow-styled hub for everything that shows
// our work: explainers (how the model works), calculators (run it yourself), and
// comparisons (how we stack up). The page is wrapped in the shared <MeadowDecor>
// (pollen + woven side vines) at the route level, so this file styles content only.
//
// Two axes, kept deliberately separate — the section says what *format* a resource
// is, the card's tag says what *subject* it covers. Don't tag a card with its own
// section name; that collapses the axes and is what made this page read as a pile
// of posts. A Documentation section lands here once the wiki has content behind it
// (/wiki is currently a shell — no /api/wiki route, no markdown), which is why the
// closing band points at the FAQ instead.

import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Card, Eyebrow, H2, Lede, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link } from "@anthers/web-shared/router";
import {
	ArrowRightIcon,
	BanknotesIcon,
	ChartBarIcon,
	CircleStackIcon,
	NewspaperIcon,
	PuzzlePieceIcon,
	ScaleIcon,
	UserGroupIcon,
	WalletIcon,
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

/** Guided walkthroughs of the model — the orientation layer, so they lead. */
const EXPLAINERS: ResourceCard[] = [
	{
		to: "/demo-user",
		title: "See where your money goes",
		blurb:
			"A viewer's-eye view of monthly support — to Anthers and to creators — the Time Pool, and where every dollar goes.",
		tag: "Users",
		icon: WalletIcon,
	},
	{
		to: "/demo-creator-breakdown",
		title: "Creator economics breakdown",
		blurb:
			"Composite creator profiles mapped onto the Anthers model — where every dollar of a subscriber's spend lands.",
		tag: "Creators",
		icon: UserGroupIcon,
	},
	{
		to: "/demo-infrastructure",
		title: "Infrastructure economics",
		blurb:
			"What it actually costs to host content across video, audio, text, and games — at cost, zero markup.",
		tag: "Infrastructure",
		icon: ChartBarIcon,
	},
];

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
							Everything behind Anthers, in the open — how the model works, what the infrastructure
							really costs, and how time with a creator turns into revenue. No login, no sign-up:
							run the numbers yourself, and hold us to them.
						</Lede>
					</Reveal>
				</div>
			</header>

			{/* Explainers — start here if you're new to how any of this fits together */}
			<Section>
				<Reveal>
					<Eyebrow>Explainers</Eyebrow>
					<H2>How the model works</H2>
					<Lede>
						Guided walkthroughs of the Anthers model — where a subscriber's dollar lands, what a
						creator actually earns, and what it costs to host the work.
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

/** A single tool/explainer card — a clickable Meadow rounded card. */
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
