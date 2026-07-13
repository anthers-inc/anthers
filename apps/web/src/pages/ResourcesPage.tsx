// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Resources marketing page — restyled into the Meadow design. Airy editorial
// forest-green, Fraunces display serif over Nunito Sans, alternating tinted
// section bands, rounded cards, and a botanical Sprig. The page is wrapped in the
// shared <MeadowDecor> (pollen + woven side vines) at the route level, so this
// file styles content only. Tool/explainer data and links are unchanged.

import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Card, Eyebrow, Lede, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import {
	ArrowRightIcon,
	BanknotesIcon,
	ChartBarIcon,
	CircleStackIcon,
	SignalIcon,
	UserGroupIcon,
	WalletIcon,
} from "@heroicons/react/24/outline";
import { Link } from "react-router-dom";

const serif = { fontFamily: FONTS.fraunces };

interface ResourceCard {
	to: string;
	title: string;
	blurb: string;
	tag: string;
	icon: typeof CircleStackIcon;
}

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
		to: "/resources/video-bandwidth",
		title: "Video Bandwidth Calculator",
		blurb:
			"How much watch time a bandwidth allowance buys at each delivery tier and codec — the egress side of hosting video.",
		tag: "Infrastructure",
		icon: SignalIcon,
	},
	{
		to: "/resources/creator-monetization",
		title: "Creator Monetization Calculator",
		blurb:
			"How watch-time becomes revenue under the V3 Time Pool + Boost model — from one viewer up to a creator's monthly earnings.",
		tag: "Economics",
		icon: BanknotesIcon,
	},
];

const RELATED: ResourceCard[] = [
	{
		to: "/demo-infrastructure",
		title: "Infrastructure economics",
		blurb:
			"What it actually costs to host content across video, audio, text, and games — at cost, zero markup.",
		tag: "Explainer",
		icon: ChartBarIcon,
	},
	{
		to: "/demo-creator-breakdown",
		title: "Creator economics breakdown",
		blurb:
			"Real creators mapped onto the Anthers model — where every dollar of a subscriber's spend lands.",
		tag: "Explainer",
		icon: UserGroupIcon,
	},
	{
		to: "/demo-user",
		title: "See where your money goes",
		blurb: "A viewer's-eye view of Usage, Boost, the Time Pool, and the zero-cut split.",
		tag: "Explainer",
		icon: WalletIcon,
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
							Tools &amp; calculators
						</h1>
					</Reveal>
					<Reveal delay={150}>
						<Lede>
							Open, no-login planning tools that model the real numbers behind Anthers —
							infrastructure costs at cost, and how watch-time converts to creator revenue.
							Everything's transparent by design; poke at the assumptions yourself.
						</Lede>
					</Reveal>
				</div>
			</header>

			{/* Calculators */}
			<Section>
				<Reveal>
					<Eyebrow>Calculators</Eyebrow>
				</Reveal>
				<div className="mt-10 grid grid-cols-1 gap-6 text-left sm:grid-cols-2 lg:grid-cols-3">
					{CALCULATORS.map((r, i) => (
						<Reveal key={r.to} delay={i * 100} className="h-full">
							<ResourceTile r={r} />
						</Reveal>
					))}
				</div>
			</Section>

			{/* More to explore */}
			<Section tint>
				<Reveal>
					<Eyebrow>More to explore</Eyebrow>
				</Reveal>
				<div className="mt-10 grid grid-cols-1 gap-6 text-left sm:grid-cols-2 lg:grid-cols-3">
					{RELATED.map((r, i) => (
						<Reveal key={r.to} delay={i * 100} className="h-full">
							<ResourceTile r={r} />
						</Reveal>
					))}
				</div>
			</Section>
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
