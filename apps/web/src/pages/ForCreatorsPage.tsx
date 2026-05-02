import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import {
	CurrencyDollarIcon,
	GlobeAltIcon,
	UserGroupIcon,
	ShieldCheckIcon,
	ArrowDownTrayIcon,
	PaintBrushIcon,
	MusicalNoteIcon,
	FilmIcon,
	DocumentTextIcon,
	PuzzlePieceIcon,
	ChartBarIcon,
	TrophyIcon,
	ChatBubbleLeftRightIcon,
	StarIcon,
	ArrowPathIcon,
	EyeIcon,
	ServerStackIcon,
	LockOpenIcon,
} from "@heroicons/react/24/outline";

export default function ForCreatorsPage() {
	const { isAuthenticated } = useAuth();

	return (
		<div>
			{/* ───────────── Hero ───────────── */}
			<section className="hero min-h-[60vh]">
				<div className="hero-content text-center py-20">
					<div className="max-w-3xl">
						<p className="text-sm font-medium text-primary mb-3 tracking-wide uppercase">
							For Creators
						</p>
						<h1 className="text-5xl font-bold tracking-tight">
							Publish your work. Keep what you earn.
						</h1>
						<p className="py-6 text-xl text-base-content/70 leading-relaxed max-w-2xl mx-auto">
							Games, videos, music, and writing—all under one roof, one
							identity, one audience. No platform cut. No hidden fees.
							Transparent costs you can see and verify.
						</p>
						<div className="flex gap-4 justify-center flex-wrap">
							<Link
								to={isAuthenticated ? "/dashboard" : "/signup"}
								className="btn btn-primary btn-lg"
							>
								Start Creating
							</Link>
							<Link to="/discover" className="btn btn-outline btn-lg">
								See What Others Built
							</Link>
						</div>
					</div>
				</div>
			</section>

			{/* ───────────── Revenue Comparison ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">
						Creators deserve better
					</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Existing platforms take 10-30% of your revenue, own your data, and
						fragment your audience across multiple services. You need a separate
						account for every medium, a separate audience for every platform.
					</p>

					<div className="overflow-x-auto">
						<table className="table table-sm max-w-2xl mx-auto">
							<thead>
								<tr>
									<th>Platform</th>
									<th className="text-right">Creator keeps on $10 sale</th>
									<th className="text-right">Platform takes</th>
								</tr>
							</thead>
							<tbody>
								<tr className="bg-primary/10 font-semibold">
									<td>Anthers</td>
									<td className="text-right text-success">$10.00 (100%)</td>
									<td className="text-right">$0.00</td>
								</tr>
								<tr>
									<td>itch.io</td>
									<td className="text-right">$9.00</td>
									<td className="text-right text-error">$1.00 (10%)</td>
								</tr>
								<tr>
									<td>Epic Games Store</td>
									<td className="text-right">$8.80</td>
									<td className="text-right text-error">$1.20 (12%)</td>
								</tr>
								<tr>
									<td>Patreon</td>
									<td className="text-right">$9.20</td>
									<td className="text-right text-error">$0.80 (8%)</td>
								</tr>
								<tr>
									<td>Steam</td>
									<td className="text-right">$7.00</td>
									<td className="text-right text-error">$3.00 (30%)</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p className="text-center text-sm text-base-content/40 mt-4">
						On Anthers, real costs (payment processing, infrastructure) are
						shown as transparent line items—never a percentage cut.
					</p>
				</div>
			</section>

			{/* ───────────── Core Value Props ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-12">
						How Anthers works for creators
					</h2>
					<div className="grid grid-cols-1 md:grid-cols-3 gap-10">
						<div className="text-center">
							<div className="w-14 h-14 rounded-full bg-success/15 flex items-center justify-center mx-auto mb-4">
								<CurrencyDollarIcon className="w-7 h-7 text-success" />
							</div>
							<h3 className="font-bold text-lg mb-2">100% to Creators</h3>
							<p className="text-sm text-base-content/60 leading-relaxed">
								You set a price, you receive that price. Processing fees and
								infrastructure costs are passed through transparently as
								itemized line items the buyer sees at checkout—never hidden,
								never a percentage cut from your earnings.
							</p>
						</div>
						<div className="text-center">
							<div className="w-14 h-14 rounded-full bg-primary/15 flex items-center justify-center mx-auto mb-4">
								<GlobeAltIcon className="w-7 h-7 text-primary" />
							</div>
							<h3 className="font-bold text-lg mb-2">
								One Home for Everything
							</h3>
							<p className="text-sm text-base-content/60 leading-relaxed">
								Games, videos, music, writing—all under one roof, one
								identity, one audience. A game developer who writes devlogs and
								composes music shouldn't need three separate platforms.
								Followers subscribe to <em>you</em>, not a medium.
							</p>
						</div>
						<div className="text-center">
							<div className="w-14 h-14 rounded-full bg-warning/15 flex items-center justify-center mx-auto mb-4">
								<UserGroupIcon className="w-7 h-7 text-warning" />
							</div>
							<h3 className="font-bold text-lg mb-2">Community Built In</h3>
							<p className="text-sm text-base-content/60 leading-relaxed">
								Follows, devlogs, comments, ratings, game jams—everything
								you need to build and engage your audience lives on the same
								platform where your work lives. No more scattering your
								community across Discord, Patreon, and Twitter.
							</p>
						</div>
					</div>
				</div>
			</section>

			{/* ───────────── Multi-Media Showcase ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">
						Every kind of creative work
					</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Anthers isn't just for games. Publish anything you create—the
						platform adapts to the medium while keeping the same tools, the same
						audience, and the same economics.
					</p>
					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
						<MediaCard
							icon={<PuzzlePieceIcon className="w-8 h-8" />}
							title="Games"
							color="badge-secondary"
							description="Upload builds for Windows, Mac, Linux. Host HTML5 games playable in the browser. Manage versions, platforms, and pricing."
							features={[
								"Multi-platform downloads",
								"Web game embedding",
								"Game jam support",
							]}
						/>
						<MediaCard
							icon={<FilmIcon className="w-8 h-8" />}
							title="Video"
							color="badge-error"
							description="Publish video content alongside your other work. Your devlog videos and your games live in the same place, for the same audience."
							features={[
								"Native hosting",
								"Devlog series",
								"Creator portfolio",
							]}
						/>
						<MediaCard
							icon={<MusicalNoteIcon className="w-8 h-8" />}
							title="Audio"
							color="badge-success"
							description="Share music, soundtracks, podcasts. A game composer can publish their soundtrack right alongside the game it belongs to."
							features={[
								"Album & track hosting",
								"Soundtrack bundling",
								"Streaming playback",
							]}
						/>
						<MediaCard
							icon={<DocumentTextIcon className="w-8 h-8" />}
							title="Writing"
							color="badge-info"
							description="Essays, tutorials, fiction, devlogs. First-class publishing for written content with your full creator profile and audience behind it."
							features={[
								"Rich text posts",
								"Devlog journals",
								"Standalone essays",
							]}
						/>
					</div>
				</div>
			</section>

			{/* ───────────── Transparent Pricing Deep Dive ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">
						Transparent pricing, not platform rent
					</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						At checkout, buyers see exactly where every penny goes. No hidden
						fees, no opaque "revenue share." Real infrastructure costs are
						passed through—and they're tiny.
					</p>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-8">
						{/* Example receipt */}
						<div className="card bg-base-200">
							<div className="card-body">
								<h3 className="font-bold text-lg mb-3">
									Example: $10 game (card payment)
								</h3>
								<div className="flex flex-col gap-2 text-sm">
									<ReceiptLine label="Game price (to creator)" amount="$10.00" bold />
									<ReceiptLine label="Infrastructure fee" amount="$0.01" />
									<ReceiptLine
										label="Anthers Foundation Fee (3%)"
										amount="$0.30"
									/>
									<ReceiptLine
										label="Payment processing (2.9% + $0.30)"
										amount="$0.59"
									/>
									<div className="divider my-1" />
									<ReceiptLine label="You pay" amount="$10.90" bold />
								</div>
								<p className="text-xs text-base-content/40 mt-3">
									Creator receives $10.00—every time.
								</p>
							</div>
						</div>

						<div className="flex flex-col gap-6 justify-center">
							<div className="flex gap-3">
								<div className="flex-shrink-0 mt-1">
									<ShieldCheckIcon className="w-5 h-5 text-success" />
								</div>
								<div>
									<h4 className="font-semibold text-sm">No percentage cut</h4>
									<p className="text-sm text-base-content/60">
										The creator's price is the creator's revenue. Full stop.
									</p>
								</div>
							</div>
							<div className="flex gap-3">
								<div className="flex-shrink-0 mt-1">
									<EyeIcon className="w-5 h-5 text-primary" />
								</div>
								<div>
									<h4 className="font-semibold text-sm">Full visibility</h4>
									<p className="text-sm text-base-content/60">
										Every fee is itemized and explained. Buyers understand
										what they're paying for. Creators understand what they're
										earning.
									</p>
								</div>
							</div>
							<div className="flex gap-3">
								<div className="flex-shrink-0 mt-1">
									<ServerStackIcon className="w-5 h-5 text-warning" />
								</div>
								<div>
									 <h4 className="font-semibold text-sm">
										Anthers Foundation
									</h4>
									<p className="text-sm text-base-content/60">
										3% of transactions funds the Anthers Foundation, which
										allocates between charitable programs and organizational
										operations. It's a community investment, not a platform tax.
									</p>
								</div>
							</div>
						</div>
					</div>

					{/* Pricing options */}
					<div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12">
						<PricingOption
							title="Free"
							description="No charge, no account required. Anyone can download or play in the browser. Great for jam entries, demos, and open-source projects."
							badge="badge-success"
						/>
						<PricingOption
							title="Pay What You Want"
							description="Set a suggested price and an optional minimum. Let your audience decide what your work is worth to them."
							badge="badge-warning"
						/>
						<PricingOption
							title="Fixed Price"
							description="Set your price and receive 100% of it. Transparent fees are added on top for the buyer—never taken from your cut."
							badge="badge-neutral"
						/>
					</div>
				</div>
			</section>

			{/* ───────────── Feature Showcase ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-12">
						Everything you need to publish and grow
					</h2>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-10">
						<Feature
							icon={<PaintBrushIcon className="w-6 h-6" />}
							title="Rich project pages"
							description="Cover images, screenshots, detailed descriptions, and download links. Each project gets a dedicated page that adapts to its media type—platform-grouped downloads for games, embedded players for audio and video."
						/>
						<Feature
							icon={<ArrowDownTrayIcon className="w-6 h-6" />}
							title="Build management"
							description="Upload builds for multiple platforms. Label versions as stable, beta, or prerelease. Your audience downloads from organized, clearly labeled files—not a confusing pile of .zips."
						/>
						<Feature
							icon={<ChatBubbleLeftRightIcon className="w-6 h-6" />}
							title="Devlogs and posts"
							description="Write updates, announcements, and essays. Link posts to specific projects as devlogs, or publish standalone. Your audience follows your work in a unified feed—like Patreon, but alongside your actual projects."
						/>
						<Feature
							icon={<StarIcon className="w-6 h-6" />}
							title="Ratings and comments"
							description="Community feedback built into every project page. Ratings help the best work surface. Comments create conversation around your creations."
						/>
						<Feature
							icon={<TrophyIcon className="w-6 h-6" />}
							title="Game jams"
							description="Host and participate in game jams with timed submission periods, theme reveals, community voting, and ranked results. Jams are how communities form and creators get discovered."
						/>
						<Feature
							icon={<ChartBarIcon className="w-6 h-6" />}
							title="Creator dashboard"
							description="See your projects, posts, follower count, and content at a glance. Manage drafts and published work from one place. Create and edit projects with rich forms, upload builds, and manage screenshots."
						/>
						<Feature
							icon={<UserGroupIcon className="w-6 h-6" />}
							title="Creator profiles"
							description="Your own anther on Anthers—header image, bio, links, and all your work in one place. Audiences follow you, not individual projects. Like a Patreon page and an itch.io profile combined."
						/>
						<Feature
							icon={<ArrowPathIcon className="w-6 h-6" />}
							title="Follow and feed"
							description="Follow creators you care about and get their updates in a personalized feed. New project? Devlog post? Game jam entry? It all shows up in one timeline."
						/>
					</div>
				</div>
			</section>

			{/* ───────────── Audience Building ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">
						Build your audience in one place
					</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Like Patreon and YouTube Memberships, but alongside your actual
						work. Post devlogs, vlogs, podcasts, and blogs—all under the same
						profile your games live on. Your audience follows <em>you</em>,
						not a platform.
					</p>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
						<div className="card bg-base-200">
							<div className="card-body p-5">
								<h3 className="font-semibold">Native content creation</h3>
								<p className="text-sm text-base-content/60">
									Write devlogs, upload video updates, share podcast episodes —
									all natively hosted. No linking out to YouTube or Substack.
									Your content lives where your audience already is.
								</p>
							</div>
						</div>
						<div className="card bg-base-200">
							<div className="card-body p-5">
								<h3 className="font-semibold">Cross-publishing (coming soon)</h3>
								<p className="text-sm text-base-content/60">
									Publish once, distribute everywhere. Push videos to YouTube,
									builds to Steam and itch.io, posts to Substack—all from your
									Anthers dashboard. Unified analytics show performance across
									all platforms.
								</p>
							</div>
						</div>
					</div>
				</div>
			</section>

			{/* ───────────── Subscription Tiers ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">
						Subscribers fund creators, not platforms
					</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Users subscribe to Anthers, and their subscription funds are
						distributed to creators proportionally based on what they actually
						watch, read, listen to, and play. No platform cut—just transparent
						allocation.
					</p>
					<div className="overflow-x-auto">
						<table className="table table-sm max-w-3xl mx-auto">
							<thead>
								<tr>
									<th>Tier</th>
									<th className="text-right">Price</th>
									<th className="text-right">Time Pool</th>
									<th className="text-right">Boost Pool</th>
								</tr>
							</thead>
							<tbody>
								<tr>
									<td>Free</td>
									<td className="text-right">Free</td>
									<td className="text-right text-base-content/40">—</td>
									<td className="text-right text-base-content/40">—</td>
								</tr>
								<tr>
									<td>Root</td>
									<td className="text-right">$3/mo</td>
									<td className="text-right text-success">$2.76</td>
									<td className="text-right text-base-content/40">—†</td>
								</tr>
								<tr>
									<td>Sprout</td>
									<td className="text-right">$7/mo</td>
									<td className="text-right text-success">$2.76</td>
									<td className="text-right text-primary">$3.68</td>
								</tr>
								<tr className="text-base-content/50 border-dashed border-t border-base-300/50">
									<td className="italic">e.g. Sprout+</td>
									<td className="text-right italic">$10/mo</td>
									<td className="text-right text-success">$2.76</td>
									<td className="text-right text-primary">$6.44</td>
								</tr>
								<tr>
									<td>Petal</td>
									<td className="text-right">$15/mo</td>
									<td className="text-right text-success">$2.76</td>
									<td className="text-right text-primary">$11.04</td>
								</tr>
								<tr>
									<td>Bloom</td>
									<td className="text-right">$30/mo</td>
									<td className="text-right text-success">$2.76</td>
									<td className="text-right text-primary">$24.84</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p className="text-center text-xs text-base-content/40 mt-4">
						These are values at each tier threshold — users can fund at any $1
						increment and boost scales continuously. Time Pool is fixed at
						$2.76/mo at any funding level $3+, distributed proportionally by
						attention time. †Boost starts above $3, so a user at exactly $3 has
						no boost; at $4 they have $0.92 in boost. Subscriptions coming soon.
					</p>
				</div>
			</section>

			{/* ───────────── Creator Profile Preview ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">
						Your home on the internet
					</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Every creator gets a profile page that brings together everything
						they do. Games, devlogs, music, writing—one identity, one
						audience, one URL to share.
					</p>

					{/* Mock profile card */}
					<div className="card bg-base-200 max-w-2xl mx-auto overflow-hidden">
						<div className="h-32 bg-gradient-to-r from-primary/30 to-secondary/30" />
						<div className="card-body -mt-10">
							<div className="flex items-end gap-4 mb-4">
								<div className="w-20 h-20 rounded-full bg-base-300 border-4 border-base-200 flex items-center justify-center text-2xl font-bold text-base-content/40">
									A
								</div>
								<div className="pb-1">
									<h3 className="font-bold text-lg">Alex Chen</h3>
									<p className="text-sm text-base-content/50">
										@alexchen · 2,847 followers
									</p>
								</div>
							</div>
							<p className="text-sm text-base-content/70 mb-4">
								Indie game developer and composer. Making puzzle games and
								ambient soundtracks. Previously shipped Lumina and Glass Garden.
							</p>
							<div className="tabs tabs-bordered text-sm">
								<button className="tab tab-active">Projects (12)</button>
								<button className="tab">Posts (34)</button>
								<button className="tab">About</button>
							</div>
							<div className="grid grid-cols-2 gap-3 mt-4">
								{[
									{ title: "Glass Garden", type: "Game", color: "badge-secondary" },
									{ title: "Ambient Vol. 3", type: "Audio", color: "badge-success" },
									{ title: "Lumina OST", type: "Audio", color: "badge-success" },
									{ title: "Dev Diary: Shaders", type: "Text", color: "badge-info" },
								].map((item) => (
									<div
										key={item.title}
										className="p-3 rounded-lg bg-base-300/50"
									>
										<div className="flex items-center gap-2 mb-1">
											<span className={`badge badge-xs ${item.color}`}>
												{item.type}
											</span>
										</div>
										<p className="text-sm font-medium">{item.title}</p>
									</div>
								))}
							</div>
						</div>
					</div>
				</div>
			</section>

			{/* ───────────── Project Page Preview ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">
						Project pages that do the work
					</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Every project gets a full-featured page with everything your
						audience needs—adapted to the type of work you're sharing.
					</p>

					{/* Mock project page */}
					<div className="card bg-base-100 max-w-2xl mx-auto overflow-hidden shadow-lg">
						<div className="h-44 bg-gradient-to-br from-secondary/20 to-primary/20 flex items-center justify-center">
							<span className="text-5xl opacity-30">🎮</span>
						</div>
						<div className="card-body">
							<div className="flex items-center gap-2 mb-1">
								<span className="badge badge-sm badge-secondary">Game</span>
								<span className="badge badge-sm badge-success">Free</span>
							</div>
							<h3 className="font-bold text-xl">Glass Garden</h3>
							<p className="text-sm text-base-content/60">
								A meditative puzzle game about growing crystalline gardens.
								Explore procedurally generated environments and discover hidden
								patterns in the growth.
							</p>
							<div className="flex items-center gap-1 text-warning text-sm mt-1">
								<StarIcon className="w-4 h-4 fill-current" />
								<StarIcon className="w-4 h-4 fill-current" />
								<StarIcon className="w-4 h-4 fill-current" />
								<StarIcon className="w-4 h-4 fill-current" />
								<StarIcon className="w-4 h-4 opacity-30" />
								<span className="text-base-content/50 ml-1">4.2 (128 ratings)</span>
							</div>

							<div className="divider my-2" />

							{/* Downloads mock */}
							<h4 className="font-semibold text-sm mb-2">Downloads</h4>
							<div className="flex flex-col gap-2">
								{[
									{ platform: "Windows", file: "glass-garden-win.zip", size: "245 MB" },
									{ platform: "macOS", file: "glass-garden-mac.dmg", size: "260 MB" },
									{ platform: "Linux", file: "glass-garden-linux.tar.gz", size: "240 MB" },
								].map((dl) => (
									<div
										key={dl.platform}
										className="flex items-center justify-between p-2 rounded bg-base-200 text-sm"
									>
										<div>
											<span className="font-medium">{dl.platform}</span>
											<span className="text-base-content/40 ml-2">{dl.file}</span>
										</div>
										<div className="flex items-center gap-3">
											<span className="text-base-content/50">{dl.size}</span>
											<span className="btn btn-xs btn-primary">Download</span>
										</div>
									</div>
								))}
							</div>

							<div className="divider my-2" />

							{/* Devlog mock */}
							<h4 className="font-semibold text-sm mb-2">Devlog</h4>
							<div className="flex flex-col gap-2 text-sm">
								<div className="p-2 rounded bg-base-200">
									<span className="font-medium">v1.2: New biome types</span>
									<span className="text-base-content/40 ml-2">Jan 15</span>
								</div>
								<div className="p-2 rounded bg-base-200">
									<span className="font-medium">Behind the procedural generation</span>
									<span className="text-base-content/40 ml-2">Dec 28</span>
								</div>
							</div>
						</div>
					</div>
				</div>
			</section>

			{/* ───────────── Data Portability ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">
						Your data is yours
					</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Anthers is built on the AT Protocol—the same open standard
						behind Bluesky. Sign in with your Bluesky identity, or create a
						new one. Your content and audience relationships are portable by
						design.
					</p>

					<div className="grid grid-cols-1 md:grid-cols-3 gap-8">
						<div className="text-center">
							<div className="w-12 h-12 rounded-full bg-info/15 flex items-center justify-center mx-auto mb-3">
								<LockOpenIcon className="w-6 h-6 text-info" />
							</div>
							<h3 className="font-semibold mb-1">Portable identity</h3>
							<p className="text-sm text-base-content/60">
								Your creator identity isn't locked to Anthers. It's a DID
							 —a decentralized identifier you own. If you ever leave,
								your identity goes with you.
							</p>
						</div>
						<div className="text-center">
							<div className="w-12 h-12 rounded-full bg-info/15 flex items-center justify-center mx-auto mb-3">
								<ArrowPathIcon className="w-6 h-6 text-info" />
							</div>
							<h3 className="font-semibold mb-1">Exportable content</h3>
							<p className="text-sm text-base-content/60">
								Your project pages, devlogs, ratings, and community
								interactions are stored as ATProto records. They belong
								to you structurally, not just by policy.
							</p>
						</div>
						<div className="text-center">
							<div className="w-12 h-12 rounded-full bg-info/15 flex items-center justify-center mx-auto mb-3">
								<GlobeAltIcon className="w-6 h-6 text-info" />
							</div>
							<h3 className="font-semibold mb-1">Federated future</h3>
							<p className="text-sm text-base-content/60">
								ATProto enables federation—other nodes can join the
								network, and content is interoperable across them. No
								single point of control.
							</p>
						</div>
					</div>
				</div>
			</section>

			{/* ───────────── Platform Comparison ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-12">
						Everything in one place
					</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Instead of juggling itch.io + Patreon + YouTube + Substack,
						Anthers gives you all of it under one identity.
					</p>

					<div className="overflow-x-auto">
						<table className="table table-sm max-w-3xl mx-auto">
							<thead>
								<tr>
									<th>Feature</th>
									 <th className="text-center">Anthers</th>
									<th className="text-center">itch.io</th>
									<th className="text-center">Patreon</th>
								</tr>
							</thead>
							<tbody>
								<ComparisonRow feature="Game hosting" anthers={true} itch={true} patreon={false} />
								<ComparisonRow feature="Video/audio/writing" anthers={true} itch={false} patreon={true} />
								<ComparisonRow feature="Audience follows" anthers={true} itch={false} patreon={true} />
								<ComparisonRow feature="Devlogs & posts" anthers={true} itch={true} patreon={true} />
								<ComparisonRow feature="Game jams" anthers={true} itch={true} patreon={false} />
								<ComparisonRow feature="100% to creator" anthers={true} itch={false} patreon={false} />
								<ComparisonRow feature="Transparent fees" anthers={true} itch={false} patreon={false} />
								<ComparisonRow feature="Data portability" anthers={true} itch={false} patreon={false} />
								<ComparisonRow feature="Multi-media profile" anthers={true} itch={false} patreon={false} />
							</tbody>
						</table>
					</div>
				</div>
			</section>

			{/* ───────────── CTA ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 text-center max-w-2xl">
					<h2 className="text-3xl font-bold mb-4">
						Ready to share your work?
					</h2>
					<p className="text-base-content/60 mb-8 leading-relaxed">
						Anthers is free to use. No platform cut, no hidden fees. Just
						publish your work and keep what you earn.
					</p>
					<div className="flex gap-4 justify-center flex-wrap">
						<Link
							to={isAuthenticated ? "/dashboard" : "/signup"}
							className="btn btn-primary btn-lg"
						>
							Create Your Account
						</Link>
						<Link to="/discover" className="btn btn-outline btn-lg">
							Browse Projects
						</Link>
					</div>
				</div>
			</section>
		</div>
	);
}

// ─── Sub-components ───

function MediaCard({
	icon,
	title,
	color,
	description,
	features,
}: {
	icon: React.ReactNode;
	title: string;
	color: string;
	description: string;
	features: string[];
}) {
	return (
		<div className="card bg-base-100 shadow-sm">
			<div className="card-body p-5">
				<div className="flex items-center gap-2 mb-2">
					<span className="text-base-content/40">{icon}</span>
					<span className={`badge badge-sm ${color}`}>{title}</span>
				</div>
				<p className="text-sm text-base-content/60 mb-3">{description}</p>
				<ul className="text-xs text-base-content/50 flex flex-col gap-1">
					{features.map((f) => (
						<li key={f} className="flex items-center gap-1">
							<span className="text-success">✓</span> {f}
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

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
			<div className="flex-shrink-0 w-10 h-10 rounded-lg bg-base-200 flex items-center justify-center text-primary">
				{icon}
			</div>
			<div>
				<h3 className="font-semibold mb-1">{title}</h3>
				<p className="text-sm text-base-content/60 leading-relaxed">
					{description}
				</p>
			</div>
		</div>
	);
}

function ReceiptLine({
	label,
	amount,
	bold,
}: {
	label: string;
	amount: string;
	bold?: boolean;
}) {
	return (
		<div
			className={`flex justify-between ${bold ? "font-semibold" : "text-base-content/70"}`}
		>
			<span>{label}</span>
			<span>{amount}</span>
		</div>
	);
}

function PricingOption({
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

function ComparisonRow({
	feature,
	anthers,
	itch,
	patreon,
}: {
	feature: string;
	anthers: boolean;
	itch: boolean;
	patreon: boolean;
}) {
	const check = <span className="text-success font-bold">✓</span>;
	const dash = <span className="text-base-content/20">—</span>;
	return (
		<tr>
			<td>{feature}</td>
			<td className="text-center">{anthers ? check : dash}</td>
			<td className="text-center">{itch ? check : dash}</td>
			<td className="text-center">{patreon ? check : dash}</td>
		</tr>
	);
}
