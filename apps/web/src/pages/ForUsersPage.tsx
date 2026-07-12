// SPDX-License-Identifier: AGPL-3.0-or-later
import { USAGE_AFF_PER_GIB } from "@anthers/shared/constants";
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
	GiftIcon,
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
							description="Anthers keeps nothing—a zero-cut platform. Every dollar you pay is exactly one of four things: bandwidth at cost, money to creators, the Anthers Foundation's charity fee, or card and tax. Boosts and direct purchases go 100% to creators. Each fee is a named line item—never a silent percentage skimmed off the top."
						/>
						<Pillar
							icon={<SignalIcon className="w-7 h-7 text-secondary" />}
							tone="bg-secondary/15"
							title="You pay for what you use"
							description="No ads paying for infrastructure by monetizing your time and data. Delivery costs are small, transparent, and—uniquely—something you can actually see and control."
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

			{/* ───────────── Three ways to use Anthers ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-5xl">
					<h2 className="text-3xl font-bold text-center mb-4">Three ways to use Anthers</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						There are three ways to reach content and creators here—free use, one-time purchases,
						and ongoing support. They aren't rival plans to choose between; they're layers you
						combine however suits you.
					</p>

					<div className="grid grid-cols-1 md:grid-cols-3 gap-6">
						<WaySignpost
							step="1"
							tone="bg-secondary/15 text-secondary"
							title="Free use"
							description="Browse, download free content, and play web games within a generous free allowance—no account required."
						/>
						<WaySignpost
							step="2"
							tone="bg-primary/15 text-primary"
							title="One-time purchases"
							description="Buy a game, album, film, or book outright. The creator's price is exactly what they receive."
						/>
						<WaySignpost
							step="3"
							tone="bg-success/15 text-success"
							title="Support"
							description="Buy Usage for open access and send Boosts to creators—unlocking more across the platform, a dollar at a time."
						/>
					</div>

					<p className="text-center text-sm text-base-content/50 mt-8 max-w-2xl mx-auto">
						Distinct, but fully combinable. A free account can still make a one-time purchase, and
						supporting creators still gets you everything a free user does—plus more.
					</p>
				</div>
			</section>

			{/* ───────────── ① Free use ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<p className="text-sm font-medium text-secondary mb-3 tracking-wide uppercase text-center">
						① Free use
					</p>
					<h2 className="text-3xl font-bold text-center mb-4">Free, and always will be</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Anthers has a free tier, and it isn't a trial or a teaser you're meant to grow out of.
						It's a standing commitment from the Anthers Foundation—a non-profit—that reaching
						creative work shouldn't depend on your ability to pay. No ads, no selling your data, no
						manufactured friction to herd you toward paying.
					</p>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
						{/* How free stays free */}
						<div className="card bg-base-100 shadow-sm">
							<div className="card-body">
								<div className="flex items-center gap-3 mb-2">
									<div className="w-11 h-11 rounded-full bg-primary/15 flex items-center justify-center">
										<HeartIcon className="w-6 h-6 text-primary" />
									</div>
									<h3 className="font-bold text-lg">How free stays free</h3>
								</div>
								<p className="text-sm text-base-content/60 leading-relaxed mb-3">
									Every free tier is paid for by someone. On ad-funded platforms it's
									advertisers—which makes you the product. On Anthers, the small cost of a free
									viewer's bandwidth is covered by the Anthers Foundation's Subsidy pool—funded by
									the charity fee on paid Usage, and pooled across the whole community—so free
									access never depends on ads or on selling your data.
								</p>
								<p className="text-sm text-base-content/60 leading-relaxed">
									Instead of one powerful company amassing a war chest by selling ads and data, the
									small real costs are diffused across everyone who benefits. That's not
									free-as-in-loss-leader; it's free-as-in-shared-responsibility—the way a healthier
									internet ought to work.
								</p>
							</div>
						</div>

						{/* What a free account includes */}
						<div className="card bg-base-100 shadow-sm">
							<div className="card-body">
								<div className="flex items-center gap-3 mb-2">
									<div className="w-11 h-11 rounded-full bg-secondary/15 flex items-center justify-center">
										<GiftIcon className="w-6 h-6 text-secondary" />
									</div>
									<h3 className="font-bold text-lg">What a free account includes</h3>
								</div>
								<div className="flex flex-col gap-2 text-sm mt-1">
									<FreeLimit included>
										Your first 3 GiB of delivery each month—watching, listening, reading, and
										playing—covered by the Foundation.
									</FreeLimit>
									<FreeLimit included>
										Everything a creator has chosen to make free, with no login wall and no
										"subscribe to download" trick.
									</FreeLimit>
									<FreeLimit included>
										Web games you can play instantly, no account required.
									</FreeLimit>
									<FreeLimit>
										Gated Boost and Badge content stays locked until you support the creator or
										platform.
									</FreeLimit>
									<FreeLimit>
										Free time doesn't fund the creator pools—that's what buying Usage and boosting
										add.
									</FreeLimit>
								</div>
							</div>
						</div>
					</div>

					<p className="text-center text-sm text-base-content/50 mt-8 max-w-2xl mx-auto">
						These limits exist to keep the free tier something the Foundation can sustain
						indefinitely—not to nag you into upgrading. If free is all you ever use, that's the
						platform working as intended.
					</p>
				</div>
			</section>

			{/* ───────────── ② One-time purchases ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<p className="text-sm font-medium text-primary mb-3 tracking-wide uppercase text-center">
						② One-time purchases
					</p>
					<h2 className="text-3xl font-bold text-center mb-4">
						Buy it once—the price is what the creator gets
					</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						You never need an ongoing plan to get something on Anthers. Games, albums, films, books,
						and apps can be bought outright—a one-time purchase, yours to keep. The creator's listed
						price is exactly what they receive; real costs are added on top and itemized, so you see
						every penny before you pay—and you can lower them by paying from your bank.
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
							title="A tiny Foundation fee, not a platform tax"
						>
							The only thing added beyond real costs is the Anthers Foundation Fee—on a download,
							just half the bandwidth it takes to deliver it. It funds charitable programs and free
							access for others, instead of enriching shareholders. Anthers itself keeps $0.
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

			{/* ───────────── ③ Support, split transparently ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<p className="text-sm font-medium text-success mb-3 tracking-wide uppercase text-center">
						③ Support
					</p>
					<h2 className="text-3xl font-bold text-center mb-4">Support, split transparently</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						The third way—and where most creators earn the most. Instead of one fixed price, you
						make two independent choices: buy Usage for open, watch-anything access, and send
						Boosts—a dollar at a time—to the creators you want to fund. At every amount the split is
						the same and nothing is hidden: bandwidth at cost, a small Foundation charity fee, and
						the rest to creators. Anthers keeps $0.
					</p>

					{/* Breakdown visual */}
					<div className="max-w-3xl mx-auto card bg-base-100 shadow-sm mb-12">
						<div className="card-body">
							<div className="flex items-baseline justify-between mb-1">
								<h3 className="font-bold text-lg">Where a $7 Sprout month goes</h3>
								<span className="text-sm text-base-content/50">200 GiB usage + $1 boost</span>
							</div>
							<div className="flex flex-col gap-3 text-sm mt-2">
								<SplitRow
									label="Bandwidth — delivery, at cost"
									amount="$2.00"
									barClass="bg-base-300"
									widthClass="w-[29%]"
								/>
								<SplitRow
									label="Anthers Foundation Fee — charity"
									amount="$1.00"
									barClass="bg-info"
									widthClass="w-[14%]"
								/>
								<SplitRow
									label="Time Pool — creators, by time spent"
									amount="$3.00"
									barClass="bg-secondary"
									widthClass="w-[43%]"
								/>
								<SplitRow
									label="Boost — creators you direct it to"
									amount="$1.00"
									barClass="bg-primary"
									widthClass="w-[14%]"
								/>
							</div>
							<div className="divider my-2" />
							<div className="flex justify-between text-sm font-semibold">
								<span>To creators (Time Pool + Boost)</span>
								<span className="text-success">$4.00</span>
							</div>
							<p className="text-xs text-base-content/40 mt-2">
								Card processing and sales tax are added on top and leave the system entirely—they go
								to the processor and the state, never to Anthers. Anthers's own cut is $0.
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
							description="Funded by your Usage and distributed automatically by the time you spend—and a minute is a minute. Watching a video, reading an essay, listening to an album, and playing a game all count exactly the same. Every creator you spend time with gets funded, with no effort from you."
						/>
						<ConceptCard
							icon={<BoltIcon className="w-6 h-6 text-primary" />}
							tone="bg-primary/15"
							eyebrow="Your call"
							title="Boost"
							description="Point your support wherever you want, in $1 units—or leave it on auto and it follows your time. Every boost dollar goes 100% to creators—no fee, nothing skimmed for processing. Boost is how you champion the creators who matter most to you, and it's what unlocks their premium content. Anything you don't direct is shared out by your time spent, so nothing is wasted."
						/>
					</div>
				</div>
			</section>

			{/* ───────────── Anthers Badge ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">
						Your Anthers Badge—a rank that grows with you
					</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Everything you spend—Usage and Boosts alike—earns you an Anthers Badge. It isn't a plan
						you pick or a tier you subscribe to: it's a rank you grow into, like a plant reaching
						for light. Support more over time and you climb; ease off and it gently recedes. No
						commitment, no lock-in—just recognition for backing the work you love.
					</p>

					<div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl mx-auto">
						<BadgeRank
							emoji="🌰"
							name="Root"
							threshold="$3+"
							tone="bg-warning/15"
							flavor="Your first few dollars of support—you're on the board."
						/>
						<BadgeRank
							emoji="🌱"
							name="Sprout"
							threshold="$7+"
							tone="bg-success/15"
							flavor="Putting down roots, supporting creators month to month."
						/>
						<BadgeRank
							emoji="🌷"
							name="Petal"
							threshold="$15+"
							tone="bg-secondary/15"
							flavor="In full leaf—a real pillar for the creators you follow."
						/>
						<BadgeRank
							emoji="🌸"
							name="Blossom"
							threshold="$30+"
							tone="bg-primary/15"
							flavor="Flourishing—among the platform's most devoted supporters."
						/>
					</div>

					<p className="text-center text-sm text-base-content/50 mt-8 max-w-2xl mx-auto">
						Everyone starts unranked; your first $3 of combined Usage + Boost earns Root. Your badge
						reflects the last few months of spend, so it moves with you—and some creators use it as
						a key, opening content to whole ranks at once (that's an Anthers Gate, just below).
					</p>
				</div>
			</section>

			{/* ───────────── Gates ───────────── */}
			<section className="bg-base-200/50 py-20">
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
									<GateThreshold amount="$2" name="Insider" perk="Early access, community posts" />
									<GateThreshold
										amount="$3"
										name="Supporter"
										perk="Behind-the-scenes, extended cuts"
									/>
									<GateThreshold amount="$5" name="Champion" perk="Monthly Q&A, name in credits" />
								</div>
							</div>
						</div>

						{/* Anthers gates */}
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
										<h3 className="font-bold text-lg">Anthers Gates</h3>
									</div>
								</div>
								<p className="text-sm text-base-content/60 mb-4">
									Earn a Badge by clearing a combined-spend threshold to unlock that badge's content
									across <em>every</em> creator—even ones you don't boost. Spending more to reach
									one creator lifts your standing for all of them, so support becomes a rising tide.
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
										name="Blossom"
										perk="Blossom-level content, platform-wide"
									/>
								</div>
							</div>
						</div>
					</div>

					<p className="text-center text-sm text-base-content/50 mt-8 max-w-2xl mx-auto">
						Creators can combine both—for example,{" "}
						<span className="text-base-content/70">
							"anyone with a Petal badge <em>or</em> boosting $3+ to me"
						</span>
						—so there's usually more than one way in.
					</p>
				</div>
			</section>

			{/* ───────────── Delivery ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">
						Pay for the bandwidth you use—and control it
					</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Streaming and downloads cost bandwidth. Every other platform hides that cost inside ad
						revenue or a giant platform cut. Anthers shows it: bandwidth is a line item in your
						Usage—at cost, separate from the creator's share. Because it's visible, you get real
						tools to keep it low—something no ad-funded platform can offer.
					</p>

					<div className="max-w-3xl mx-auto mb-12 rounded-xl bg-base-100 p-6 text-center shadow-sm">
						<p className="text-base-content/70">
							<span className="font-bold text-success">
								Your first 3 GiB of usage each month is free
							</span>
							, covered by the Foundation—a couple of hours of HD video, or far more audio and
							reading. Go beyond that and Usage is just $0.03/GiB—a third of it real bandwidth, at
							cost.
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
			<section className="bg-base-200/50 py-20">
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

function WaySignpost({
	step,
	tone,
	title,
	description,
}: {
	step: string;
	tone: string;
	title: string;
	description: string;
}) {
	return (
		<div className="card bg-base-200 h-full">
			<div className="card-body items-center text-center p-6">
				<div
					className={`w-10 h-10 rounded-full ${tone} flex items-center justify-center font-bold text-lg mb-1`}
				>
					{step}
				</div>
				<h3 className="font-bold text-lg">{title}</h3>
				<p className="text-sm text-base-content/60 leading-relaxed">{description}</p>
			</div>
		</div>
	);
}

function FreeLimit({ included, children }: { included?: boolean; children: React.ReactNode }) {
	return (
		<div className="flex items-start gap-2.5">
			{included ? (
				<CheckCircleIcon className="w-5 h-5 text-success shrink-0 mt-0.5" />
			) : (
				<span className="w-5 h-5 shrink-0 mt-0.5 flex items-center justify-center font-bold text-base-content/30">
					–
				</span>
			)}
			<span className="text-base-content/70">{children}</span>
		</div>
	);
}

function BadgeRank({
	emoji,
	name,
	threshold,
	flavor,
	tone,
}: {
	emoji: string;
	name: string;
	threshold: string;
	flavor: string;
	tone: string;
}) {
	return (
		<div className="card bg-base-100 shadow-sm h-full">
			<div className="card-body items-center text-center gap-1 p-5">
				<div className={`w-16 h-16 rounded-full ${tone} flex items-center justify-center text-3xl`}>
					<span aria-hidden="true">{emoji}</span>
				</div>
				<h3 className="font-bold text-lg mt-1">{name}</h3>
				<span className="badge badge-ghost badge-sm font-mono">{threshold}</span>
				<p className="text-xs text-base-content/60 leading-relaxed mt-1">{flavor}</p>
			</div>
		</div>
	);
}

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
	const rawFoundation = scenario.sizeGb * USAGE_AFF_PER_GIB;
	const foundation = round2(rawFoundation);
	const processing = round2(scenario.price * 0.029 + 0.3);
	const total = round2(scenario.price + delivery + foundation + processing);
	const platformPortion = round2(delivery + foundation + processing);

	const deliveryDisplay = rawDelivery > 0 && delivery === 0 ? "<$0.01" : money(delivery);
	const foundationDisplay = rawFoundation > 0 && foundation === 0 ? "<$0.01" : money(foundation);
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
							desc="Half the download's bandwidth—the Foundation's charity fee, funding free access for others"
							amount={foundationDisplay}
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
					<span className="font-semibold text-base-content">{money(platformPortion)}</span> in real
					costs on top: bandwidth at cost, the Foundation's charity fee, and card processing. None
					of it is a cut for Anthers, which keeps $0.
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
