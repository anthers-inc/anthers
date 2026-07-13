// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The For Creators marketing page — restyled into the Meadow design (matching
// /for-users). Airy editorial forest-green, Fraunces display serif over Nunito
// Sans, wrapped in the shared <MeadowDecor> (pollen + woven side vines); the
// shared LoggedOutLayout supplies the Meadow footer + grassy floor. Copy is the
// existing V3-accurate marketing content, reflowed into the Meadow section
// vocabulary. Every Anthers economics figure stays V3-accurate; competitor cuts
// in "The problem" are the other platforms' standard published rates (illustrative).
//
// Section flow is a deliberate call-and-response: "The problem" (everyone else
// takes a cut, on purchases AND subscriptions) is immediately answered by
// "Transparent by design" (Anthers takes none).

import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { MeadowDecor } from "@anthers/web-shared/decor/MeadowDecor";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Card, Eyebrow, H2, Lede, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import {
	ArrowDownTrayIcon,
	ArrowPathIcon,
	ChartBarIcon,
	ChatBubbleLeftRightIcon,
	DocumentTextIcon,
	EyeIcon,
	FilmIcon,
	GlobeAltIcon,
	LockOpenIcon,
	MusicalNoteIcon,
	PaintBrushIcon,
	PuzzlePieceIcon,
	ServerStackIcon,
	ShieldCheckIcon,
	StarIcon,
	TrophyIcon,
	UserGroupIcon,
} from "@heroicons/react/24/outline";
import { useState } from "react";
import { Link } from "react-router-dom";

const serif = { fontFamily: FONTS.fraunces };

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
							Games, videos, music, and writing—all under one roof, one identity, one audience. No
							platform cut. No hidden fees. Transparent costs you can see and verify.
						</p>
					</Reveal>
					<Reveal delay={300}>
						<div className="mt-9 flex flex-wrap justify-center gap-3">
							<Link to={startHref} className="btn btn-primary rounded-full px-8">
								Start Creating
							</Link>
							<Link
								to="/demo-creator-page"
								className="btn btn-outline rounded-full border-base-content/20 px-7"
							>
								See What Others Built
							</Link>
						</div>
						<BrandGlyph name="divider-botanical" className="mt-10 h-14 w-52 text-primary/45" />
					</Reveal>
				</div>
			</header>

			{/* The problem — how everyone else takes a cut, on purchases AND subscriptions */}
			<Section>
				<Reveal>
					<Eyebrow>The problem</Eyebrow>
					<H2>Creators deserve better</H2>
					<Lede>
						Existing platforms take 10–30% of your revenue, own your data, and fragment your
						audience across multiple services. Whether someone buys your work outright or supports
						you month to month, a middleman takes a cut of it.
					</Lede>
				</Reveal>
				<div className="mx-auto mt-12 flex max-w-2xl flex-col gap-6">
					<Reveal>
						<PurchaseComparison />
					</Reveal>
					<Reveal delay={110}>
						<SubscriptionComparison />
					</Reveal>
				</div>
				<Reveal>
					<p className="mx-auto mt-5 max-w-xl text-sm text-base-content/45">
						On Anthers, real costs (payment processing, infrastructure) are shown as transparent
						line items—never a percentage cut. Competitor rates above are those platforms' standard
						published cuts.
					</p>
				</Reveal>
			</Section>

			{/* Transparent pricing — the response to "the problem" above */}
			<Section tint>
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
								<ReceiptLine label="Anthers Foundation Fee (50% of bandwidth)" amount="$0.01" />
								<ReceiptLine label="Payment processing (2.9% + $0.30)" amount="$0.59" />
								<div className="my-1 border-t border-base-content/10" />
								<ReceiptLine label="You pay" amount="$10.62" bold />
							</div>
							<p className="mt-3 text-xs text-base-content/45">
								Creator receives $10.00—every time. Anthers keeps $0.00.
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
							<PricePoint icon={<ServerStackIcon className="h-5 w-5" />} title="Anthers Foundation">
								The Foundation fee rides on the infrastructure a transaction actually uses—50% of
								the bandwidth a download or stream needs, plus 50% of creator storage. It funds free
								access, charitable programs, and lean operations. It's a community investment, not a
								platform tax—Anthers itself keeps nothing.
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
			<Section>
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

			{/* Subscription tiers */}
			<Section>
				<Reveal>
					<Eyebrow>How users pay you</Eyebrow>
					<H2>Users fund creators, not platforms</H2>
					<Lede>
						Users make two independent, prepaid choices—Usage (open, per-GiB access) and Boost ($1
						units sent straight to specific creators)—and earn a rolling Anthers Badge from their
						combined spend. Every dollar is bandwidth at cost, money to creators, or the Anthers
						Foundation fee. Anthers keeps $0.
					</Lede>
				</Reveal>
				<Reveal className="mx-auto mt-12 block max-w-3xl">
					<Card className="overflow-x-auto">
						<table className="table">
							<thead>
								<tr className="border-base-content/10">
									{["Badge", "Usage", "Boost", "Combined spend", "To creators"].map((h, i) => (
										<th
											key={h}
											style={serif}
											className={`font-medium ${i === 0 ? "" : "text-right"}`}
										>
											{h}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								<tr className="border-base-content/10 text-base-content/45">
									<td>Free</td>
									<td className="text-right">First 3 GiB free</td>
									<td className="text-right">—</td>
									<td className="text-right">&lt; $3</td>
									<td className="text-right">—</td>
								</tr>
								{[
									["🫚 Root", "100 GiB", "$0", "$3", "$1.50"],
									["🌱 Sprout", "200 GiB", "$1", "$7", "$4.00"],
									["🌷 Petal", "300 GiB", "$6", "$15", "$10.50"],
									["🌼 Blossom", "400 GiB", "$18", "$30", "$24.00"],
								].map(([badge, usage, boost, spend, creators]) => (
									<tr key={badge} className="border-base-content/10">
										<td className="font-medium">{badge}</td>
										<td className="text-right text-base-content/70">{usage}</td>
										<td className="text-right text-base-content/70">{boost}</td>
										<td className="text-right text-base-content/70">{spend}</td>
										<td className="text-right font-medium text-primary">{creators}</td>
									</tr>
								))}
							</tbody>
						</table>
					</Card>
				</Reveal>
				<Reveal>
					<p className="mx-auto mt-5 max-w-2xl text-xs leading-relaxed text-base-content/45">
						You're never locked into a tier. Usage is sold in 100 GiB / $3.00 packs (first 3 GiB
						free); each Usage dollar splits into bandwidth at cost ($0.01/GiB), the Anthers
						Foundation fee ($0.005/GiB), and the Time Pool ($0.015/GiB) that pays creators by
						watch-time. Boost is bought in $1 units that go 100% to the creators you choose. Your
						combined Usage + Boost spend sets your rolling Anthers Badge—Root at $3, Sprout at $7,
						Petal at $15, Blossom at $30. Anthers keeps $0. Coming soon.
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
							Anthers is free to use. No platform cut, no hidden fees. Just publish your work and
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

// ─── "The problem" comparisons ───

/** Per-medium one-time-purchase economics — what the creator keeps and what the
 * platform takes on a $10 sale. Competitor figures are their standard published
 * cuts (approximate, illustrative); Anthers takes $0 on every one. */
const PURCHASE_TABS = [
	{
		key: "games",
		label: "Games",
		icon: <PuzzlePieceIcon className="h-4 w-4" />,
		rows: [
			["itch.io", "$9.00", "$1.00 (10%)"],
			["Epic Games Store", "$8.80", "$1.20 (12%)"],
			["Steam", "$7.00", "$3.00 (30%)"],
		],
	},
	{
		key: "music",
		label: "Music",
		icon: <MusicalNoteIcon className="h-4 w-4" />,
		rows: [
			["Gumroad", "$9.00", "$1.00 (10%)"],
			["Bandcamp", "$8.50", "$1.50 (15%)"],
			["iTunes Store", "$7.00", "$3.00 (30%)"],
		],
	},
	{
		key: "video",
		label: "Video",
		icon: <FilmIcon className="h-4 w-4" />,
		rows: [
			["Gumroad", "$9.00", "$1.00 (10%)"],
			["Vimeo", "$9.00", "$1.00 (10%)"],
			["YouTube", "$7.00", "$3.00 (30%)"],
		],
	},
	{
		key: "writing",
		label: "Writing",
		icon: <DocumentTextIcon className="h-4 w-4" />,
		rows: [
			["Gumroad", "$9.00", "$1.00 (10%)"],
			["Leanpub", "$8.00", "$2.00 (20%)"],
			["Amazon KDP", "$7.00", "$3.00 (30%)"],
		],
	},
] as const;

/** The one-time-purchase comparison, with a tab per medium. */
function PurchaseComparison() {
	const [tab, setTab] = useState<(typeof PURCHASE_TABS)[number]["key"]>("games");
	const active = PURCHASE_TABS.find((t) => t.key === tab) ?? PURCHASE_TABS[0];
	return (
		<Card className="h-full text-left">
			<p className="text-xs font-semibold uppercase tracking-wider text-primary/80">
				When someone buys your work
			</p>
			<h3 style={serif} className="mb-4 text-xl font-medium">
				One-time purchases
			</h3>
			<div className="mb-4 flex flex-wrap gap-1.5">
				{PURCHASE_TABS.map((t) => (
					<button
						key={t.key}
						type="button"
						onClick={() => setTab(t.key)}
						className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-sm transition-colors ${
							t.key === tab
								? "bg-primary/15 font-medium text-primary"
								: "text-base-content/55 hover:bg-base-content/5"
						}`}
					>
						{t.icon}
						{t.label}
					</button>
				))}
			</div>
			<div className="overflow-x-auto">
				<table className="table">
					<thead>
						<tr className="border-base-content/10">
							<th style={serif} className="font-medium">
								Platform
							</th>
							<th style={serif} className="text-right font-medium">
								Creator keeps on $10
							</th>
							<th style={serif} className="text-right font-medium">
								Platform takes
							</th>
						</tr>
					</thead>
					<tbody>
						<tr className="border-base-content/10 bg-primary/10 font-semibold">
							<td>Anthers</td>
							<td className="text-right text-primary">$10.00 (100%)</td>
							<td className="text-right">$0.00</td>
						</tr>
						{active.rows.map(([name, keeps, takes]) => (
							<tr key={name} className="border-base-content/10">
								<td>{name}</td>
								<td className="text-right text-base-content/70">{keeps}</td>
								<td className="text-right text-error">{takes}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</Card>
	);
}

/** Recurring-support cut across the popular streaming / membership platforms. */
const SUBSCRIPTION_ROWS = [
	["Patreon", "8–12%", "Most of it, minus fees"],
	["Substack", "10%", "Most of it, minus fees"],
	["YouTube", "30–45%", "A slice of ads & memberships"],
	["Twitch", "~50%", "Half of every subscription"],
	["Spotify", "~30%", "Fractions of a cent per stream"],
] as const;

/** The recurring-support comparison — where fan money goes on the streaming and
 * membership platforms vs. Anthers (where it goes straight to creators). */
function SubscriptionComparison() {
	return (
		<Card className="h-full text-left">
			<p className="text-xs font-semibold uppercase tracking-wider text-accent">
				When fans support you every month
			</p>
			<h3 style={serif} className="mb-4 text-xl font-medium">
				Subscriptions &amp; streaming
			</h3>
			<div className="overflow-x-auto">
				<table className="table">
					<thead>
						<tr className="border-base-content/10">
							<th style={serif} className="font-medium">
								Platform
							</th>
							<th style={serif} className="text-right font-medium">
								Platform's cut
							</th>
							<th style={serif} className="font-medium">
								What reaches you
							</th>
						</tr>
					</thead>
					<tbody>
						<tr className="border-base-content/10 bg-primary/10 font-semibold">
							<td>Anthers</td>
							<td className="text-right text-primary">0%</td>
							<td>100%, to the creators you support</td>
						</tr>
						{SUBSCRIPTION_ROWS.map(([name, cut, reaches]) => (
							<tr key={name} className="border-base-content/10">
								<td>{name}</td>
								<td className="text-right text-error">{cut}</td>
								<td className="text-base-content/60">{reaches}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
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
