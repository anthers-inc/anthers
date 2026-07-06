// SPDX-License-Identifier: AGPL-3.0-or-later
import { FOUNDATION_FEE_PERCENTAGE } from "@anthers/shared/constants";
import { useAuth } from "@anthers/web-shared/auth";
import {
	AdjustmentsHorizontalIcon,
	ArrowDownTrayIcon,
	BanknotesIcon,
	BoltIcon,
	ChartBarIcon,
	CheckCircleIcon,
	ClockIcon,
	CurrencyDollarIcon,
	EyeSlashIcon,
	GlobeAltIcon,
	HeartIcon,
	LockOpenIcon,
	MusicalNoteIcon,
	ShieldCheckIcon,
	SignalIcon,
	Squares2X2Icon,
	UserGroupIcon,
} from "@heroicons/react/24/outline";
import { useState } from "react";
import { Link } from "react-router-dom";

export default function ForUsersPage() {
	const { isAuthenticated } = useAuth();

	return (
		<div>
			{/* ───────────── Hero ───────────── */}
			<section className="hero min-h-[60vh]">
				<div className="hero-content text-center py-20">
					<div className="max-w-3xl">
						<p className="text-sm font-medium text-secondary mb-3 tracking-wide uppercase">
							For Users
						</p>
						<h1 className="text-5xl font-bold tracking-tight">
							Know exactly where your money goes
						</h1>
						<p className="py-6 text-xl text-base-content/70 leading-relaxed max-w-2xl mx-auto">
							Anthers is funded by you, not advertisers—so it's built to work for you. You pay
							creators directly, pay only for what you actually use, and own the relationships you
							build. No ads, no algorithms, no hidden cut. Here's how it works.
						</p>
						<div className="flex gap-4 justify-center flex-wrap">
							<Link to="/discover" className="btn btn-secondary btn-lg">
								Start Exploring
							</Link>
							{!isAuthenticated && (
								<Link to="/signup" className="btn btn-outline btn-lg">
									Create Free Account
								</Link>
							)}
						</div>
						<p className="mt-6 text-sm text-base-content/40">
							No account needed to browse, download free content, or play web games.
						</p>
					</div>
				</div>
			</section>

			{/* ───────────── How it's different (frame) ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">What makes Anthers different</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Most platforms make their money from ads and take a large cut of what you pay. Anthers
						is funded directly by the people who use it—which changes everything about how it works.
					</p>

					<div className="grid grid-cols-1 md:grid-cols-3 gap-10">
						<Pillar
							icon={<CurrencyDollarIcon className="w-7 h-7 text-success" />}
							tone="bg-success/15"
							title="Your money reaches creators"
							description="92% of every subscription and 100% of every direct purchase goes to creators. Fees are shown as itemized line items—never a silent percentage skimmed off the top."
						/>
						<Pillar
							icon={<SignalIcon className="w-7 h-7 text-secondary" />}
							tone="bg-secondary/15"
							title="You pay for what you use"
							description="No ads paying for infrastructure by harvesting your attention. Delivery costs are small, transparent, and—uniquely—something you can actually see and control."
						/>
						<Pillar
							icon={<GlobeAltIcon className="w-7 h-7 text-primary" />}
							tone="bg-primary/15"
							title="You own your relationships"
							description="Your identity, follows, and library live on an open network (the one behind Bluesky). You follow creators, not mediums—and you can leave anytime with your data intact."
						/>
					</div>
				</div>
			</section>

			{/* ───────────── Direct purchases ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">
						Buy directly—the price is what the creator gets
					</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Games, albums, and one-time content can be bought outright. The creator's listed price
						is exactly what they receive; real costs are added on top and itemized, so you see every
						penny before you pay—and you can lower them by paying from your bank.
					</p>

					<PurchaseCalculator />

					<div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-12">
						<IconFeature
							icon={<CheckCircleIcon className="w-5 h-5 text-success" />}
							title="100% of the price reaches the creator"
						>
							On other platforms, 10–30% of what you pay disappears into the platform's pocket.
							Here, the creator's listed price is exactly what they take home.
						</IconFeature>
						<IconFeature
							icon={<ShieldCheckIcon className="w-5 h-5 text-primary" />}
							title="Every fee is named and explained"
						>
							No surprise charges, no vague "service fee." You always know what each line is for
							before you confirm the purchase.
						</IconFeature>
						<IconFeature
							icon={<HeartIcon className="w-5 h-5 text-error" />}
							title="An 8% Foundation Fee, not a platform tax"
						>
							The same 8% that funds the Anthers Foundation on subscriptions—supporting charitable
							programs and keeping the platform running, instead of enriching shareholders.
						</IconFeature>
					</div>

					{/* Pricing models */}
					<div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12">
						<PricingCard
							title="Free"
							badge="badge-success"
							description="Lots of content is genuinely free—no account, no login wall, no 'subscribe to download' trick. If a creator made it free, you get it free."
						/>
						<PricingCard
							title="Pay What You Want"
							badge="badge-warning"
							description="Some creators let you choose the price. Give what you can—even $1 helps—or pay nothing if that's what works right now."
						/>
						<PricingCard
							title="Fixed Price"
							badge="badge-neutral"
							description="The price you see is the price the creator set—and receives. Your purchase directly funds the person who made it."
						/>
					</div>
				</div>
			</section>

			{/* ───────────── Subscriptions: the pool ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">
						One subscription, split transparently
					</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Instead of a separate pledge to every creator, you fund Anthers at whatever level you
						choose—starting at $3/month, adjustable a dollar at a time. That single subscription is
						split the same way at every amount: 8% funds the Foundation, and 92% flows to creators
						through two pools.
					</p>

					{/* Breakdown visual */}
					<div className="max-w-3xl mx-auto card bg-base-100 shadow-sm mb-12">
						<div className="card-body">
							<div className="flex items-baseline justify-between mb-1">
								<h3 className="font-bold text-lg">Where a $7 Sprout subscription goes</h3>
								<span className="text-sm text-base-content/50">per month</span>
							</div>
							<div className="flex flex-col gap-3 text-sm mt-2">
								<SplitRow
									label="Anthers Foundation Fee (8%)"
									amount="$0.56"
									barClass="bg-base-300"
									widthClass="w-[8%]"
								/>
								<SplitRow
									label="Time Pool — auto, by time spent"
									amount="$2.44"
									barClass="bg-secondary"
									widthClass="w-[35%]"
								/>
								<SplitRow
									label="Boost Pool — you direct it (or leave on auto)"
									amount="$4.00"
									barClass="bg-primary"
									widthClass="w-[57%]"
								/>
							</div>
							<div className="divider my-2" />
							<div className="flex justify-between text-sm font-semibold">
								<span>To creators (92%)</span>
								<span className="text-success">$6.44</span>
							</div>
							<p className="text-xs text-base-content/40 mt-2">
								Delivery is billed separately, on top—see below. The creator share is never reduced
								by infrastructure costs.
							</p>
						</div>
					</div>

					{/* Two pools */}
					<div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
						<ConceptCard
							icon={<ClockIcon className="w-6 h-6 text-secondary" />}
							tone="bg-secondary/15"
							eyebrow="Automatic"
							title="The Time Pool"
							description="Distributed automatically based on the time you spend—and a minute is a minute. Watching a video, reading an essay, listening to an album, and playing a game all count exactly the same. Every creator you spend time with gets funded, with no effort from you."
						/>
						<ConceptCard
							icon={<BoltIcon className="w-6 h-6 text-primary" />}
							tone="bg-primary/15"
							eyebrow="Your call"
							title="The Boost Pool"
							description="Point your support wherever you want, in $1 steps—or leave it on auto and it mirrors your time. Boost is how you champion the creators who matter most to you, and it's what unlocks their premium content. Anything you don't allocate flows back into the Time Pool, so nothing is wasted."
						/>
					</div>

					{/* Tier table */}
					<div className="overflow-x-auto mt-14">
						<table className="table table-sm max-w-3xl mx-auto">
							<thead>
								<tr>
									<th>Tier</th>
									<th className="text-right">Starts at</th>
									<th className="text-right">Foundation (8%)</th>
									<th className="text-right">Time Pool</th>
									<th className="text-right">Boost Pool</th>
									<th className="text-right">Watch time</th>
								</tr>
							</thead>
							<tbody>
								<TierRow tier="Free" price="$0" foundation="—" time="—" boost="—" cap="10 hrs/mo" />
								<TierRow
									tier="Root"
									price="$3/mo"
									foundation="$0.24"
									time="$0.76"
									boost="$2.00"
									cap="25 hrs/mo"
								/>
								<TierRow
									tier="Sprout"
									price="$7/mo"
									foundation="$0.56"
									time="$2.44"
									boost="$4.00"
									cap="Unlimited"
								/>
								<TierRow
									tier="Petal"
									price="$15/mo"
									foundation="$1.20"
									time="$5.80"
									boost="$8.00"
									cap="Unlimited"
								/>
								<TierRow
									tier="Bloom"
									price="$30/mo"
									foundation="$2.40"
									time="$12.60"
									boost="$15.00"
									cap="Unlimited"
								/>
							</tbody>
						</table>
					</div>
					<p className="text-center text-xs text-base-content/40 mt-4 max-w-2xl mx-auto">
						Tiers are just named starting points on a continuous scale—you can fund at any dollar
						amount, and the 8% / 92% split holds at every level. Both pools grow as you fund more.
						Subscriptions coming soon.
					</p>
				</div>
			</section>

			{/* ───────────── Gates ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">Two clear ways to unlock more</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Some creators put premium content behind a gate. There are exactly two kinds—one based
						on your support for that specific creator, the other on your overall support for the
						platform—and you always know what unlocks what.
					</p>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
						{/* Boost gates */}
						<div className="card bg-base-200">
							<div className="card-body">
								<div className="flex items-center gap-3 mb-1">
									<div className="w-11 h-11 rounded-full bg-primary/15 flex items-center justify-center">
										<BoltIcon className="w-6 h-6 text-primary" />
									</div>
									<div>
										<p className="text-xs uppercase tracking-wide text-primary/80 font-medium">
											Based on your support for one creator
										</p>
										<h3 className="font-bold text-lg">Boost Gates</h3>
									</div>
								</div>
								<p className="text-sm text-base-content/60 mb-4">
									Direct more of your boost to a creator to unlock their tiers. Creators set the
									thresholds in $1 steps and name the tiers themselves—and unlocking a higher tier
									includes everything below it.
								</p>
								<div className="flex flex-col gap-1.5 text-sm">
									<GateThreshold amount="$1" name="Follow+" perk="Chat access, community polls" />
									<GateThreshold
										amount="$1.50"
										name="Insider"
										perk="Early access, community posts"
									/>
									<GateThreshold
										amount="$3"
										name="Supporter"
										perk="Behind-the-scenes, extended cuts"
									/>
									<GateThreshold amount="$5" name="Champion" perk="Monthly Q&A, name in credits" />
								</div>
							</div>
						</div>

						{/* Tier gates */}
						<div className="card bg-base-200">
							<div className="card-body">
								<div className="flex items-center gap-3 mb-1">
									<div className="w-11 h-11 rounded-full bg-secondary/15 flex items-center justify-center">
										<Squares2X2Icon className="w-6 h-6 text-secondary" />
									</div>
									<div>
										<p className="text-xs uppercase tracking-wide text-secondary/80 font-medium">
											Based on your total support across the platform
										</p>
										<h3 className="font-bold text-lg">Anthers Tier Gates</h3>
									</div>
								</div>
								<p className="text-sm text-base-content/60 mb-4">
									Clear a funding threshold and unlock that tier's content across <em>every</em>{" "}
									creator—even ones you don't boost. Upgrading to reach one creator lifts your
									support for all of them, so advocacy becomes a rising tide.
								</p>
								<div className="flex flex-col gap-1.5 text-sm">
									<GateThreshold
										amount="$3+"
										name="Root"
										perk="Root-level content, platform-wide"
									/>
									<GateThreshold
										amount="$7+"
										name="Sprout"
										perk="Sprout-level content, platform-wide"
									/>
									<GateThreshold
										amount="$15+"
										name="Petal"
										perk="Petal-level content, platform-wide"
									/>
									<GateThreshold
										amount="$30+"
										name="Bloom"
										perk="Bloom-level content, platform-wide"
									/>
								</div>
							</div>
						</div>
					</div>

					<p className="text-center text-sm text-base-content/50 mt-8 max-w-2xl mx-auto">
						Creators can combine both—for example,{" "}
						<span className="text-base-content/70">
							"Petal subscribers <em>or</em> anyone boosting $3+ to me"
						</span>
						—so there's usually more than one way in.
					</p>
				</div>
			</section>

			{/* ───────────── Delivery ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">
						Pay for the bandwidth you use—and control it
					</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Streaming and downloads cost bandwidth. Every other platform hides that cost inside ad
						revenue or a giant platform cut. Anthers shows it: a small delivery charge on top of
						your subscription, separate from the creator's share. Because it's visible, you get real
						tools to keep it low—something no ad-funded platform can offer.
					</p>

					<div className="max-w-3xl mx-auto mb-12 rounded-xl bg-base-100 p-6 text-center shadow-sm">
						<p className="text-base-content/70">
							<span className="font-bold text-success">
								Your first $1 of delivery each month is free
							</span>
							, covered by the Foundation—roughly 15 hours of HD video, or far more audio and
							reading. Go beyond that and you pay only for the bandwidth you actually used, at cost.
						</p>
					</div>

					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
						<ControlCard
							icon={<AdjustmentsHorizontalIcon className="w-6 h-6 text-secondary" />}
							title="Smart quality scaling"
							description="Video playing in a small window doesn't stream in 4K. Resolution matches the space it's shown in, so you don't pay for pixels you can't see."
						/>
						<ControlCard
							icon={<MusicalNoteIcon className="w-6 h-6 text-secondary" />}
							title="Audio-only mode"
							description="Listening to a video essay with the screen off? Drop to audio and cut bandwidth by 95%+—ideal for longform you don't need to watch."
						/>
						<ControlCard
							icon={<ArrowDownTrayIcon className="w-6 h-6 text-secondary" />}
							title="Download & cache"
							description="Rewatching a favorite doesn't cost delivery twice. Cached and downloaded replays are free—and the creator still gets credited for your time."
						/>
						<ControlCard
							icon={<ChartBarIcon className="w-6 h-6 text-secondary" />}
							title="Live usage dashboard"
							description="See your delivery cost as it happens, with a projection for the month. No surprises at billing time—ever."
						/>
					</div>

					<p className="text-center text-sm text-base-content/40 mt-10 max-w-2xl mx-auto">
						Creators cover their own storage costs; you cover delivery. Neither is ever skimmed from
						the other's share—the split simply reflects who causes which cost.
					</p>
				</div>
			</section>

			{/* ───────────── Identity & relationships ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">Your identity, your relationships</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Anthers is built on the AT Protocol—the open network behind Bluesky. Your account,
						follows, and library aren't locked inside one company's walls. They're yours.
					</p>

					<div className="grid grid-cols-1 md:grid-cols-3 gap-8">
						<Pillar
							icon={<UserGroupIcon className="w-7 h-7 text-info" />}
							tone="bg-info/15"
							title="Follow the creator, not the medium"
							description="One follow covers everything a creator makes—their game, its soundtrack, the devlog, the essay. You build a relationship with the person, and their whole body of work comes with it."
						/>
						<Pillar
							icon={<GlobeAltIcon className="w-7 h-7 text-info" />}
							tone="bg-info/15"
							title="Portable, no lock-in"
							description="Your account is a decentralized identifier (DID) you control. Sign in with your existing Bluesky identity or make a new one—and if you ever leave, your follows and data go with you."
						/>
						<Pillar
							icon={<EyeSlashIcon className="w-7 h-7 text-info" />}
							tone="bg-info/15"
							title="No surveillance"
							description="No tracking cookies, no ad targeting, no selling your history. There's no algorithm optimizing to keep you scrolling—because the platform answers to you, not advertisers."
						/>
					</div>
				</div>
			</section>

			{/* ───────────── CTA ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 text-center max-w-2xl">
					<h2 className="text-3xl font-bold mb-4">A platform that works for you</h2>
					<p className="text-base-content/60 mb-8 leading-relaxed">
						Support the creators you love, on terms you can see and trust. Browse the whole catalog
						free—no account required to start.
					</p>
					<div className="flex gap-4 justify-center flex-wrap">
						<Link to="/discover" className="btn btn-secondary btn-lg">
							Browse Projects
						</Link>
						{!isAuthenticated && (
							<Link to="/signup" className="btn btn-outline btn-lg">
								Create Free Account
							</Link>
						)}
					</div>
				</div>
			</section>
		</div>
	);
}

// ─── Sub-components ───

function Pillar({
	icon,
	tone,
	title,
	description,
}: {
	icon: React.ReactNode;
	tone: string;
	title: string;
	description: string;
}) {
	return (
		<div className="text-center">
			<div
				className={`w-14 h-14 rounded-full ${tone} flex items-center justify-center mx-auto mb-4`}
			>
				{icon}
			</div>
			<h3 className="font-bold text-lg mb-2">{title}</h3>
			<p className="text-sm text-base-content/60 leading-relaxed">{description}</p>
		</div>
	);
}

function IconFeature({
	icon,
	title,
	children,
}: {
	icon: React.ReactNode;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex gap-3">
			<div className="flex-shrink-0 mt-1">{icon}</div>
			<div>
				<h4 className="font-semibold text-sm">{title}</h4>
				<p className="text-sm text-base-content/60">{children}</p>
			</div>
		</div>
	);
}

function SplitRow({
	label,
	amount,
	barClass,
	widthClass,
}: {
	label: string;
	amount: string;
	barClass: string;
	widthClass: string;
}) {
	return (
		<div>
			<div className="flex justify-between mb-1">
				<span className="text-base-content/70">{label}</span>
				<span className="font-medium">{amount}</span>
			</div>
			<div className="h-2 w-full rounded-full bg-base-300/40">
				<div className={`h-2 rounded-full ${barClass} ${widthClass}`} />
			</div>
		</div>
	);
}

function ConceptCard({
	icon,
	tone,
	eyebrow,
	title,
	description,
}: {
	icon: React.ReactNode;
	tone: string;
	eyebrow: string;
	title: string;
	description: string;
}) {
	return (
		<div className="card bg-base-100 shadow-sm h-full">
			<div className="card-body">
				<div className="flex items-center gap-3 mb-1">
					<div className={`w-11 h-11 rounded-full ${tone} flex items-center justify-center`}>
						{icon}
					</div>
					<div>
						<p className="text-xs uppercase tracking-wide text-base-content/40 font-medium">
							{eyebrow}
						</p>
						<h3 className="font-bold text-lg">{title}</h3>
					</div>
				</div>
				<p className="text-sm text-base-content/60 leading-relaxed">{description}</p>
			</div>
		</div>
	);
}

function TierRow({
	tier,
	price,
	foundation,
	time,
	boost,
	cap,
}: {
	tier: string;
	price: string;
	foundation: string;
	time: string;
	boost: string;
	cap: string;
}) {
	const muted = (v: string) => (v === "—" ? "text-base-content/30" : "");
	return (
		<tr>
			<td className="font-medium">{tier}</td>
			<td className="text-right">{price}</td>
			<td className={`text-right ${muted(foundation)}`}>{foundation}</td>
			<td className={`text-right ${muted(time)}`}>{time}</td>
			<td className={`text-right ${muted(boost)}`}>{boost}</td>
			<td className="text-right text-base-content/60">{cap}</td>
		</tr>
	);
}

function GateThreshold({ amount, name, perk }: { amount: string; name: string; perk: string }) {
	return (
		<div className="flex items-center gap-3 rounded-lg bg-base-100 px-3 py-2">
			<LockOpenIcon className="w-4 h-4 text-success shrink-0" />
			<span className="font-mono text-xs w-12 shrink-0 text-base-content/70">{amount}</span>
			<span className="font-semibold text-sm w-24 shrink-0">{name}</span>
			<span className="text-xs text-base-content/50">{perk}</span>
		</div>
	);
}

function PricingCard({
	title,
	description,
	badge,
}: {
	title: string;
	description: string;
	badge: string;
}) {
	return (
		<div className="card bg-base-200">
			<div className="card-body p-5 text-center">
				<span className={`badge ${badge} mx-auto mb-2`}>{title}</span>
				<p className="text-sm text-base-content/60">{description}</p>
			</div>
		</div>
	);
}

function ControlCard({
	icon,
	title,
	description,
}: {
	icon: React.ReactNode;
	title: string;
	description: string;
}) {
	return (
		<div className="card bg-base-100 shadow-sm">
			<div className="card-body p-5">
				<div className="mb-2">{icon}</div>
				<h3 className="font-semibold text-sm mb-1">{title}</h3>
				<p className="text-xs text-base-content/60 leading-relaxed">{description}</p>
			</div>
		</div>
	);
}

type PurchaseScenario = {
	key: string;
	label: string;
	noun: string;
	blurb: string;
	price: number;
	sizeGb: number;
};

type PurchaseCategory = { key: string; label: string; scenarios: PurchaseScenario[] };

/** ~$0.01 per GB of egress (DigitalOcean Spaces-class bandwidth). */
const DELIVERY_PER_GB = 0.01;

/** Scenario sizes/prices; game tiers per the Kei/Midi/AA/AAA taxonomy. */
const PURCHASE_CATEGORIES: PurchaseCategory[] = [
	{
		key: "games",
		label: "Games",
		scenarios: [
			{
				key: "kei",
				label: "Kei",
				noun: "game",
				blurb: "Solo-dev gems like Undertale or Papers Please",
				price: 5,
				sizeGb: 0.3,
			},
			{
				key: "midi",
				label: "Midi",
				noun: "game",
				blurb: "Small-studio hits like Hades or Valheim",
				price: 17,
				sizeGb: 6,
			},
			{
				key: "aa",
				label: "AA",
				noun: "game",
				blurb: "Multi-million-dollar productions",
				price: 40,
				sizeGb: 25,
			},
			{
				key: "aaa",
				label: "AAA",
				noun: "game",
				blurb: "So big you'll want a new SSD to install it",
				price: 60,
				sizeGb: 90,
			},
		],
	},
	{
		key: "music",
		label: "Music",
		scenarios: [
			{
				key: "single",
				label: "Single",
				noun: "single",
				blurb: "One lossless track",
				price: 1,
				sizeGb: 0.04,
			},
			{ key: "ep", label: "EP", noun: "EP", blurb: "A handful of tracks", price: 6, sizeGb: 0.2 },
			{
				key: "album",
				label: "Album",
				noun: "album",
				blurb: "A full lossless album",
				price: 10,
				sizeGb: 0.5,
			},
		],
	},
	{
		key: "ebooks",
		label: "eBooks",
		scenarios: [
			{
				key: "novel",
				label: "Novel",
				noun: "novel",
				blurb: "Pure text, tiny file",
				price: 8,
				sizeGb: 0.001,
			},
			{
				key: "graphic",
				label: "Graphic novel",
				noun: "graphic novel",
				blurb: "Full-page illustrations",
				price: 15,
				sizeGb: 0.12,
			},
		],
	},
	{
		key: "films",
		label: "Films",
		scenarios: [
			{
				key: "short",
				label: "Short film",
				noun: "short film",
				blurb: "A festival-circuit short in HD",
				price: 3,
				sizeGb: 1.5,
			},
			{
				key: "feature",
				label: "Feature",
				noun: "film",
				blurb: "A full indie feature, yours to keep",
				price: 12,
				sizeGb: 6,
			},
			{
				key: "uhd",
				label: "4K feature",
				noun: "film",
				blurb: "The same feature, in 4K",
				price: 20,
				sizeGb: 22,
			},
		],
	},
	{
		key: "apps",
		label: "Apps",
		scenarios: [
			{
				key: "utility",
				label: "Utility",
				noun: "app",
				blurb: "A focused menu-bar tool or CLI",
				price: 5,
				sizeGb: 0.05,
			},
			{
				key: "plugin",
				label: "Plugin",
				noun: "plugin",
				blurb: "An add-on for software you already own",
				price: 15,
				sizeGb: 0.1,
			},
			{
				key: "pro",
				label: "Pro app",
				noun: "app",
				blurb: "A full desktop application",
				price: 30,
				sizeGb: 0.4,
			},
		],
	},
];

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toFixed(2)}`;

function PurchaseCalculator() {
	const [catKey, setCatKey] = useState("games");
	const [scenKey, setScenKey] = useState("midi");

	const category = PURCHASE_CATEGORIES.find((c) => c.key === catKey) ?? PURCHASE_CATEGORIES[0];
	const scenario = category.scenarios.find((s) => s.key === scenKey) ?? category.scenarios[0];

	const rawDelivery = scenario.sizeGb * DELIVERY_PER_GB;
	const delivery = round2(rawDelivery);
	const foundation = round2(scenario.price * (FOUNDATION_FEE_PERCENTAGE / 100));
	const processing = round2(scenario.price * 0.029 + 0.3);
	const total = round2(scenario.price + delivery + foundation + processing);
	const platformPortion = round2(delivery + foundation + processing);

	const deliveryDisplay = rawDelivery > 0 && delivery === 0 ? "<$0.01" : money(delivery);
	const nounCap = scenario.noun.charAt(0).toUpperCase() + scenario.noun.slice(1);
	const article = /^[aeiou]/i.test(scenario.noun) ? "an" : "a";

	return (
		<div className="max-w-3xl mx-auto card bg-base-100 shadow-sm">
			<div className="card-body">
				<div className="flex flex-col gap-3 mb-2">
					<div className="join self-center flex-wrap justify-center">
						{PURCHASE_CATEGORIES.map((c) => (
							<button
								key={c.key}
								type="button"
								onClick={() => {
									setCatKey(c.key);
									setScenKey(c.scenarios[0].key);
								}}
								className={`btn join-item btn-sm ${c.key === catKey ? "btn-secondary" : "btn-ghost"}`}
							>
								{c.label}
							</button>
						))}
					</div>
					<div className="join self-center flex-wrap justify-center">
						{category.scenarios.map((s) => (
							<button
								key={s.key}
								type="button"
								onClick={() => setScenKey(s.key)}
								className={`btn join-item btn-sm ${s.key === scenario.key ? "btn-primary" : "btn-outline btn-primary"}`}
							>
								{s.label}
							</button>
						))}
					</div>
					<p className="text-center text-xs text-base-content/50">{scenario.blurb}</p>
				</div>

				<table className="table table-sm">
					<tbody>
						<CalcRow
							label={`${nounCap} price`}
							desc="Listed purchase price, goes directly to the creator"
							amount={money(scenario.price)}
							strong
						/>
						<CalcRow
							label="Delivery"
							desc="Actual bandwidth cost of the content download"
							amount={deliveryDisplay}
						/>
						<CalcRow
							label="Anthers Foundation"
							desc={`${FOUNDATION_FEE_PERCENTAGE}% goes back to the community and charitable work`}
							amount={money(foundation)}
						/>
						<CalcRow
							label="Card processing"
							desc="2.9% + $0.30 with a card—less if you pay from your bank"
							amount={money(processing)}
						/>
					</tbody>
					<tfoot>
						<tr className="border-t border-base-300 text-base-content">
							<td className="font-bold">You pay</td>
							<td className="text-right font-mono font-bold">{money(total)}</td>
							<td className="hidden sm:table-cell text-xs text-base-content/50">
								In total, for {article} {scenario.noun} with no strings attached
							</td>
						</tr>
					</tfoot>
				</table>

				<p className="mt-4 text-sm text-base-content/70">
					In short: <span className="font-semibold text-base-content">{money(scenario.price)}</span>{" "}
					for your {scenario.noun}, straight to the creator—and just{" "}
					<span className="font-semibold text-base-content">{money(platformPortion)}</span> for an
					ad-free, charitable platform that keeps a healthier, freer creative community running
					forever, for every creator and for users like you.
				</p>

				<div className="mt-3 flex items-start gap-2 text-xs text-base-content/50">
					<BanknotesIcon className="w-4 h-4 text-success shrink-0 mt-0.5" />
					<span>
						Pay from your bank (ACH) instead of a card and processing shrinks to about 0.8%—on
						Anthers, you always get the cheaper rail.
					</span>
				</div>
			</div>
		</div>
	);
}

function CalcRow({
	label,
	desc,
	amount,
	strong,
}: {
	label: string;
	desc: string;
	amount: string;
	strong?: boolean;
}) {
	return (
		<tr>
			<td className={`align-top whitespace-nowrap ${strong ? "font-semibold" : ""}`}>{label}</td>
			<td className={`align-top text-right font-mono ${strong ? "font-semibold" : ""}`}>
				{amount}
			</td>
			<td className="align-top text-xs text-base-content/50 hidden sm:table-cell">{desc}</td>
		</tr>
	);
}
