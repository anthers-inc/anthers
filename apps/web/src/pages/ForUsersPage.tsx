// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	ArrowDownTrayIcon,
	CurrencyDollarIcon,
	DocumentTextIcon,
	FilmIcon,
	GlobeAltIcon,
	HeartIcon,
	LockOpenIcon,
	MagnifyingGlassIcon,
	MusicalNoteIcon,
	PlayIcon,
	PuzzlePieceIcon,
	ShieldCheckIcon,
	SparklesIcon,
	StarIcon,
	TrophyIcon,
	UserGroupIcon,
} from "@heroicons/react/24/outline";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";

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
							Discover, play, and support creators
						</h1>
						<p className="py-6 text-xl text-base-content/70 leading-relaxed max-w-2xl mx-auto">
							Browse games, music, videos, and writing from independent creators. Play in your
							browser, download for free, or pay what you want—with every penny going to the person
							who made it.
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

			{/* ───────────── Zero Friction ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">No barriers, no tricks</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Other platforms make you create an account, verify your email, and agree to terms before
						you can do anything. Anthers gets out of your way.
					</p>

					<div className="grid grid-cols-1 md:grid-cols-3 gap-10">
						<div className="text-center">
							<div className="w-14 h-14 rounded-full bg-secondary/15 flex items-center justify-center mx-auto mb-4">
								<PlayIcon className="w-7 h-7 text-secondary" />
							</div>
							<h3 className="font-bold text-lg mb-2">Play instantly</h3>
							<p className="text-sm text-base-content/60 leading-relaxed">
								HTML5 games run in your browser with one click. No downloads, no installs, no
								account. See a game, click play, you're in.
							</p>
						</div>
						<div className="text-center">
							<div className="w-14 h-14 rounded-full bg-success/15 flex items-center justify-center mx-auto mb-4">
								<ArrowDownTrayIcon className="w-7 h-7 text-success" />
							</div>
							<h3 className="font-bold text-lg mb-2">Download freely</h3>
							<p className="text-sm text-base-content/60 leading-relaxed">
								Free content is genuinely free—no login wall, no email gate, no "subscribe to
								download" tricks. If a creator made it free, you get it free.
							</p>
						</div>
						<div className="text-center">
							<div className="w-14 h-14 rounded-full bg-primary/15 flex items-center justify-center mx-auto mb-4">
								<MagnifyingGlassIcon className="w-7 h-7 text-primary" />
							</div>
							<h3 className="font-bold text-lg mb-2">Browse everything</h3>
							<p className="text-sm text-base-content/60 leading-relaxed">
								The full catalog is open. Search, filter by media type, explore tags, check
								ratings—all without signing in. The platform works for you before you commit to it.
							</p>
						</div>
					</div>
				</div>
			</section>

			{/* ───────────── What You'll Find ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">All kinds of creative work</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Anthers isn't just games. Creators publish across media—and you can discover all of it
						in one place, from one search bar.
					</p>

					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
						<ContentCard
							icon={<PuzzlePieceIcon className="w-8 h-8" />}
							title="Games"
							color="badge-secondary"
							description="Indie games, game jam entries, browser games, and downloadable builds for every platform."
							highlights={[
								"Play web games instantly",
								"Download for Windows, Mac, Linux",
								"Game jam entries and experiments",
							]}
						/>
						<ContentCard
							icon={<FilmIcon className="w-8 h-8" />}
							title="Video"
							color="badge-error"
							description="Devlogs, tutorials, short films, and creative content from independent video creators."
							highlights={[
								"Watch without ads",
								"Creator-first experience",
								"Alongside related projects",
							]}
						/>
						<ContentCard
							icon={<MusicalNoteIcon className="w-8 h-8" />}
							title="Audio"
							color="badge-success"
							description="Music, soundtracks, podcasts, and audio experiments from artists and composers."
							highlights={["Stream directly", "Game soundtracks bundled", "Albums and singles"]}
						/>
						<ContentCard
							icon={<DocumentTextIcon className="w-8 h-8" />}
							title="Writing"
							color="badge-info"
							description="Essays, fiction, devlogs, tutorials, and journals from writers and game developers."
							highlights={["Read on the platform", "Development journals", "Tutorials and guides"]}
						/>
					</div>
				</div>
			</section>

			{/* ───────────── Discovery ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-12">Find your next favorite thing</h2>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-10">
						<DiscoveryFeature
							icon={<MagnifyingGlassIcon className="w-6 h-6" />}
							title="Search and filter"
							description="Find projects by name, tag, media type, or creator. Filter by pricing (free, pay what you want, paid) and sort by rating, recency, or popularity."
						/>
						<DiscoveryFeature
							icon={<TrophyIcon className="w-6 h-6" />}
							title="Game jams"
							description="Browse game jam entries, play submissions, vote on your favorites, and discover new creators through community events. Jams are where hidden gems surface."
						/>
						<DiscoveryFeature
							icon={<StarIcon className="w-6 h-6" />}
							title="Ratings and reviews"
							description="Community ratings help the best work rise to the top. Read what other users think before you download or buy. Leave your own ratings to help others discover great projects."
						/>
						<DiscoveryFeature
							icon={<UserGroupIcon className="w-6 h-6" />}
							title="Follow creators"
							description="Found someone whose work you love? Follow them and get every new project, devlog, and update in your personal feed. One follow covers everything they create."
						/>
						<DiscoveryFeature
							icon={<SparklesIcon className="w-6 h-6" />}
							title="Personalized feed"
							description="Your feed shows updates from creators you follow—new releases, devlog posts, jam entries. A single timeline for everything you care about."
						/>
						<DiscoveryFeature
							icon={<GlobeAltIcon className="w-6 h-6" />}
							title="Explore by media"
							description="Browse games, videos, audio, and writing separately or together. Discover a game and find the creator also makes music? Their whole catalog is one click away."
						/>
					</div>
				</div>
			</section>

			{/* ───────────── Fair Pricing for Users ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">Transparent pricing you can trust</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						When you buy something on Anthers, you see exactly where your money goes. No hidden
						fees, no surprise charges. The creator's price is what the creator gets.
					</p>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-8">
						{/* Example receipt */}
						<div className="card bg-base-200">
							<div className="card-body">
								<h3 className="font-bold text-lg mb-3">Example: Buying a $10 game</h3>
								<div className="flex flex-col gap-2 text-sm">
									<ReceiptLine label="Game price (to creator)" amount="$10.00" bold />
									<ReceiptLine label="Infrastructure fee" amount="$0.01" />
									<ReceiptLine label="Anthers Foundation Fee (3%)" amount="$0.30" />
									<ReceiptLine label="Payment processing (2.9% + $0.30)" amount="$0.59" />
									<div className="divider my-1" />
									<ReceiptLine label="You pay" amount="$10.90" bold />
								</div>
								<p className="text-xs text-base-content/40 mt-3">
									100% of the game price goes to the creator. Always.
								</p>
							</div>
						</div>

						<div className="flex flex-col gap-6 justify-center">
							<div className="flex gap-3">
								<div className="flex-shrink-0 mt-1">
									<CurrencyDollarIcon className="w-5 h-5 text-success" />
								</div>
								<div>
									<h4 className="font-semibold text-sm">Your money reaches the creator</h4>
									<p className="text-sm text-base-content/60">
										On other platforms, 10-30% of what you pay disappears into the platform's
										pocket. Here, the creator's listed price is exactly what they receive.
									</p>
								</div>
							</div>
							<div className="flex gap-3">
								<div className="flex-shrink-0 mt-1">
									<ShieldCheckIcon className="w-5 h-5 text-primary" />
								</div>
								<div>
									<h4 className="font-semibold text-sm">No hidden costs</h4>
									<p className="text-sm text-base-content/60">
										Every fee is listed and explained before you pay. You always know exactly what
										you're paying for and why.
									</p>
								</div>
							</div>
							<div className="flex gap-3">
								<div className="flex-shrink-0 mt-1">
									<HeartIcon className="w-5 h-5 text-error" />
								</div>
								<div>
									<h4 className="font-semibold text-sm">Anthers Foundation</h4>
									<p className="text-sm text-base-content/60">
										A small 3% contribution funds the Anthers Foundation, which allocates between
										charitable programs and organizational operations to keep the ecosystem healthy
										for everyone.
									</p>
								</div>
							</div>
						</div>
					</div>

					{/* Pricing models */}
					<div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12">
						<PricingCard
							title="Free"
							description="Tons of content is completely free—games, demos, jam entries, devlogs. Download or play with no account required."
							badge="badge-success"
						/>
						<PricingCard
							title="Pay What You Want"
							description="Some creators let you choose what to pay. Give what you can—even $1 helps. Or pay nothing if that's what works."
							badge="badge-warning"
						/>
						<PricingCard
							title="Fixed Price"
							description="The price you see is the price the creator set. What they list is what they get. Your purchase directly funds their work."
							badge="badge-neutral"
						/>
					</div>
				</div>
			</section>

			{/* ───────────── Subscription Tiers ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">
						Support creators with a subscription
					</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Optional subscriptions let you support the creators you love. Your subscription funds
						are distributed based on what you actually watch, play, read, and listen to—plus
						optional boosts to your favorites.
					</p>
					<div className="overflow-x-auto">
						<table className="table table-sm max-w-3xl mx-auto">
							<thead>
								<tr>
									<th>Tier</th>
									<th className="text-right">Starting at</th>
									<th className="text-right">Content Cap</th>
									<th className="text-right">Gate Access</th>
								</tr>
							</thead>
							<tbody>
								<tr>
									<td>Free</td>
									<td className="text-right">Free</td>
									<td className="text-right">10 hrs/mo</td>
									<td className="text-right text-base-content/40">No</td>
								</tr>
								<tr>
									<td>Root</td>
									<td className="text-right">$3/mo</td>
									<td className="text-right">25 hrs/mo</td>
									<td className="text-right text-base-content/60">Boost gates*</td>
								</tr>
								<tr>
									<td>Sprout</td>
									<td className="text-right">$7/mo</td>
									<td className="text-right">Unlimited</td>
									<td className="text-right text-success">Both</td>
								</tr>
								<tr>
									<td>Petal</td>
									<td className="text-right">$15/mo</td>
									<td className="text-right">Unlimited</td>
									<td className="text-right text-success">Both</td>
								</tr>
								<tr>
									<td>Bloom</td>
									<td className="text-right">$30/mo</td>
									<td className="text-right">Unlimited</td>
									<td className="text-right text-success">Both</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p className="text-center text-xs text-base-content/40 mt-4">
						Tiers are threshold prices — you can adjust your support level in $1 increments. Any
						funding level above $3 generates Boost Pool funds to direct to favorite creators and
						unlock boost-gated content. *Platform tier gates (e.g. "Sprout required") need the
						corresponding threshold. Subscriptions coming soon.
					</p>
				</div>
			</section>

			{/* ───────────── Your Data Is Yours ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">Your account, your data</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Anthers is built on the AT Protocol (the tech behind Bluesky). Sign in with your
						existing Bluesky identity, or create a new one. Your follows, library, and activity are
						yours—portable and not locked in.
					</p>

					<div className="grid grid-cols-1 md:grid-cols-3 gap-8">
						<div className="text-center">
							<div className="w-12 h-12 rounded-full bg-info/15 flex items-center justify-center mx-auto mb-3">
								<LockOpenIcon className="w-6 h-6 text-info" />
							</div>
							<h3 className="font-semibold mb-1">Portable identity</h3>
							<p className="text-sm text-base-content/60">
								Your account is a decentralized identifier (DID) you control. If you already have a
								Bluesky account, you can use the same identity here.
							</p>
						</div>
						<div className="text-center">
							<div className="w-12 h-12 rounded-full bg-info/15 flex items-center justify-center mx-auto mb-3">
								<GlobeAltIcon className="w-6 h-6 text-info" />
							</div>
							<h3 className="font-semibold mb-1">No lock-in</h3>
							<p className="text-sm text-base-content/60">
								Your follows, ratings, library, and activity are stored in a way that's portable. If
								you ever want to leave, your data goes with you.
							</p>
						</div>
						<div className="text-center">
							<div className="w-12 h-12 rounded-full bg-info/15 flex items-center justify-center mx-auto mb-3">
								<ShieldCheckIcon className="w-6 h-6 text-info" />
							</div>
							<h3 className="font-semibold mb-1">Privacy first</h3>
							<p className="text-sm text-base-content/60">
								No tracking cookies, no ad-driven surveillance, no selling your browsing history.
								The platform works for you and the creators you support.
							</p>
						</div>
					</div>
				</div>
			</section>

			{/* ───────────── What You Get ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">Free account, real benefits</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						You can do a lot without an account. But a free account unlocks the full experience—and
						it takes 30 seconds.
					</p>

					<div className="overflow-x-auto">
						<table className="table table-sm max-w-2xl mx-auto">
							<thead>
								<tr>
									<th>Feature</th>
									<th className="text-center">No account</th>
									<th className="text-center">Free account</th>
								</tr>
							</thead>
							<tbody>
								<AccountComparisonRow
									feature="Browse all projects"
									noAccount={true}
									freeAccount={true}
								/>
								<AccountComparisonRow
									feature="Play web games"
									noAccount={true}
									freeAccount={true}
								/>
								<AccountComparisonRow
									feature="Download free content"
									noAccount={true}
									freeAccount={true}
								/>
								<AccountComparisonRow
									feature="Read devlogs and posts"
									noAccount={true}
									freeAccount={true}
								/>
								<AccountComparisonRow
									feature="Follow creators"
									noAccount={false}
									freeAccount={true}
								/>
								<AccountComparisonRow
									feature="Personal feed"
									noAccount={false}
									freeAccount={true}
								/>
								<AccountComparisonRow
									feature="Rate and comment"
									noAccount={false}
									freeAccount={true}
								/>
								<AccountComparisonRow
									feature="Purchase paid content"
									noAccount={false}
									freeAccount={true}
								/>
								<AccountComparisonRow
									feature="Save to library"
									noAccount={false}
									freeAccount={true}
								/>
								<AccountComparisonRow
									feature="Join game jams"
									noAccount={false}
									freeAccount={true}
								/>
							</tbody>
						</table>
					</div>
				</div>
			</section>

			{/* ───────────── CTA ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 text-center max-w-2xl">
					<h2 className="text-3xl font-bold mb-4">Start exploring</h2>
					<p className="text-base-content/60 mb-8 leading-relaxed">
						Thousands of games, videos, music, and writing from independent creators—many of them
						free. No account required to start browsing.
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

function ContentCard({
	icon,
	title,
	color,
	description,
	highlights,
}: {
	icon: React.ReactNode;
	title: string;
	color: string;
	description: string;
	highlights: string[];
}) {
	return (
		<div className="card bg-base-200 shadow-sm">
			<div className="card-body p-5">
				<div className="flex items-center gap-2 mb-2">
					<span className="text-base-content/40">{icon}</span>
					<span className={`badge badge-sm ${color}`}>{title}</span>
				</div>
				<p className="text-sm text-base-content/60 mb-3">{description}</p>
				<ul className="text-xs text-base-content/50 flex flex-col gap-1">
					{highlights.map((h) => (
						<li key={h} className="flex items-center gap-1">
							<span className="text-success">✓</span> {h}
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

function DiscoveryFeature({
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
			<div className="flex-shrink-0 w-10 h-10 rounded-lg bg-base-100 flex items-center justify-center text-secondary">
				{icon}
			</div>
			<div>
				<h3 className="font-semibold mb-1">{title}</h3>
				<p className="text-sm text-base-content/60 leading-relaxed">{description}</p>
			</div>
		</div>
	);
}

function ReceiptLine({ label, amount, bold }: { label: string; amount: string; bold?: boolean }) {
	return (
		<div className={`flex justify-between ${bold ? "font-semibold" : "text-base-content/70"}`}>
			<span>{label}</span>
			<span>{amount}</span>
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

function AccountComparisonRow({
	feature,
	noAccount,
	freeAccount,
}: {
	feature: string;
	noAccount: boolean;
	freeAccount: boolean;
}) {
	const check = <span className="text-success font-bold">✓</span>;
	const dash = <span className="text-base-content/20">—</span>;
	return (
		<tr>
			<td>{feature}</td>
			<td className="text-center">{noAccount ? check : dash}</td>
			<td className="text-center">{freeAccount ? check : dash}</td>
		</tr>
	);
}
