// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The For Creators marketing page — restyled into the Meadow design (matching
// /for-users). Airy editorial forest-green, Fraunces display serif over Nunito
// Sans, wrapped in the shared <MeadowDecor> (pollen + woven side vines); the
// shared LoggedOutLayout supplies the Meadow footer + grassy floor. Copy tracks the
// V4 "Big Rethink" model: users choose a Badge plan (Free/Root/Sprout/Petal/Blossom),
// Seeds are $1 direct-to-creator units, bandwidth is a separate at-cost wallet. The
// lead pitch is the 0% cut on Seeds and direct sales — Patreon/Bandcamp/Steam/itch, first;
// public streaming is a secondary benefit (discovery + at-cost reach). Anthers plan
// figures come from @anthers/shared/constants; competitor figures are rough public
// estimates (illustrative).
//
// Section flow: a brief "The problem" (what's wrong across every kind of platform)
// sets up "The solution" — an interactive matrix (how a fan supports you × the
// medium) showing what reaches the creator vs. the platform on Anthers and
// elsewhere.

import { BADGE_ORDER, BADGE_PLANS, badgeLabel, SEED_PRICE } from "@anthers/shared/constants";
import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { MeadowDecor } from "@anthers/web-shared/decor/MeadowDecor";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Card, Eyebrow, H2, Lede, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link } from "@anthers/web-shared/router";
import {
	ArrowDownTrayIcon,
	ArrowPathIcon,
	ChartBarIcon,
	ChatBubbleLeftRightIcon,
	CurrencyDollarIcon,
	DocumentTextIcon,
	EyeIcon,
	FilmIcon,
	GlobeAltIcon,
	LockClosedIcon,
	LockOpenIcon,
	MusicalNoteIcon,
	PaintBrushIcon,
	PuzzlePieceIcon,
	ServerStackIcon,
	ShieldCheckIcon,
	ShoppingBagIcon,
	Squares2X2Icon,
	StarIcon,
	TrophyIcon,
	UserGroupIcon,
} from "@heroicons/react/24/outline";
import { useState } from "react";

const serif = { fontFamily: FONTS.fraunces };

/** Whole dollars render bare ($4); fractional plans keep cents ($0.05). */
const fmtMoney = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/** Badge glyphs, low → high (matches the economics widget's ladder emoji). */
const BADGE_EMOJI: Record<string, string> = {
	// free: "🌰",
	root: "🫚",
	sprout: "🌱",
	petal: "🌷",
	blossom: "🌼",
};

export default function ForCreatorsPage() {
	const { isAuthenticated } = useAuth();
	const startHref = isAuthenticated ? "/dashboard" : "/signup";

	return (
		<MeadowDecor floor={false} style={{ fontFamily: FONTS.nunito }}>
			{/* Hero */}
			<header className="bg-base-200/70">
				<div className="mx-auto max-w-5xl px-6 pt-24 pb-20 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-5 h-11 w-11 text-primary/60" />
						<p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
							For Creators
						</p>
						<h1
							style={serif}
							className="text-balance text-5xl font-light leading-[1.05] tracking-tight sm:text-7xl"
						>
							Publish your work.
							<br />
							<em className="font-medium text-primary not-italic">Keep what you earn.</em>
						</h1>
					</Reveal>
					<Reveal delay={150}>
						<p className="mx-auto mt-8 max-w-4xl text-lg leading-relaxed text-base-content/75">
							Anthers is Patreon, Bandcamp, Steam, and itch—at a 0% cut. Games, videos, music, and
							writing under one roof, one identity, one audience. Seeds and sales reach you in full,
							with no hidden fees.
						</p>
					</Reveal>
					<Reveal delay={300}>
						<div className="mt-9 flex flex-wrap justify-center gap-3">
							<Link to={startHref} className="btn btn-primary lg px-8">
								Start Creating
							</Link>
							<Link
								to="/demo-creator-page"
								className="btn btn-outline rounded-full border-base-content/20 px-7"
							>
								See What Others Built
							</Link>
						</div>
						<BrandGlyph
							name="divider-botanical"
							className="-mb-20 -mt-5 h-24 w-52 text-primary/45"
						/>
					</Reveal>
				</div>
			</header>

			{/* The problem — brief: what's wrong across every kind of platform */}
			<Section>
				<Reveal>
					<Eyebrow>The problem</Eyebrow>
					<H2>The creator internet is rigged</H2>
					<Lede>
						Every kind of platform has its own way of taking from creators—and none of them let you
						be all of who you are in one place.
					</Lede>
				</Reveal>
				<div className="mx-auto mt-12 grid max-w-4xl gap-x-10 gap-y-8 text-left sm:grid-cols-2">
					<Reveal delay={0}>
						<Feature
							icon={<CurrencyDollarIcon className="h-6 w-6" />}
							title="Storefronts skim every sale"
							description="Steam, the App Store, and the rest take 10–30% of everything your fans pay you."
						/>
					</Reveal>
					<Reveal delay={80}>
						<Feature
							icon={<EyeIcon className="h-6 w-6" />}
							title="Ad platforms pay pennies"
							description="YouTube-style platforms hand you a sliver of ad revenue—and turn your fans into the product."
						/>
					</Reveal>
					<Reveal delay={160}>
						<Feature
							icon={<LockClosedIcon className="h-6 w-6" />}
							title="Memberships skim and silo"
							description="Patreon, Twitch, and Substack take a cut of your supporters' money and hold your audience hostage."
						/>
					</Reveal>
					<Reveal delay={240}>
						<Feature
							icon={<Squares2X2Icon className="h-6 w-6" />}
							title="Your work is scattered"
							description="A game, a soundtrack, a devlog, a zine—each needs a different platform and a separate audience."
						/>
					</Reveal>
				</div>
			</Section>

			{/* The solution — one home, 0% cut on Seeds and sales; explore the economics live */}
			<Section tint>
				<Reveal>
					<Eyebrow>The solution</Eyebrow>
					<H2>When someone pays you, that's what you get paid.</H2>
					<Lede>
						Anthers is Patreon, Bandcamp, Steam, and itch, at a 0% cut. Direct purchases and
						channel-supporting Seeds are paid 100% to you; streaming makes your work discoverable to
						users at-cost.
					</Lede>
					<Lede>
						Try out all the ways a fan can support you, and see what happens when you cut out the
						for-profit middlemen.
					</Lede>
				</Reveal>
				<Reveal delay={80} className="mt-12">
					<SolutionExplorer />
				</Reveal>
			</Section>

			{/* Transparent pricing — the itemized receipt behind the pass-through pricing */}
			<Section>
				<Reveal>
					<Eyebrow>Transparent by design</Eyebrow>
					<H2>Transparent pricing, not platform rent</H2>
					<Lede>
						At checkout, buyers see exactly where every penny goes. No hidden fees, no opaque
						"revenue share." Real infrastructure costs are passed through—and they're tiny.
					</Lede>
				</Reveal>
				<div className="mx-auto mt-12 grid max-w-4xl gap-6 text-left md:grid-cols-2">
					<Reveal className="h-full">
						<Card className="h-full">
							<h3 style={serif} className="mb-4 text-lg font-medium">
								Example: $10 game, 2 GiB download (card payment)
							</h3>
							<div className="flex flex-col gap-2 text-sm">
								<ReceiptLine label="Game price (to creator)" amount="$10.00" bold />
								<ReceiptLine
									label="Download bandwidth (2 GiB @ $0.01/GiB, at cost)"
									amount="$0.02"
								/>
								<ReceiptLine label="Community Share (50% of bandwidth)" amount="$0.01" />
								<ReceiptLine label="Payment processing (2.9% + $0.30)" amount="$0.59" />
								<div className="my-1 border-t border-base-content/10" />
								<ReceiptLine label="You pay" amount="$10.62" bold />
							</div>
							<p className="mt-3 text-xs text-base-content/45">
								Creator receives $10.00—every time. Costs are added on top, never subtracted.
							</p>
						</Card>
					</Reveal>
					<Reveal delay={110} className="h-full">
						<div className="flex h-full flex-col justify-center gap-6">
							<PricePoint icon={<ShieldCheckIcon className="h-5 w-5" />} title="No percentage cut">
								The creator's price is the creator's revenue. Full stop.
							</PricePoint>
							<PricePoint icon={<EyeIcon className="h-5 w-5" />} title="Full visibility">
								Every fee is itemized and explained. Buyers understand what they're paying for.
								Creators understand what they're earning.
							</PricePoint>
							<PricePoint
								icon={<ServerStackIcon className="h-5 w-5" />}
								title="The Community Share"
							>
								Anthers' one markup rides on the infrastructure a transaction actually uses—50% of
								the bandwidth a download or stream needs, plus 50% of creator storage. It funds free
								access, charitable programs, and lean operations. It's a community investment, not a
								platform tax—Anthers itself never profits.
							</PricePoint>
						</div>
					</Reveal>
				</div>
				<div className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-3">
					<Reveal delay={0} className="h-full">
						<PricingOption title="Free">
							No charge—anyone can download or play in the browser within their free allowance.
							Great for jam entries, demos, and open-source projects.
						</PricingOption>
					</Reveal>
					<Reveal delay={110} className="h-full">
						<PricingOption title="Pay What You Want">
							Set a suggested price and an optional minimum. Let your audience decide what your work
							is worth to them.
						</PricingOption>
					</Reveal>
					<Reveal delay={220} className="h-full">
						<PricingOption title="Fixed Price">
							Set your price and receive 100% of it. Transparent fees are added on top for the
							buyer—never taken from your cut.
						</PricingOption>
					</Reveal>
				</div>
			</Section>

			{/* Multi-media showcase */}
			<Section tint>
				<Reveal>
					<Eyebrow>Every medium</Eyebrow>
					<H2>Every kind of creative work</H2>
					<Lede>
						Anthers isn't just for games. Publish anything you create—the platform adapts to the
						medium while keeping the same tools, the same audience, and the same economics.
					</Lede>
				</Reveal>
				<div className="mt-14 grid gap-6 text-left sm:grid-cols-2 lg:grid-cols-4">
					<Reveal delay={0} className="h-full">
						<MediaCard
							icon={<PuzzlePieceIcon className="h-8 w-8" />}
							title="Games"
							description="Upload builds for Windows, Mac, Linux. Host HTML5 games playable in the browser. Manage versions, platforms, and pricing."
							features={["Multi-platform downloads", "Web game embedding", "Game jam support"]}
						/>
					</Reveal>
					<Reveal delay={100} className="h-full">
						<MediaCard
							icon={<FilmIcon className="h-8 w-8" />}
							title="Video"
							description="Publish video content alongside your other work. Your devlog videos and your games live in the same place, for the same audience."
							features={["Native hosting", "Devlog series", "Creator portfolio"]}
						/>
					</Reveal>
					<Reveal delay={200} className="h-full">
						<MediaCard
							icon={<MusicalNoteIcon className="h-8 w-8" />}
							title="Audio"
							description="Share music, soundtracks, podcasts. A game composer can publish their soundtrack right alongside the game it belongs to."
							features={["Album & track hosting", "Soundtrack bundling", "Streaming playback"]}
						/>
					</Reveal>
					<Reveal delay={300} className="h-full">
						<MediaCard
							icon={<DocumentTextIcon className="h-8 w-8" />}
							title="Writing"
							description="Essays, tutorials, fiction, devlogs. First-class publishing for written content with your full creator profile and audience behind it."
							features={["Rich text posts", "Devlog journals", "Standalone essays"]}
						/>
					</Reveal>
				</div>
			</Section>

			{/* Feature showcase */}
			<Section>
				<Reveal>
					<Eyebrow>The toolkit</Eyebrow>
					<H2>Everything you need to publish and grow</H2>
				</Reveal>
				<div className="mx-auto mt-14 grid max-w-5xl gap-x-12 gap-y-10 text-left md:grid-cols-2">
					<Reveal delay={0}>
						<Feature
							icon={<PaintBrushIcon className="h-6 w-6" />}
							title="Rich project pages"
							description="Cover images, screenshots, detailed descriptions, and download links. Each project gets a dedicated page that adapts to its media type—platform-grouped downloads for games, embedded players for audio and video."
						/>
					</Reveal>
					<Reveal delay={80}>
						<Feature
							icon={<ArrowDownTrayIcon className="h-6 w-6" />}
							title="Build management"
							description="Upload builds for multiple platforms. Label versions as stable, beta, or prerelease. Your audience downloads from organized, clearly labeled files—not a confusing pile of .zips."
						/>
					</Reveal>
					<Reveal delay={160}>
						<Feature
							icon={<ChatBubbleLeftRightIcon className="h-6 w-6" />}
							title="Devlogs and posts"
							description="Write updates, announcements, and essays. Link posts to specific projects as devlogs, or publish standalone. Your audience follows your work in a unified feed—like Patreon, but alongside your actual projects."
						/>
					</Reveal>
					<Reveal delay={240}>
						<Feature
							icon={<StarIcon className="h-6 w-6" />}
							title="Ratings and comments"
							description="Community feedback built into every project page. Ratings help the best work surface. Comments create conversation around your creations."
						/>
					</Reveal>
					<Reveal delay={320}>
						<Feature
							icon={<TrophyIcon className="h-6 w-6" />}
							title="Game jams"
							description="Host and participate in game jams with timed submission periods, theme reveals, community voting, and ranked results. Jams are how communities form and creators get discovered."
						/>
					</Reveal>
					<Reveal delay={400}>
						<Feature
							icon={<ChartBarIcon className="h-6 w-6" />}
							title="Creator dashboard"
							description="See your projects, posts, follower count, and content at a glance. Manage drafts and published work from one place. Create and edit projects with rich forms, upload builds, and manage screenshots."
						/>
					</Reveal>
					<Reveal delay={480}>
						<Feature
							icon={<UserGroupIcon className="h-6 w-6" />}
							title="Creator profiles"
							description="Your own anther on Anthers—header image, bio, links, and all your work in one place. Audiences follow you, not individual projects. Like a Patreon page and an itch.io profile combined."
						/>
					</Reveal>
					<Reveal delay={560}>
						<Feature
							icon={<ArrowPathIcon className="h-6 w-6" />}
							title="Follow and feed"
							description="Follow creators you care about and get their updates in a personalized feed. New project? Devlog post? Game jam entry? It all shows up in one timeline."
						/>
					</Reveal>
				</div>
			</Section>

			{/* Audience building */}
			<Section tint>
				<Reveal>
					<Eyebrow>Your audience</Eyebrow>
					<H2>Build your audience in one place</H2>
					<Lede>
						Like Patreon and YouTube Memberships, but alongside your actual work. Post devlogs,
						vlogs, podcasts, and blogs—all under the same profile your games live on. Your audience
						follows <em className="not-italic text-base-content/80">you</em>, not a platform.
					</Lede>
				</Reveal>
				<div className="mx-auto mt-12 grid max-w-4xl gap-6 text-left md:grid-cols-2">
					<Reveal delay={0} className="h-full">
						<Card className="card-lift h-full">
							<h3 style={serif} className="mb-2 text-lg font-medium">
								Native content creation
							</h3>
							<p className="text-sm leading-relaxed text-base-content/70">
								Write devlogs, upload video updates, share podcast episodes — all natively hosted.
								No linking out to YouTube or Substack. Your content lives where your audience
								already is.
							</p>
						</Card>
					</Reveal>
					<Reveal delay={110} className="h-full">
						<Card className="card-lift h-full">
							<h3 style={serif} className="mb-2 text-lg font-medium">
								Cross-publishing <span className="text-xs text-base-content/45">(coming soon)</span>
							</h3>
							<p className="text-sm leading-relaxed text-base-content/70">
								Publish once, distribute everywhere. Push videos to YouTube, builds to Steam and
								itch.io, posts to Substack—all from your Anthers dashboard. Unified analytics show
								performance across all platforms.
							</p>
						</Card>
					</Reveal>
				</div>
			</Section>

			{/* Badge plans — how users fund you (V4: chosen plans, not rolling spend) */}
			<Section>
				<Reveal>
					<Eyebrow>How users pay you</Eyebrow>
					<H2>Users fund creators, not platforms</H2>
					<Lede>
						A user chooses a Badge plan. Its whole-dollar price is money to creators—the Time Pool,
						shared out by watch-time, plus included Seeds sent straight to the creators they
						pick—and a small Community Share to the Anthers Foundation. Bandwidth is separate: an
						at-cost wallet, not a funding lever. Anthers is a 501(c)(3) non-profit—no investors, no
						profit-taking.
					</Lede>
				</Reveal>
				<Reveal className="mx-auto mt-12 block max-w-3xl">
					<Card className="overflow-x-auto">
						<table className="table">
							<thead>
								<tr className="border-base-content/10">
									{["Badge", "Price", "Time Pool", "Seeds", "Community Share", "To creators"].map(
										(h, i) => (
											<th
												key={h}
												style={serif}
												className={`font-medium ${i === 0 ? "" : "text-right"}`}
											>
												{h}
											</th>
										),
									)}
								</tr>
							</thead>
							<tbody>
								{BADGE_ORDER.map((b) => {
									const plan = BADGE_PLANS[b];
									const toCreators = plan.timePool + plan.seeds * SEED_PRICE;
									const community = plan.price - toCreators;
									const isFree = b === "free";
									return (
										<tr
											key={b}
											className={`border-base-content/10 ${isFree ? "text-base-content/45" : ""}`}
										>
											<td className={isFree ? "" : "font-medium"}>
												{BADGE_EMOJI[b]} {badgeLabel(b)}
											</td>
											<td className="text-right text-base-content/70">{fmtMoney(plan.price)}</td>
											<td className="text-right text-base-content/70">{fmtMoney(plan.timePool)}</td>
											<td className="text-right text-base-content/70">
												{plan.seeds === 0 ? "—" : plan.seeds}
											</td>
											<td className="text-right text-base-content/70">
												{isFree ? "—" : fmtMoney(community)}
											</td>
											<td className="text-right font-medium text-primary">
												{fmtMoney(toCreators)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</Card>
				</Reveal>
				<Reveal>
					<p className="mx-auto mt-5 max-w-2xl text-xs leading-relaxed text-base-content/45">
						A Badge is the plan a user holds right now—a point-in-time choice, not a rolling total
						of past spend. Every Seed is $1 and goes 100% to the creator it's given to, nothing
						skimmed. The Time Pool pays creators by the time people spend with their work. Bandwidth
						lives in a separate at-cost wallet ($0.01/GiB) with a free monthly allowance on every
						plan (5/10/20/30/50 GiB), and creators get 50 GiB of free storage. Coming soon.
					</p>
				</Reveal>
			</Section>

			{/* Your identity & work — profile + project-page previews, one section */}
			<Section tint>
				<Reveal>
					<Eyebrow>Your identity &amp; work</Eyebrow>
					<H2>Your home on the internet</H2>
					<Lede>
						Every creator gets a profile that brings together everything they do—games, devlogs,
						music, writing—and every project gets a full-featured page adapted to the kind of work
						you're sharing. One identity, one audience, one URL to share.
					</Lede>
				</Reveal>
				<Reveal className="mx-auto mt-12 block max-w-2xl">
					<p className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary/70">
						Your profile
					</p>
					<Card className="overflow-hidden !p-0 text-left">
						<div className="h-32 bg-gradient-to-r from-primary/30 to-secondary/30" />
						<div className="-mt-10 p-7">
							<div className="mb-4 flex items-end gap-4">
								<div className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-base-100 bg-base-300 text-2xl font-bold text-base-content/40">
									A
								</div>
								<div className="pb-1">
									<h3 style={serif} className="text-lg font-medium">
										Alex Chen
									</h3>
									<p className="text-sm text-base-content/50">@alexchen · 2,847 followers</p>
								</div>
							</div>
							<p className="mb-4 text-sm text-base-content/70">
								Indie game developer and composer. Making puzzle games and ambient soundtracks.
								Previously shipped Lumina and Glass Garden.
							</p>
							<div className="flex gap-1 border-b border-base-content/10 text-sm">
								<span className="border-b-2 border-primary px-3 pb-2 font-medium text-primary">
									Projects (12)
								</span>
								<span className="px-3 pb-2 text-base-content/50">Posts (34)</span>
								<span className="px-3 pb-2 text-base-content/50">About</span>
							</div>
							<div className="mt-4 grid grid-cols-2 gap-3">
								{[
									{ title: "Glass Garden", type: "Game" },
									{ title: "Ambient Vol. 3", type: "Audio" },
									{ title: "Lumina OST", type: "Audio" },
									{ title: "Dev Diary: Shaders", type: "Text" },
								].map((item) => (
									<div key={item.title} className="rounded-lg bg-base-200 p-3">
										<span className="mb-1 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
											{item.type}
										</span>
										<p className="text-sm font-medium">{item.title}</p>
									</div>
								))}
							</div>
						</div>
					</Card>
				</Reveal>
				<Reveal delay={110} className="mx-auto mt-10 block max-w-2xl">
					<p className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary/70">
						A project page
					</p>
					<Card className="overflow-hidden !p-0 text-left">
						<div className="flex h-44 items-center justify-center bg-gradient-to-br from-secondary/20 to-primary/20">
							<span className="text-5xl opacity-30">🎮</span>
						</div>
						<div className="p-7">
							<div className="mb-1 flex items-center gap-2">
								<span className="rounded-full bg-secondary/15 px-2 py-0.5 text-xs font-medium text-secondary-content">
									Game
								</span>
								<span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
									Free
								</span>
							</div>
							<h3 style={serif} className="text-xl font-medium">
								Glass Garden
							</h3>
							<p className="text-sm text-base-content/60">
								A meditative puzzle game about growing crystalline gardens. Explore procedurally
								generated environments and discover hidden patterns in the growth.
							</p>
							<div className="mt-1 flex items-center gap-1 text-sm text-warning">
								{[1, 2, 3, 4, 5].map((n) => (
									<StarIcon
										key={n}
										className={`h-4 w-4 ${n <= 4 ? "fill-current" : "opacity-30"}`}
									/>
								))}
								<span className="ml-1 text-base-content/50">4.2 (128 ratings)</span>
							</div>
							<div className="my-3 border-t border-base-content/10" />
							<h4 className="mb-2 text-sm font-semibold">Downloads</h4>
							<div className="flex flex-col gap-2">
								{[
									{ platform: "Windows", file: "glass-garden-win.zip", size: "245 MB" },
									{ platform: "macOS", file: "glass-garden-mac.dmg", size: "260 MB" },
									{ platform: "Linux", file: "glass-garden-linux.tar.gz", size: "240 MB" },
								].map((dl) => (
									<div
										key={dl.platform}
										className="flex items-center justify-between rounded-lg bg-base-200 p-2 text-sm"
									>
										<div>
											<span className="font-medium">{dl.platform}</span>
											<span className="ml-2 text-base-content/40">{dl.file}</span>
										</div>
										<div className="flex items-center gap-3">
											<span className="text-base-content/50">{dl.size}</span>
											<span className="btn btn-primary btn-xs rounded-full">Download</span>
										</div>
									</div>
								))}
							</div>
							<div className="my-3 border-t border-base-content/10" />
							<h4 className="mb-2 text-sm font-semibold">Devlog</h4>
							<div className="flex flex-col gap-2 text-sm">
								<div className="rounded-lg bg-base-200 p-2">
									<span className="font-medium">v1.2: New biome types</span>
									<span className="ml-2 text-base-content/40">Jan 15</span>
								</div>
								<div className="rounded-lg bg-base-200 p-2">
									<span className="font-medium">Behind the procedural generation</span>
									<span className="ml-2 text-base-content/40">Dec 28</span>
								</div>
							</div>
						</div>
					</Card>
				</Reveal>
			</Section>

			{/* Data portability */}
			<Section>
				<Reveal>
					<Eyebrow>Ownership</Eyebrow>
					<H2>Your data is yours</H2>
					<Lede>
						Anthers is built on the AT Protocol—the same open standard behind Bluesky. Sign in with
						your Bluesky identity, or create a new one. Your content and audience relationships are
						portable by design.
					</Lede>
				</Reveal>
				<div className="mx-auto mt-14 grid max-w-4xl gap-8 text-left sm:grid-cols-3">
					<Reveal delay={0}>
						<ValueCard
							icon={<LockOpenIcon className="h-6 w-6" />}
							title="Portable identity"
							compact
						>
							Your creator identity isn't locked to Anthers. It's a DID—a decentralized identifier
							you own. If you ever leave, your identity goes with you.
						</ValueCard>
					</Reveal>
					<Reveal delay={110}>
						<ValueCard
							icon={<ArrowPathIcon className="h-6 w-6" />}
							title="Exportable content"
							compact
						>
							Your project pages, devlogs, ratings, and community interactions are stored as ATProto
							records. They belong to you structurally, not just by policy.
						</ValueCard>
					</Reveal>
					<Reveal delay={220}>
						<ValueCard icon={<GlobeAltIcon className="h-6 w-6" />} title="Federated future" compact>
							ATProto enables federation—other nodes can join the network, and content is
							interoperable across them. No single point of control.
						</ValueCard>
					</Reveal>
				</div>
			</Section>

			{/* Closing */}
			<section className="bg-base-200/70">
				<div className="mx-auto max-w-6xl px-6 py-28 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-6 h-14 w-14 text-primary/70" />
						<h2
							style={serif}
							className="text-balance text-4xl font-light leading-tight sm:text-5xl"
						>
							Ready to share your work?
						</h2>
						<p className="mx-auto mt-5 max-w-4xl text-lg leading-relaxed text-base-content/70">
							Anthers is free to use. No platform profit, no hidden fees. Just publish your work and
							keep what you earn.
						</p>
						<div className="mt-8 flex flex-wrap justify-center gap-3">
							<Link to={startHref} className="btn btn-primary rounded-full px-7">
								Create Your Account
							</Link>
							<Link
								to="/demo-creator-page"
								className="btn btn-outline rounded-full border-base-content/20 px-7"
							>
								See a Creator Page
							</Link>
						</div>
					</Reveal>
				</div>
			</section>
		</MeadowDecor>
	);
}

// ─── Local building blocks (page-specific; shared editorial primitives —
//     Section/Eyebrow/H2/Lede/Card — come from @anthers/web-shared/decor/sections) ───

// ─── "The solution" — the interactive economics matrix ───

type Deal = { name: string; creator: string; platform: string; platformNote?: string };
type Line = { label: string; amount: string };
type Combo = { scenario: string; rows: Deal[]; note?: string; breakdown: Line[] };

const ACTIONS = [
	{ key: "purchase", label: "Purchases your work" },
	{ key: "seed", label: "Plants Seeds for you" },
	{ key: "stream", label: "Streams your work" },
] as const;
type ActionKey = (typeof ACTIONS)[number]["key"];

const MEDIA = [
	{ key: "video", label: "Video", icon: <FilmIcon className="h-4 w-4" /> },
	{ key: "games", label: "Games", icon: <PuzzlePieceIcon className="h-4 w-4" /> },
	{ key: "music", label: "Music", icon: <MusicalNoteIcon className="h-4 w-4" /> },
	{ key: "writing", label: "Writing", icon: <DocumentTextIcon className="h-4 w-4" /> },
	{ key: "merch", label: "Merch", icon: <ShoppingBagIcon className="h-4 w-4" /> },
] as const;
type MediaKey = (typeof MEDIA)[number]["key"];

// Header intro for the per-combo Anthers mini-receipt (below the comparison).
const RECEIPT_INTRO: Record<ActionKey, string> = {
	purchase: "the price plus delivery",
	seed: "your $5 in Seeds",
	stream: "when a fan streams your public work",
};

const CS_NOTE = "community & charity";
const PASSTHROUGH = "pure passthrough";

// A representative engaged fan for the streaming comparison: a Sprout plan
// ($8/mo, $4 Time Pool) who streams ~30 hrs/month. The creator earns the fan's
// Time Pool ÷ their watch-hours per watch-hour — the SAME for every medium
// (equal-time), and independent of resolution (pay is by time, not bytes).
const STREAM_FAN_HOURS = 30;
const STREAM_HR_PAY = `~$${(BADGE_PLANS.sprout.timePool / STREAM_FAN_HOURS).toFixed(2)}`; // ≈ $0.13

/** The Anthers row for a combo. `platform` is the Community Share (a charitable
 * markup that funds free access + Foundation programs, never profit) — or $0 for
 * Seeds, a pure passthrough. It is NOT a platform profit cut. */
const anthers = (creator: string, platform: string, platformNote: string): Deal => ({
	name: "Anthers",
	creator,
	platform,
	platformNote,
});

// The itemized Anthers side, shown as a mini-receipt under each comparison. The
// closing line makes the honest point the comparison table can't: Anthers profit
// is always $0 — the Community Share is charity, and bandwidth is an at-cost
// passthrough. Streaming isn't where Anthers competes on pay; the Time Pool share
// is small and variable, and the real support comes from Seeds and sales.
const streamReceipt: Line[] = [
	{ label: "To you — a Sprout fan's Time Pool share, by watch-time", amount: STREAM_HR_PAY },
	{ label: "Community Share — free access & charity", amount: "~$0.01" },
	{ label: "Bandwidth — from the fan's wallet, at cost", amount: "~$0.02" },
	{ label: "Anthers profit", amount: "$0.00" },
];
const purchaseReceipt = (price: string, cs: string, bw: string): Line[] => [
	{ label: "To you — your price, in full", amount: price },
	{ label: "Community Share — free access & charity", amount: cs },
	{ label: "Bandwidth — delivery, at cost", amount: bw },
	{ label: "Anthers profit", amount: "$0.00" },
];
const merchReceipt: Line[] = [
	{ label: "To you — your price, in full", amount: "$25.00" },
	{ label: "Community Share — 1%, free access & charity", amount: "$0.25" },
	{ label: "Anthers profit", amount: "$0.00" },
];
const seedReceipt: Line[] = [
	{ label: "To you — every cent", amount: "$5.00" },
	{ label: "Community Share", amount: "$0.00" },
	{ label: "Anthers profit", amount: "$0.00" },
];

// [action][media] → the scenario + who-gets-what + the Anthers breakdown. Anthers
// first. Competitor figures are rough public estimates. `stream` has no `merch`
// entry on purpose — that combo is a joke (see SolutionExplorer).
const MATRIX: Record<ActionKey, Partial<Record<MediaKey, Combo>>> = {
	stream: {
		video: {
			scenario: "A fan watches an hour of your public 1080p video",
			rows: [
				anthers(STREAM_HR_PAY, "~$0.01", CS_NOTE),
				{ name: "YouTube (Ads)", creator: "~$0.03", platform: "~$0.03" },
				{ name: "YouTube (Premium)", creator: "~$0.20", platform: "~$0.16" },
			],
			note: "A Sprout fan (~$8/mo, ~30 hrs/month) pays a creator about $0.13 for an hour of watch-time — the same whether they watch 720p on mobile or 1080p on desktop, since pay is by time, not bytes (and it climbs with the fan's plan). Streaming still isn't where Anthers competes; your public page makes your work discoverable and available effectively at cost, with no ads. The real support comes from Seeds and sales.",
			breakdown: streamReceipt,
		},
		games: {
			scenario: "A fan plays an hour of your public browser game",
			rows: [
				anthers(STREAM_HR_PAY, "~$0.01", CS_NOTE),
				{ name: "Steam / itch.io", creator: "$0.00", platform: "$0.00" },
				{ name: "Xbox Game Pass", creator: "pennies", platform: "undisclosed" },
			],
			note: "Almost nowhere pays indie devs for play-time — Anthers pays the same ~$0.13/hr as any medium (a minute is a minute). Your public browser game is discoverable and served effectively at cost; Seeds and sales are where fans really pay you.",
			breakdown: streamReceipt,
		},
		music: {
			scenario: "A fan listens to an hour of your public tracks",
			rows: [
				anthers(STREAM_HR_PAY, "~$0.01", CS_NOTE),
				{ name: "Spotify", creator: "~$0.02", platform: "rest to labels & Spotify" },
				{ name: "Apple Music", creator: "~$0.04", platform: "skimmed" },
			],
			note: "Everywhere else pays fractions of a cent — Spotify ~$0.02/hr. Anthers pays by time, not format, so an hour of your tracks earns the same ~$0.13 as an hour of video: several times better, with no ads. Devoted fans still pay most through Seeds and album sales.",
			breakdown: streamReceipt,
		},
		writing: {
			scenario: "A fan reads your public writing for an hour",
			rows: [
				anthers(STREAM_HR_PAY, "~$0.01", CS_NOTE),
				{ name: "Medium", creator: "~$0.02", platform: "members only" },
				{ name: "Substack", creator: "$0.00", platform: "no per-read pay" },
			],
			note: "Most writing platforms don't pay per-read at all. Anthers pays by time like everything else — about $0.13 for an hour with your work — and your public writing stays free to discover, served at cost. Seeds and sales are the real support.",
			breakdown: streamReceipt,
		},
	},
	purchase: {
		video: {
			scenario: "A fan buys your $12 video",
			rows: [
				anthers("$12.00", "~$0.02", CS_NOTE),
				{ name: "Gumroad", creator: "$10.80", platform: "$1.20" },
				{ name: "Apple / iTunes", creator: "$8.40", platform: "$3.60" },
			],
			breakdown: purchaseReceipt("$12.00", "~$0.02", "~$0.03"),
		},
		games: {
			scenario: "A fan buys your $15 game",
			rows: [
				anthers("$15.00", "~$0.02", CS_NOTE),
				{ name: "itch.io", creator: "$13.50", platform: "$1.50" },
				{ name: "Steam", creator: "$10.50", platform: "$4.50" },
			],
			breakdown: purchaseReceipt("$15.00", "~$0.02", "~$0.03"),
		},
		music: {
			scenario: "A fan buys your $10 album",
			rows: [
				anthers("$10.00", "<$0.01", CS_NOTE),
				{ name: "Bandcamp", creator: "$8.50", platform: "$1.50" },
				{ name: "iTunes Store", creator: "$7.00", platform: "$3.00" },
			],
			breakdown: purchaseReceipt("$10.00", "<$0.01", "<$0.01"),
		},
		writing: {
			scenario: "A fan buys your $8 ebook",
			rows: [
				anthers("$8.00", "<$0.01", CS_NOTE),
				{ name: "Gumroad", creator: "$7.20", platform: "$0.80" },
				{ name: "Amazon KDP", creator: "$5.60", platform: "$2.40" },
			],
			breakdown: purchaseReceipt("$8.00", "<$0.01", "<$0.01"),
		},
		merch: {
			scenario: "A fan buys your $25 shirt",
			rows: [
				anthers("$25.00", "$0.25", CS_NOTE),
				{ name: "Etsy", creator: "$22.25", platform: "$2.75" },
				{ name: "Gumroad", creator: "$22.50", platform: "$2.50" },
			],
			note: "Excludes production & shipping—a real cost on any platform, including Anthers.",
			breakdown: merchReceipt,
		},
	},
	seed: {
		video: {
			scenario: "A fan plants $5 of Seeds a month",
			rows: [
				anthers("$5.00", "$0.00", PASSTHROUGH),
				{ name: "YouTube Memberships", creator: "$3.50", platform: "$1.50" },
				{ name: "Twitch (sub)", creator: "$2.50", platform: "$2.50" },
			],
			breakdown: seedReceipt,
		},
		games: {
			scenario: "A fan plants $5 of Seeds a month",
			rows: [
				anthers("$5.00", "$0.00", PASSTHROUGH),
				{ name: "Patreon", creator: "$4.35", platform: "$0.65" },
				{ name: "Ko-fi", creator: "$4.75", platform: "$0.25" },
			],
			breakdown: seedReceipt,
		},
		music: {
			scenario: "A fan plants $5 of Seeds a month",
			rows: [
				anthers("$5.00", "$0.00", PASSTHROUGH),
				{ name: "Patreon", creator: "$4.35", platform: "$0.65" },
				{ name: "Bandcamp (subscription)", creator: "$4.25", platform: "$0.75" },
			],
			breakdown: seedReceipt,
		},
		writing: {
			scenario: "A fan plants $5 of Seeds a month",
			rows: [
				anthers("$5.00", "$0.00", PASSTHROUGH),
				{ name: "Substack", creator: "$4.50", platform: "$0.50" },
				{ name: "Patreon", creator: "$4.35", platform: "$0.65" },
			],
			breakdown: seedReceipt,
		},
		merch: {
			scenario: "A fan plants $5 of Seeds a month",
			rows: [
				anthers("$5.00", "$0.00", PASSTHROUGH),
				{ name: "Patreon", creator: "$4.35", platform: "$0.65" },
				{ name: "Buy Me a Coffee", creator: "$4.75", platform: "$0.25" },
			],
			note: "Seeds support the creator directly—whatever they make. Each $1 is 100% yours.",
			breakdown: seedReceipt,
		},
	},
};

/** The interactive heart of "the solution": pick how a fan supports you (purchase /
 * Seed / stream) and the medium, and see exactly what reaches the creator vs.
 * the platform on Anthers and elsewhere. Leads with purchase — the categorical 0%-cut
 * win. Scenario assumptions are stated in-card; figures are estimates and Anthers's
 * profit is $0 on every one. */
function SolutionExplorer() {
	const [action, setAction] = useState<ActionKey>("purchase");
	const [media, setMedia] = useState<MediaKey>("video");
	const combo = MATRIX[action][media];

	return (
		<Card className="mx-auto max-w-3xl text-left">
			<p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-base-content/45">
				When a user…
			</p>
			{/* How the fan supports you — completes "When a user…" */}
			<div className="flex flex-wrap gap-2">
				{ACTIONS.map((a) => (
					<button
						key={a.key}
						type="button"
						onClick={() => setAction(a.key)}
						className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
							a.key === action
								? "bg-primary font-medium text-primary-content"
								: "bg-base-200 text-base-content/65 hover:bg-base-300"
						}`}
					>
						{a.label}
					</button>
				))}
			</div>
			{/* …and what kind of work it is */}
			<div className="mt-3 flex flex-wrap gap-1.5">
				{MEDIA.map((m) => (
					<button
						key={m.key}
						type="button"
						onClick={() => setMedia(m.key)}
						className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-sm transition-colors ${
							m.key === media
								? "bg-primary/15 font-medium text-primary"
								: "text-base-content/55 hover:bg-base-content/5"
						}`}
					>
						{m.icon}
						{m.label}
					</button>
				))}
			</div>

			<div className="mt-6">
				{combo ? (
					<>
						<p className="mb-4 text-sm text-base-content/60">
							<span className="font-medium text-base-content/85">{combo.scenario}.</span> Here's
							where the money goes:
						</p>
						<div className="overflow-x-auto">
							<table className="table">
								<thead>
									<tr className="border-base-content/10">
										<th style={serif} className="font-medium">
											Platform
										</th>
										<th style={serif} className="text-right font-medium">
											to the Creator
										</th>
										<th style={serif} className="text-right font-medium">
											to the Platform
										</th>
									</tr>
								</thead>
								<tbody>
									{combo.rows.map((r) => {
										const isAnthers = r.name === "Anthers";
										return (
											<tr
												key={r.name}
												className={`border-base-content/10 ${isAnthers ? "bg-primary/10 font-semibold" : ""}`}
											>
												<td>{r.name}</td>
												<td
													className={`text-right ${isAnthers ? "text-primary" : "text-base-content/70"}`}
												>
													{r.creator}
												</td>
												<td className={`text-right ${isAnthers ? "" : "text-error"}`}>
													<span className={isAnthers ? "text-base-content/70" : ""}>
														{r.platform}
													</span>
													{r.platformNote && (
														<span className="block text-xs font-normal text-base-content/45">
															{r.platformNote}
														</span>
													)}
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
						{combo.note && <p className="mt-3 text-sm text-base-content/55">{combo.note}</p>}
						{/* The honest Anthers breakdown — the comparison's "to the Platform" is the
							Community Share (charity), not profit; this itemizes where the rest goes and
							lands on the line the table can't show: Anthers profit is always $0. */}
						<div className="mt-4 rounded-2xl border border-base-content/10 bg-base-200/40 p-4">
							<p className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-primary/70">
								On Anthers, {RECEIPT_INTRO[action]} — Anthers profit is $0
							</p>
							<dl className="flex flex-col gap-1.5 text-sm">
								{combo.breakdown.map((line) => {
									const isProfit = line.label === "Anthers profit";
									return (
										<div
											key={line.label}
											className={`flex items-baseline justify-between gap-3 ${
												isProfit ? "mt-1 border-t border-base-content/10 pt-2 font-medium" : ""
											}`}
										>
											<span className={isProfit ? "text-base-content/80" : "text-base-content/60"}>
												{line.label}
											</span>
											<span
												className={`shrink-0 font-mono tabular-nums ${
													isProfit ? "text-primary" : "text-base-content/70"
												}`}
											>
												{line.amount}
											</span>
										</div>
									);
								})}
							</dl>
						</div>
					</>
				) : (
					/* Easter egg: you can't stream merch. */
					<div className="flex flex-col items-center gap-2 rounded-2xl bg-base-200/60 px-6 py-12 text-center">
						<span className="text-3xl">👕</span>
						<p style={serif} className="text-lg font-medium">
							Hey — you wouldn't download a shirt.
						</p>
						<p className="max-w-sm text-sm text-base-content/55">
							You can't stream merch. Try{" "}
							<button
								type="button"
								onClick={() => setAction("purchase")}
								className="not-italic text-primary underline decoration-primary/40"
							>
								Purchases
							</button>
							, or pick another medium.
						</p>
					</div>
				)}
			</div>

			<p className="mt-5 border-t border-base-content/10 pt-3 text-xs text-base-content/45">
				Anthers never profits: beyond your share and delivery at cost, the only markup is the
				Community Share—a small charitable fee that funds free access for everyone and Anthers
				Foundation programs (Seeds are a pure passthrough). Scenario figures are illustrative;
				competitor rates are rough public estimates.
			</p>
		</Card>
	);
}

/** An icon + heading + body card (the data-portability trio). */
function ValueCard({
	icon,
	title,
	compact,
	children,
}: {
	icon: React.ReactNode;
	title: string;
	compact?: boolean;
	children: React.ReactNode;
}) {
	return (
		<div
			className={
				compact ? "" : "h-full rounded-3xl border border-base-content/10 bg-base-100 p-7 shadow-sm"
			}
		>
			<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
				{icon}
			</div>
			<h3 style={serif} className="mb-2 text-lg font-medium">
				{title}
			</h3>
			<p className="text-sm leading-relaxed text-base-content/70">{children}</p>
		</div>
	);
}

/** A medium card in the "every kind of creative work" grid. */
function MediaCard({
	icon,
	title,
	description,
	features,
}: {
	icon: React.ReactNode;
	title: string;
	description: string;
	features: string[];
}) {
	return (
		<Card className="card-lift h-full">
			<div className="mb-3 flex items-center gap-2 text-primary">
				{icon}
				<span style={serif} className="text-lg font-medium text-base-content">
					{title}
				</span>
			</div>
			<p className="mb-3 text-sm leading-relaxed text-base-content/65">{description}</p>
			<ul className="flex flex-col gap-1 text-xs text-base-content/55">
				{features.map((f) => (
					<li key={f} className="flex items-center gap-1.5">
						<span className="text-primary">✓</span> {f}
					</li>
				))}
			</ul>
		</Card>
	);
}

/** A ✓-icon point beside the pricing receipt. */
function PricePoint({
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
			<div className="mt-0.5 shrink-0 text-primary">{icon}</div>
			<div>
				<h4 className="text-sm font-semibold">{title}</h4>
				<p className="text-sm text-base-content/60">{children}</p>
			</div>
		</div>
	);
}

/** A label + amount line in the example receipt. */
function ReceiptLine({ label, amount, bold }: { label: string; amount: string; bold?: boolean }) {
	return (
		<div className={`flex justify-between ${bold ? "font-semibold" : "text-base-content/70"}`}>
			<span>{label}</span>
			<span className="font-mono tabular-nums">{amount}</span>
		</div>
	);
}

/** A pricing-model card (Free / PWYW / Fixed). */
function PricingOption({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<Card className="text-center card-lift h-full">
			<span
				style={serif}
				className="mb-2 inline-block rounded-full bg-primary/10 px-4 py-1 text-sm font-medium text-primary"
			>
				{title}
			</span>
			<p className="text-sm text-base-content/65">{children}</p>
		</Card>
	);
}

/** A feature in the "everything you need" grid. */
function Feature({
	icon,
	title,
	description,
}: {
	icon: React.ReactNode;
	title: string;
	description: string;
}) {
	return (
		<div className="flex gap-4">
			<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
				{icon}
			</div>
			<div>
				<h3 style={serif} className="mb-1 text-base font-medium">
					{title}
				</h3>
				<p className="text-sm leading-relaxed text-base-content/65">{description}</p>
			</div>
		</div>
	);
}
