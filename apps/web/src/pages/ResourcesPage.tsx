// SPDX-License-Identifier: AGPL-3.0-or-later

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

function Card({ r }: { r: ResourceCard }) {
	const Icon = r.icon;
	return (
		<Link
			to={r.to}
			className="group card bg-base-100 border border-base-300 hover:border-primary/50 transition-colors"
		>
			<div className="card-body p-5">
				<div className="flex items-start justify-between gap-3">
					<span className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10 text-primary">
						<Icon className="w-5 h-5" />
					</span>
					<span className="badge badge-sm badge-ghost">{r.tag}</span>
				</div>
				<h3 className="mt-3 text-lg font-semibold group-hover:text-primary transition-colors">
					{r.title}
				</h3>
				<p className="text-sm text-base-content/60 leading-relaxed">{r.blurb}</p>
				<span className="mt-1 inline-flex items-center gap-1 text-sm text-primary opacity-0 group-hover:opacity-100 transition-opacity">
					Open <ArrowRightIcon className="w-4 h-4" />
				</span>
			</div>
		</Link>
	);
}

export default function ResourcesPage() {
	return (
		<div className="max-w-6xl mx-auto px-4 pb-16">
			<section className="pt-12 pb-8 text-center">
				<p className="text-sm font-medium text-primary mb-2 tracking-wide uppercase">Resources</p>
				<h1 className="text-4xl font-bold tracking-tight mb-3">Tools & calculators</h1>
				<p className="text-base-content/60 max-w-2xl mx-auto leading-relaxed">
					Open, no-login planning tools that model the real numbers behind Anthers — infrastructure
					costs at cost, and how watch-time converts to creator revenue. Everything's transparent by
					design; poke at the assumptions yourself.
				</p>
			</section>

			<h2 className="text-sm font-semibold text-base-content/50 uppercase tracking-wider mb-3">
				Calculators
			</h2>
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
				{CALCULATORS.map((r) => (
					<Card key={r.to} r={r} />
				))}
			</div>

			<h2 className="text-sm font-semibold text-base-content/50 uppercase tracking-wider mt-10 mb-3">
				More to explore
			</h2>
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
				{RELATED.map((r) => (
					<Card key={r.to} r={r} />
				))}
			</div>
		</div>
	);
}
