// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The For Creators marketing page — restyled into the Meadow design (matching
// /for-users). Airy editorial forest-green, Fraunces display serif over Nunito
// Sans, wrapped in the shared <MeadowDecor> (pollen + woven side vines); the
// shared LoggedOutLayout supplies the Meadow footer + grassy floor. Copy is the
// existing V3-accurate marketing content, reflowed into the Meadow section
// vocabulary. Every economics figure stays V3-accurate.

import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { MeadowDecor } from "@anthers/web-shared/decor/MeadowDecor";
import { FONTS } from "@anthers/web-shared/fonts";
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
import { Link } from "react-router-dom";

const serif = { fontFamily: FONTS.fraunces };

export default function ForCreatorsPage() {
	const { isAuthenticated } = useAuth();
	const startHref = isAuthenticated ? "/dashboard" : "/signup";

	return (
		<MeadowDecor vine="triple" floor={false} style={{ fontFamily: FONTS.nunito }}>
			{/* Hero */}
			<header className="bg-base-200/70">
				<div className="mx-auto max-w-5xl px-6 pt-24 pb-20 text-center">
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
					<p className="mx-auto mt-8 max-w-2xl text-lg leading-relaxed text-base-content/75">
						Games, videos, music, and writing—all under one roof, one identity, one audience. No
						platform cut. No hidden fees. Transparent costs you can see and verify.
					</p>
					<div className="mt-9 flex flex-wrap justify-center gap-3">
						<Link to={startHref} className="btn btn-primary rounded-full px-8">
							Start Creating
						</Link>
						<Link
							to="/discover"
							className="btn btn-outline rounded-full border-base-content/20 px-7"
						>
							See What Others Built
						</Link>
					</div>
					<BrandGlyph name="divider-botanical" className="mt-10 h-14 w-52 text-primary/45" />
				</div>
			</header>

			{/* Revenue comparison */}
			<Section>
				<Eyebrow>The problem</Eyebrow>
				<H2>Creators deserve better</H2>
				<Lede>
					Existing platforms take 10–30% of your revenue, own your data, and fragment your audience
					across multiple services. You need a separate account for every medium, a separate
					audience for every platform.
				</Lede>
				<Card className="mx-auto mt-12 max-w-2xl overflow-x-auto">
					<table className="table">
						<thead>
							<tr className="border-base-content/10">
								<th style={serif} className="font-medium">
									Platform
								</th>
								<th style={serif} className="text-right font-medium">
									Creator keeps on $10 sale
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
							{[
								["itch.io", "$9.00", "$1.00 (10%)"],
								["Epic Games Store", "$8.80", "$1.20 (12%)"],
								["Patreon", "$9.20", "$0.80 (8%)"],
								["Steam", "$7.00", "$3.00 (30%)"],
							].map(([name, keeps, takes]) => (
								<tr key={name} className="border-base-content/10">
									<td>{name}</td>
									<td className="text-right text-base-content/70">{keeps}</td>
									<td className="text-right text-error">{takes}</td>
								</tr>
							))}
						</tbody>
					</table>
				</Card>
				<p className="mx-auto mt-5 max-w-xl text-sm text-base-content/45">
					On Anthers, real costs (payment processing, infrastructure) are shown as transparent line
					items—never a percentage cut.
				</p>
			</Section>

			{/* Core value props */}
			<Section tint>
				<Eyebrow>Why Anthers</Eyebrow>
				<H2>How Anthers works for creators</H2>
				<div className="mt-14 grid gap-8 text-left sm:grid-cols-3">
					<ValueCard icon={<CurrencyDollarIcon className="h-7 w-7" />} title="100% to Creators">
						You set a price, you receive that price. Processing fees and infrastructure costs are
						passed through transparently as itemized line items the buyer sees at checkout—never
						hidden, never a percentage cut from your earnings.
					</ValueCard>
					<ValueCard icon={<GlobeAltIcon className="h-7 w-7" />} title="One Home for Everything">
						Games, videos, music, writing—all under one roof, one identity, one audience. A game
						developer who writes devlogs and composes music shouldn't need three separate platforms.
						Followers subscribe to <em className="not-italic text-base-content/85">you</em>, not a
						medium.
					</ValueCard>
					<ValueCard icon={<UserGroupIcon className="h-7 w-7" />} title="Community Built In">
						Follows, devlogs, comments, ratings, game jams—everything you need to build and engage
						your audience lives on the same platform where your work lives. No more scattering your
						community across Discord, Patreon, and Twitter.
					</ValueCard>
				</div>
			</Section>

			{/* Multi-media showcase */}
			<Section>
				<Eyebrow>Every medium</Eyebrow>
				<H2>Every kind of creative work</H2>
				<Lede>
					Anthers isn't just for games. Publish anything you create—the platform adapts to the
					medium while keeping the same tools, the same audience, and the same economics.
				</Lede>
				<div className="mt-14 grid gap-6 text-left sm:grid-cols-2 lg:grid-cols-4">
					<MediaCard
						icon={<PuzzlePieceIcon className="h-8 w-8" />}
						title="Games"
						description="Upload builds for Windows, Mac, Linux. Host HTML5 games playable in the browser. Manage versions, platforms, and pricing."
						features={["Multi-platform downloads", "Web game embedding", "Game jam support"]}
					/>
					<MediaCard
						icon={<FilmIcon className="h-8 w-8" />}
						title="Video"
						description="Publish video content alongside your other work. Your devlog videos and your games live in the same place, for the same audience."
						features={["Native hosting", "Devlog series", "Creator portfolio"]}
					/>
					<MediaCard
						icon={<MusicalNoteIcon className="h-8 w-8" />}
						title="Audio"
						description="Share music, soundtracks, podcasts. A game composer can publish their soundtrack right alongside the game it belongs to."
						features={["Album & track hosting", "Soundtrack bundling", "Streaming playback"]}
					/>
					<MediaCard
						icon={<DocumentTextIcon className="h-8 w-8" />}
						title="Writing"
						description="Essays, tutorials, fiction, devlogs. First-class publishing for written content with your full creator profile and audience behind it."
						features={["Rich text posts", "Devlog journals", "Standalone essays"]}
					/>
				</div>
			</Section>

			{/* Transparent pricing */}
			<Section tint>
				<Eyebrow>Transparent by design</Eyebrow>
				<H2>Transparent pricing, not platform rent</H2>
				<Lede>
					At checkout, buyers see exactly where every penny goes. No hidden fees, no opaque "revenue
					share." Real infrastructure costs are passed through—and they're tiny.
				</Lede>
				<div className="mx-auto mt-12 grid max-w-4xl gap-6 text-left md:grid-cols-2">
					<Card>
						<h3 style={serif} className="mb-4 text-lg font-medium">
							Example: $10 game, 2 GiB download (card payment)
						</h3>
						<div className="flex flex-col gap-2 text-sm">
							<ReceiptLine label="Game price (to creator)" amount="$10.00" bold />
							<ReceiptLine label="Download bandwidth (2 GiB @ $0.01/GiB, at cost)" amount="$0.02" />
							<ReceiptLine label="Anthers Foundation Fee (50% of bandwidth)" amount="$0.01" />
							<ReceiptLine label="Payment processing (2.9% + $0.30)" amount="$0.59" />
							<div className="my-1 border-t border-base-content/10" />
							<ReceiptLine label="You pay" amount="$10.62" bold />
						</div>
						<p className="mt-3 text-xs text-base-content/45">
							Creator receives $10.00—every time. Anthers keeps $0.00.
						</p>
					</Card>
					<div className="flex flex-col justify-center gap-6">
						<PricePoint icon={<ShieldCheckIcon className="h-5 w-5" />} title="No percentage cut">
							The creator's price is the creator's revenue. Full stop.
						</PricePoint>
						<PricePoint icon={<EyeIcon className="h-5 w-5" />} title="Full visibility">
							Every fee is itemized and explained. Buyers understand what they're paying for.
							Creators understand what they're earning.
						</PricePoint>
						<PricePoint icon={<ServerStackIcon className="h-5 w-5" />} title="Anthers Foundation">
							The Foundation fee rides on the infrastructure a transaction actually uses—50% of the
							bandwidth a download or stream needs, plus 50% of creator storage. It funds free
							access, charitable programs, and lean operations. It's a community investment, not a
							platform tax—Anthers itself keeps nothing.
						</PricePoint>
					</div>
				</div>
				<div className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-3">
					<PricingOption title="Free">
						No charge—anyone can download or play in the browser within their free allowance. Great
						for jam entries, demos, and open-source projects.
					</PricingOption>
					<PricingOption title="Pay What You Want">
						Set a suggested price and an optional minimum. Let your audience decide what your work
						is worth to them.
					</PricingOption>
					<PricingOption title="Fixed Price">
						Set your price and receive 100% of it. Transparent fees are added on top for the
						buyer—never taken from your cut.
					</PricingOption>
				</div>
			</Section>

			{/* Feature showcase */}
			<Section>
				<Eyebrow>The toolkit</Eyebrow>
				<H2>Everything you need to publish and grow</H2>
				<div className="mx-auto mt-14 grid max-w-5xl gap-x-12 gap-y-10 text-left md:grid-cols-2">
					<Feature
						icon={<PaintBrushIcon className="h-6 w-6" />}
						title="Rich project pages"
						description="Cover images, screenshots, detailed descriptions, and download links. Each project gets a dedicated page that adapts to its media type—platform-grouped downloads for games, embedded players for audio and video."
					/>
					<Feature
						icon={<ArrowDownTrayIcon className="h-6 w-6" />}
						title="Build management"
						description="Upload builds for multiple platforms. Label versions as stable, beta, or prerelease. Your audience downloads from organized, clearly labeled files—not a confusing pile of .zips."
					/>
					<Feature
						icon={<ChatBubbleLeftRightIcon className="h-6 w-6" />}
						title="Devlogs and posts"
						description="Write updates, announcements, and essays. Link posts to specific projects as devlogs, or publish standalone. Your audience follows your work in a unified feed—like Patreon, but alongside your actual projects."
					/>
					<Feature
						icon={<StarIcon className="h-6 w-6" />}
						title="Ratings and comments"
						description="Community feedback built into every project page. Ratings help the best work surface. Comments create conversation around your creations."
					/>
					<Feature
						icon={<TrophyIcon className="h-6 w-6" />}
						title="Game jams"
						description="Host and participate in game jams with timed submission periods, theme reveals, community voting, and ranked results. Jams are how communities form and creators get discovered."
					/>
					<Feature
						icon={<ChartBarIcon className="h-6 w-6" />}
						title="Creator dashboard"
						description="See your projects, posts, follower count, and content at a glance. Manage drafts and published work from one place. Create and edit projects with rich forms, upload builds, and manage screenshots."
					/>
					<Feature
						icon={<UserGroupIcon className="h-6 w-6" />}
						title="Creator profiles"
						description="Your own anther on Anthers—header image, bio, links, and all your work in one place. Audiences follow you, not individual projects. Like a Patreon page and an itch.io profile combined."
					/>
					<Feature
						icon={<ArrowPathIcon className="h-6 w-6" />}
						title="Follow and feed"
						description="Follow creators you care about and get their updates in a personalized feed. New project? Devlog post? Game jam entry? It all shows up in one timeline."
					/>
				</div>
			</Section>

			{/* Audience building */}
			<Section tint>
				<Eyebrow>Your audience</Eyebrow>
				<H2>Build your audience in one place</H2>
				<Lede>
					Like Patreon and YouTube Memberships, but alongside your actual work. Post devlogs, vlogs,
					podcasts, and blogs—all under the same profile your games live on. Your audience follows{" "}
					<em className="not-italic text-base-content/80">you</em>, not a platform.
				</Lede>
				<div className="mx-auto mt-12 grid max-w-4xl gap-6 text-left md:grid-cols-2">
					<Card>
						<h3 style={serif} className="mb-2 text-lg font-medium">
							Native content creation
						</h3>
						<p className="text-sm leading-relaxed text-base-content/70">
							Write devlogs, upload video updates, share podcast episodes — all natively hosted. No
							linking out to YouTube or Substack. Your content lives where your audience already is.
						</p>
					</Card>
					<Card>
						<h3 style={serif} className="mb-2 text-lg font-medium">
							Cross-publishing <span className="text-xs text-base-content/45">(coming soon)</span>
						</h3>
						<p className="text-sm leading-relaxed text-base-content/70">
							Publish once, distribute everywhere. Push videos to YouTube, builds to Steam and
							itch.io, posts to Substack—all from your Anthers dashboard. Unified analytics show
							performance across all platforms.
						</p>
					</Card>
				</div>
			</Section>

			{/* Subscription tiers */}
			<Section>
				<Eyebrow>How users pay you</Eyebrow>
				<H2>Users fund creators, not platforms</H2>
				<Lede>
					Users make two independent, prepaid choices—Usage (open, per-GiB access) and Boost ($1
					units sent straight to specific creators)—and earn a rolling Anthers Badge from their
					combined spend. Every dollar is bandwidth at cost, money to creators, or the Anthers
					Foundation fee. Anthers keeps $0.
				</Lede>
				<Card className="mx-auto mt-12 max-w-3xl overflow-x-auto">
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
				<p className="mx-auto mt-5 max-w-2xl text-xs leading-relaxed text-base-content/45">
					You're never locked into a tier. Usage is sold in 100 GiB / $3.00 packs (first 3 GiB
					free); each Usage dollar splits into bandwidth at cost ($0.01/GiB), the Anthers Foundation
					fee ($0.005/GiB), and the Time Pool ($0.015/GiB) that pays creators by watch-time. Boost
					is bought in $1 units that go 100% to the creators you choose. Your combined Usage + Boost
					spend sets your rolling Anthers Badge—Root at $3, Sprout at $7, Petal at $15, Blossom at
					$30. Anthers keeps $0. Coming soon.
				</p>
			</Section>

			{/* Creator profile preview */}
			<Section tint>
				<Eyebrow>Your identity</Eyebrow>
				<H2>Your home on the internet</H2>
				<Lede>
					Every creator gets a profile page that brings together everything they do. Games, devlogs,
					music, writing—one identity, one audience, one URL to share.
				</Lede>
				<Card className="mx-auto mt-12 max-w-2xl overflow-hidden !p-0 text-left">
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
			</Section>

			{/* Project page preview */}
			<Section>
				<Eyebrow>Your work</Eyebrow>
				<H2>Project pages that do the work</H2>
				<Lede>
					Every project gets a full-featured page with everything your audience needs—adapted to the
					type of work you're sharing.
				</Lede>
				<Card className="mx-auto mt-12 max-w-2xl overflow-hidden !p-0 text-left">
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
			</Section>

			{/* Data portability */}
			<Section tint>
				<Eyebrow>Ownership</Eyebrow>
				<H2>Your data is yours</H2>
				<Lede>
					Anthers is built on the AT Protocol—the same open standard behind Bluesky. Sign in with
					your Bluesky identity, or create a new one. Your content and audience relationships are
					portable by design.
				</Lede>
				<div className="mx-auto mt-14 grid max-w-4xl gap-8 text-left sm:grid-cols-3">
					<ValueCard icon={<LockOpenIcon className="h-6 w-6" />} title="Portable identity" compact>
						Your creator identity isn't locked to Anthers. It's a DID—a decentralized identifier you
						own. If you ever leave, your identity goes with you.
					</ValueCard>
					<ValueCard
						icon={<ArrowPathIcon className="h-6 w-6" />}
						title="Exportable content"
						compact
					>
						Your project pages, devlogs, ratings, and community interactions are stored as ATProto
						records. They belong to you structurally, not just by policy.
					</ValueCard>
					<ValueCard icon={<GlobeAltIcon className="h-6 w-6" />} title="Federated future" compact>
						ATProto enables federation—other nodes can join the network, and content is
						interoperable across them. No single point of control.
					</ValueCard>
				</div>
			</Section>

			{/* Platform comparison */}
			<Section>
				<Eyebrow>All in one</Eyebrow>
				<H2>Everything in one place</H2>
				<Lede>
					Instead of juggling itch.io + Patreon + YouTube + Substack, Anthers gives you all of it
					under one identity.
				</Lede>
				<Card className="mx-auto mt-12 max-w-3xl overflow-x-auto">
					<table className="table">
						<thead>
							<tr className="border-base-content/10">
								<th style={serif} className="font-medium">
									Feature
								</th>
								{["Anthers", "itch.io", "Patreon"].map((h) => (
									<th key={h} style={serif} className="text-center font-medium">
										{h}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{(
								[
									["Game hosting", true, true, false],
									["Video/audio/writing", true, false, true],
									["Audience follows", true, false, true],
									["Devlogs & posts", true, true, true],
									["Game jams", true, true, false],
									["100% to creator", true, false, false],
									["Transparent fees", true, false, false],
									["Data portability", true, false, false],
									["Multi-media profile", true, false, false],
								] as const
							).map(([feature, a, i, p]) => (
								<tr key={feature} className="border-base-content/10">
									<td>{feature}</td>
									<Cell on={a} highlight />
									<Cell on={i} />
									<Cell on={p} />
								</tr>
							))}
						</tbody>
					</table>
				</Card>
			</Section>

			{/* Closing */}
			<section className="bg-base-200/70">
				<div className="mx-auto max-w-2xl px-6 py-28 text-center">
					<Sprig className="mx-auto mb-6 h-14 w-14 text-primary/70" />
					<h2 style={serif} className="text-balance text-4xl font-light leading-tight sm:text-5xl">
						Ready to share your work?
					</h2>
					<p className="mx-auto mt-5 max-w-xl leading-relaxed text-base-content/70">
						Anthers is free to use. No platform cut, no hidden fees. Just publish your work and keep
						what you earn.
					</p>
					<div className="mt-8 flex flex-wrap justify-center gap-3">
						<Link to={startHref} className="btn btn-primary rounded-full px-7">
							Create Your Account
						</Link>
						<Link
							to="/discover"
							className="btn btn-outline rounded-full border-base-content/20 px-7"
						>
							Browse Projects
						</Link>
					</div>
				</div>
			</section>
		</MeadowDecor>
	);
}

// ─── Local building blocks (Meadow editorial primitives) ───

function Section({ children, tint }: { children: React.ReactNode; tint?: boolean }) {
	return (
		<section className={tint ? "bg-base-200/70" : ""}>
			<div className="mx-auto max-w-6xl px-6 py-24 text-center">{children}</div>
		</section>
	);
}

function Eyebrow({ children }: { children: React.ReactNode }) {
	return (
		<p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-primary/80">
			{children}
		</p>
	);
}

function H2({ children }: { children: React.ReactNode }) {
	return (
		<h2 style={serif} className="text-balance text-4xl font-light leading-tight sm:text-5xl">
			{children}
		</h2>
	);
}

function Lede({ children }: { children: React.ReactNode }) {
	return (
		<p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-base-content/65">
			{children}
		</p>
	);
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
	return (
		<div
			className={`rounded-3xl border border-base-content/10 bg-base-100 p-7 shadow-sm ${className}`}
		>
			{children}
		</div>
	);
}

/** An icon + heading + body card (the "how it works" / data-portability trios). */
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
				compact ? "" : "rounded-3xl border border-base-content/10 bg-base-100 p-7 shadow-sm"
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
		<Card>
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
		<Card className="text-center">
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

/** A ✓/– cell in the platform-comparison table. */
function Cell({ on, highlight }: { on: boolean; highlight?: boolean }) {
	return (
		<td className={`text-center ${highlight ? "bg-primary/5" : ""}`}>
			{on ? (
				<span className="font-bold text-primary">✓</span>
			) : (
				<span className="text-base-content/20">—</span>
			)}
		</td>
	);
}
