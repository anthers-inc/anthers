import {
	ArrowPathIcon,
	ChartBarIcon,
	CurrencyDollarIcon,
	DocumentTextIcon,
	EyeIcon,
	FilmIcon,
	GlobeAltIcon,
	LockOpenIcon,
	MusicalNoteIcon,
	PuzzlePieceIcon,
	ServerStackIcon,
	ShieldCheckIcon,
	UserGroupIcon,
} from "@heroicons/react/24/outline";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";

export default function CompareItchPage() {
	const { isAuthenticated } = useAuth();

	return (
		<div>
			{/* ───────────── Hero ───────────── */}
			<section className="hero min-h-[60vh]">
				<div className="hero-content text-center py-20">
					<div className="max-w-3xl">
						<p className="text-sm font-medium text-primary mb-3 tracking-wide uppercase">
							Anthers vs itch.io
						</p>
						<h1 className="text-5xl font-bold tracking-tight">
							Love itch.io? You'll feel right at home.
						</h1>
						<p className="py-6 text-xl text-base-content/70 leading-relaxed max-w-2xl mx-auto">
							itch.io is a beloved platform that's done more for indie creators than almost anyone.
							Anthers builds on that same spirit — creator-first economics, open publishing,
							community game jams — and extends it with multi-media support, transparent pricing,
							and data portability.
						</p>
						<div className="flex gap-4 justify-center flex-wrap">
							<Link
								to={isAuthenticated ? "/dashboard" : "/signup"}
								className="btn btn-primary btn-lg"
							>
								Try Anthers Free
							</Link>
							<Link to="/discover" className="btn btn-outline btn-lg">
								Explore Projects
							</Link>
						</div>
					</div>
				</div>
			</section>

			{/* ───────────── Respectful Positioning ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-3xl">
					<h2 className="text-3xl font-bold text-center mb-4">
						Standing on the shoulders of a great platform
					</h2>
					<p className="text-base-content/70 leading-relaxed text-center max-w-2xl mx-auto mb-8">
						itch.io pioneered creator-friendly game distribution. They proved that a platform could
						put creators first—with open publishing, flexible revenue sharing, customizable pages,
						and a vibrant community of game jams. Millions of indie games have found their audience
						because itch.io exists.
					</p>
					<p className="text-base-content/70 leading-relaxed text-center max-w-2xl mx-auto">
						Anthers aims to carry that mission forward and expand it. We believe creators deserve
						100% of their earnings, support for every medium they work in, and true ownership of
						their identity and data. If itch.io is the place that showed the world what indie game
						distribution could be, Anthers is our attempt to build the next chapter—for games,
						videos, music, and writing all in one place.
					</p>
				</div>
			</section>

			{/* ───────────── Key Differences ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-12">What Anthers does differently</h2>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-10">
						<DiffCard
							icon={<CurrencyDollarIcon className="w-6 h-6" />}
							title="100% to creators—no revenue share"
							description="itch.io defaults to a 10% revenue share (which creators can adjust, even to 0%). Anthers never takes a percentage. Your price is your revenue. Infrastructure and payment processing costs are shown as transparent line items to the buyer—never subtracted from your earnings."
						/>
						<DiffCard
							icon={<GlobeAltIcon className="w-6 h-6" />}
							title="One home for every medium"
							description="itch.io is primarily built for games. If you also make videos, music, or written content, you need separate platforms. Anthers gives you one profile, one audience, and one URL for everything you create—games, devlogs, soundtracks, essays, and more."
						/>
						<DiffCard
							icon={<EyeIcon className="w-6 h-6" />}
							title="Transparent, itemized pricing"
							description="On itch.io, the platform's share is deducted from your sale. On Anthers, every cost is itemized at checkout—payment processing, infrastructure, and the Anthers Foundation. Buyers see exactly where their money goes. Creators receive exactly what they charged."
						/>
						<DiffCard
							icon={<LockOpenIcon className="w-6 h-6" />}
							title="Built on open protocols"
							description="Anthers is built on the AT Protocol (the same standard behind Bluesky). Your identity is a portable DID you own. Your content is stored as interoperable records. If you ever leave, your data goes with you—not by policy, but by design."
						/>
						<DiffCard
							icon={<UserGroupIcon className="w-6 h-6" />}
							title="Subscription model that funds creators"
							description="Beyond individual sales, Anthers offers a subscription pool where subscriber payments are distributed to creators based on actual attention time—what people play, watch, read, and listen to. It's a new revenue stream that rewards engagement, not just transactions."
						/>
						<DiffCard
							icon={<ChartBarIcon className="w-6 h-6" />}
							title="Unified creator dashboard"
							description="Manage all your projects, posts, analytics, and audience from one place. itch.io's dashboard is focused on game sales and analytics. Anthers's dashboard covers your entire creative output—games, posts, audio, video—with follow and feed mechanics built in."
						/>
					</div>
				</div>
			</section>

			{/* ───────────── Revenue Comparison ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">Keep more of what you earn</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						itch.io's revenue sharing is flexible—creators can set their own rate, even down to 0%.
						But the default is 10%, and many creators leave it there. Anthers takes a fundamentally
						different approach: your price is your revenue, always.
					</p>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-8">
						{/* itch.io receipt */}
						<div className="card bg-base-100">
							<div className="card-body">
								<h3 className="font-bold text-lg mb-1">itch.io</h3>
								<p className="text-xs text-base-content/40 mb-4">
									$10 game sale (default 10% share)
								</p>
								<div className="flex flex-col gap-2 text-sm">
									<ReceiptLine label="Sale price" amount="$10.00" />
									<ReceiptLine label="itch.io share (10%)" amount="-$1.00" negative />
									<ReceiptLine label="Payment processing" amount="-$0.59" negative />
									<div className="divider my-1" />
									<ReceiptLine label="Creator receives" amount="$8.41" bold />
								</div>
								<p className="text-xs text-base-content/40 mt-3">
									Creators can set their share to 0%, but the default is 10%.
								</p>
							</div>
						</div>

						{/* Anthers receipt */}
						<div className="card bg-base-100 ring-2 ring-primary/30">
							<div className="card-body">
								<h3 className="font-bold text-lg mb-1">Anthers</h3>
								<p className="text-xs text-base-content/40 mb-4">
									$10 game sale (transparent pass-through)
								</p>
								<div className="flex flex-col gap-2 text-sm">
									<ReceiptLine label="Game price (to creator)" amount="$10.00" bold />
									<ReceiptLine label="Infrastructure fee" amount="$0.01" />
									<ReceiptLine label="Anthers Foundation Fee (3%)" amount="$0.30" />
									<ReceiptLine label="Payment processing (2.9% + $0.30)" amount="$0.59" />
									<div className="divider my-1" />
									<ReceiptLine label="Buyer pays" amount="$10.90" />
									<div className="text-success font-semibold text-right">
										Creator receives $10.00
									</div>
								</div>
								<p className="text-xs text-base-content/40 mt-3">
									Costs are added on top, not subtracted from your earnings.
								</p>
							</div>
						</div>
					</div>
				</div>
			</section>

			{/* ───────────── Multi-Media ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">More than a game marketplace</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						itch.io is a fantastic game marketplace. Anthers is a home for every kind of creative
						work. If you make games <em>and</em> music, if you write devlogs <em>and</em> record
						podcasts—you don't need four platforms. You need one.
					</p>

					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
						<MediaCard
							icon={<PuzzlePieceIcon className="w-7 h-7" />}
							title="Games"
							color="badge-secondary"
							supported="both"
						/>
						<MediaCard
							icon={<FilmIcon className="w-7 h-7" />}
							title="Video"
							color="badge-error"
							supported="anthers"
						/>
						<MediaCard
							icon={<MusicalNoteIcon className="w-7 h-7" />}
							title="Audio"
							color="badge-success"
							supported="anthers"
						/>
						<MediaCard
							icon={<DocumentTextIcon className="w-7 h-7" />}
							title="Writing"
							color="badge-info"
							supported="anthers"
						/>
					</div>
				</div>
			</section>

			{/* ───────────── Feature Comparison Table ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-12">Feature by feature</h2>

					<div className="overflow-x-auto">
						<table className="table max-w-3xl mx-auto">
							<thead>
								<tr>
									<th>Feature</th>
									<th className="text-center">Anthers</th>
									<th className="text-center">itch.io</th>
								</tr>
							</thead>
							<tbody>
								<CompRow feature="Game hosting & downloads" anthers patreon />
								<CompRow feature="HTML5 web games" anthers patreon />
								<CompRow feature="Game jams" anthers patreon />
								<CompRow feature="Customizable project pages" anthers patreon />
								<CompRow feature="Ratings & comments" anthers patreon />
								<CompRow feature="Devlogs & posts" anthers patreon />
								<CompRow feature="Video hosting" anthers />
								<CompRow feature="Audio & music hosting" anthers />
								<CompRow feature="Long-form writing" anthers />
								<CompRow feature="Unified creator profile" anthers />
								<CompRow feature="Follow & feed system" anthers />
								<CompRow feature="100% to creator (default)" anthers />
								<CompRow feature="Adjustable revenue share" patreon />
								<CompRow feature="Transparent itemized fees" anthers />
								<CompRow feature="Subscription pool model" anthers />
								<CompRow feature="AT Protocol / data portability" anthers />
								<CompRow feature="Desktop client" patreon />
								<CompRow feature="Pay-what-you-want pricing" anthers patreon />
								<CompRow feature="Creator analytics" anthers patreon />
								<CompRow feature="Bundles" patreon />
							</tbody>
						</table>
					</div>
					<p className="text-center text-xs text-base-content/40 mt-6 max-w-xl mx-auto">
						itch.io has a mature, established feature set built over more than a decade. Some
						Anthers features listed above are actively in development. We're building in the open
						and shipping fast.
					</p>
				</div>
			</section>

			{/* ───────────── Data Portability ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">
						Your identity, your data, your choice
					</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						itch.io is a great place to publish, but your identity and content live on their
						servers. Anthers is built on the AT Protocol — the same open standard behind Bluesky—so
						your creator identity is a portable DID you truly own.
					</p>

					<div className="grid grid-cols-1 md:grid-cols-3 gap-8">
						<div className="text-center">
							<div className="w-12 h-12 rounded-full bg-info/15 flex items-center justify-center mx-auto mb-3">
								<LockOpenIcon className="w-6 h-6 text-info" />
							</div>
							<h3 className="font-semibold mb-1">Portable identity</h3>
							<p className="text-sm text-base-content/60">
								Your creator identity isn't locked to Anthers. It's a DID you own. If you leave,
								your identity goes with you.
							</p>
						</div>
						<div className="text-center">
							<div className="w-12 h-12 rounded-full bg-info/15 flex items-center justify-center mx-auto mb-3">
								<ArrowPathIcon className="w-6 h-6 text-info" />
							</div>
							<h3 className="font-semibold mb-1">Exportable content</h3>
							<p className="text-sm text-base-content/60">
								Your projects, posts, ratings, and interactions are stored as ATProto records. They
								belong to you structurally, not just by policy.
							</p>
						</div>
						<div className="text-center">
							<div className="w-12 h-12 rounded-full bg-info/15 flex items-center justify-center mx-auto mb-3">
								<GlobeAltIcon className="w-6 h-6 text-info" />
							</div>
							<h3 className="font-semibold mb-1">Federated future</h3>
							<p className="text-sm text-base-content/60">
								ATProto enables federation—other nodes can join the network, and content is
								interoperable across them.
							</p>
						</div>
					</div>
				</div>
			</section>

			{/* ───────────── Import ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-3xl text-center">
					<h2 className="text-3xl font-bold mb-4">Bring your itch.io projects with you</h2>
					<p className="text-base-content/60 max-w-2xl mx-auto mb-8 leading-relaxed">
						Already have projects on itch.io? Anthers's import tool can help you bring your project
						metadata over so you can get started quickly. You don't have to choose one or the
						other—publish on both, and let your audience find you wherever they prefer.
					</p>
					<div className="flex gap-4 justify-center flex-wrap">
						<Link
							to={isAuthenticated ? "/dashboard/import" : "/signup"}
							className="btn btn-primary"
						>
							Import from itch.io
						</Link>
						<Link to="/for-creators" className="btn btn-outline">
							Learn More About Anthers
						</Link>
					</div>
				</div>
			</section>

			{/* ───────────── CTA ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 text-center max-w-2xl">
					<h2 className="text-3xl font-bold mb-4">Ready to try something new?</h2>
					<p className="text-base-content/60 mb-8 leading-relaxed">
						Anthers is free to use. No platform cut, no hidden fees. Publish your work and keep 100%
						of what you earn. If you love itch.io, you'll love what comes next.
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

function DiffCard({
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
				<p className="text-sm text-base-content/60 leading-relaxed">{description}</p>
			</div>
		</div>
	);
}

function ReceiptLine({
	label,
	amount,
	bold,
	negative,
}: {
	label: string;
	amount: string;
	bold?: boolean;
	negative?: boolean;
}) {
	return (
		<div className={`flex justify-between ${bold ? "font-semibold" : "text-base-content/70"}`}>
			<span>{label}</span>
			<span className={negative ? "text-error" : ""}>{amount}</span>
		</div>
	);
}

function MediaCard({
	icon,
	title,
	color,
	supported,
}: {
	icon: React.ReactNode;
	title: string;
	color: string;
	supported: "both" | "anthers";
}) {
	return (
		<div className="card bg-base-200">
			<div className="card-body p-5 text-center">
				<div className="text-base-content/40 mx-auto mb-2">{icon}</div>
				<span className={`badge badge-sm ${color} mx-auto mb-2`}>{title}</span>
				{supported === "both" ? (
					<p className="text-xs text-base-content/50">
						<span className="text-success">✓</span> Anthers &{" "}
						<span className="text-success">✓</span> itch.io
					</p>
				) : (
					<p className="text-xs text-base-content/50">
						<span className="text-success">✓</span> Anthers only
					</p>
				)}
			</div>
		</div>
	);
}

function CompRow({
	feature,
	anthers,
	patreon,
}: {
	feature: string;
	anthers?: boolean;
	patreon?: boolean;
}) {
	const check = <span className="text-success font-bold">✓</span>;
	const dash = <span className="text-base-content/20">—</span>;
	return (
		<tr>
			<td>{feature}</td>
			<td className="text-center">{anthers ? check : dash}</td>
			<td className="text-center">{patreon ? check : dash}</td>
		</tr>
	);
}
