// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The "Anthers vs itch.io" comparison page — restyled into the Meadow design.
// Airy editorial forest-green, Fraunces display serif over Nunito Sans. The route
// wraps this page in <MeadowDecor> (pollen + woven side vines), so this file only
// styles the content: a tinted hero header, alternating Section bands, rounded
// cards, and the feature-comparison table. All copy and data are preserved
// verbatim from the original.

import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Card, Eyebrow, H2, Lede, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
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
	UserGroupIcon,
} from "@heroicons/react/24/outline";
import { Link } from "react-router-dom";

const serif = { fontFamily: FONTS.fraunces };

export default function CompareItchPage() {
	const { isAuthenticated } = useAuth();

	return (
		<div>
			{/* Hero */}
			<header className="bg-base-200/70">
				<div className="mx-auto max-w-5xl px-6 pt-24 pb-20 text-center">
					<Sprig className="mx-auto mb-5 h-11 w-11 text-primary/60" />
					<p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
						Anthers vs itch.io
					</p>
					<h1
						style={serif}
						className="text-balance text-5xl font-light leading-[1.05] tracking-tight sm:text-7xl"
					>
						Love itch.io?
						<br />
						<em className="font-medium text-primary not-italic">You'll feel right at home.</em>
					</h1>
					<p className="mx-auto mt-8 max-w-4xl text-lg leading-relaxed text-base-content/75">
						itch.io is a beloved platform that's done more for indie creators than almost anyone.
						Anthers builds on that same spirit — creator-first economics, open publishing, community
						game jams — and extends it with multi-media support, transparent pricing, and data
						portability.
					</p>
					<div className="mt-9 flex flex-wrap justify-center gap-3">
						<Link
							to={isAuthenticated ? "/dashboard" : "/signup"}
							className="btn btn-primary rounded-full px-8"
						>
							Try Anthers Free
						</Link>
						<Link
							to="/discover"
							className="btn btn-outline rounded-full border-base-content/20 px-7"
						>
							Explore Projects
						</Link>
					</div>
					<BrandGlyph name="divider-botanical" className="mt-10 h-14 w-52 text-primary/45" />
				</div>
			</header>

			{/* Respectful positioning */}
			<Section>
				<Eyebrow>Shared roots</Eyebrow>
				<H2>Standing on the shoulders of a great platform</H2>
				<Lede>
					itch.io pioneered creator-friendly game distribution. They proved that a platform could
					put creators first—with open publishing, flexible revenue sharing, customizable pages, and
					a vibrant community of game jams. Millions of indie games have found their audience
					because itch.io exists.
				</Lede>
				<p className="mx-auto mt-6 max-w-4xl text-lg leading-relaxed text-base-content/65">
					Anthers aims to carry that mission forward and expand it. We believe creators deserve 100%
					of their earnings, support for every medium they work in, and true ownership of their
					identity and data. If itch.io is the place that showed the world what indie game
					distribution could be, Anthers is our attempt to build the next chapter—for games, videos,
					music, and writing all in one place.
				</p>
			</Section>

			{/* Key differences */}
			<Section tint>
				<Eyebrow>The difference</Eyebrow>
				<H2>What Anthers does differently</H2>
				<div className="mx-auto mt-14 grid max-w-5xl gap-x-12 gap-y-10 text-left md:grid-cols-2">
					<DiffCard
						icon={<CurrencyDollarIcon className="h-6 w-6" />}
						title="100% to creators—no revenue share"
						description="itch.io defaults to a 10% revenue share (which creators can adjust, even to 0%). Anthers never takes a percentage. Your price is your revenue. Infrastructure and payment processing costs are shown as transparent line items to the buyer—never subtracted from your earnings."
					/>
					<DiffCard
						icon={<GlobeAltIcon className="h-6 w-6" />}
						title="One home for every medium"
						description="itch.io is primarily built for games. If you also make videos, music, or written content, you need separate platforms. Anthers gives you one profile, one audience, and one URL for everything you create—games, devlogs, soundtracks, essays, and more."
					/>
					<DiffCard
						icon={<EyeIcon className="h-6 w-6" />}
						title="Transparent, itemized pricing"
						description="On itch.io, the platform's share is deducted from your sale. On Anthers, every cost is itemized at checkout—payment processing, infrastructure, and the Anthers Foundation. Buyers see exactly where their money goes. Creators receive exactly what they charged."
					/>
					<DiffCard
						icon={<LockOpenIcon className="h-6 w-6" />}
						title="Built on open protocols"
						description="Anthers is built on the AT Protocol (the same standard behind Bluesky). Your identity is a portable DID you own. Your content is stored as interoperable records. If you ever leave, your data goes with you—not by policy, but by design."
					/>
					<DiffCard
						icon={<UserGroupIcon className="h-6 w-6" />}
						title="Subscription model that funds creators"
						description="Beyond individual sales, Anthers offers a subscription pool where subscriber payments are distributed to creators based on actual watch-time—what people play, watch, read, and listen to. It's a new revenue stream that rewards engagement, not just transactions."
					/>
					<DiffCard
						icon={<ChartBarIcon className="h-6 w-6" />}
						title="Unified creator dashboard"
						description="Manage all your projects, posts, analytics, and audience from one place. itch.io's dashboard is focused on game sales and analytics. Anthers's dashboard covers your entire creative output—games, posts, audio, video—with follow and feed mechanics built in."
					/>
				</div>
			</Section>

			{/* Revenue comparison */}
			<Section>
				<Eyebrow>The economics</Eyebrow>
				<H2>Keep more of what you earn</H2>
				<Lede>
					itch.io's revenue sharing is flexible—creators can set their own rate, even down to 0%.
					But the default is 10%, and many creators leave it there. Anthers takes a fundamentally
					different approach: your price is your revenue, always.
				</Lede>
				<div className="mx-auto mt-12 grid max-w-4xl gap-6 text-left md:grid-cols-2">
					{/* itch.io receipt */}
					<Card>
						<h3 style={serif} className="mb-1 text-lg font-medium">
							itch.io
						</h3>
						<p className="mb-4 text-xs text-base-content/45">$10 game sale (default 10% share)</p>
						<div className="flex flex-col gap-2 text-sm">
							<ReceiptLine label="Sale price" amount="$10.00" />
							<ReceiptLine label="itch.io share (10%)" amount="-$1.00" negative />
							<ReceiptLine label="Payment processing" amount="-$0.59" negative />
							<div className="my-1 border-t border-base-content/10" />
							<ReceiptLine label="Creator receives" amount="$8.41" bold />
						</div>
						<p className="mt-3 text-xs text-base-content/45">
							Creators can set their share to 0%, but the default is 10%.
						</p>
					</Card>

					{/* Anthers receipt */}
					<Card className="ring-1 ring-primary/20">
						<h3 style={serif} className="mb-1 text-lg font-medium">
							Anthers
						</h3>
						<p className="mb-4 text-xs text-base-content/45">
							$10 game sale (transparent pass-through)
						</p>
						<div className="flex flex-col gap-2 text-sm">
							<ReceiptLine label="Game price (to creator)" amount="$10.00" bold />
							<ReceiptLine label="Delivery bandwidth (~1 GiB, at cost)" amount="$0.01" />
							<ReceiptLine label="Anthers Foundation fee (Digital AFF)" amount="$0.005" />
							<ReceiptLine label="Payment processing (2.9% + $0.30)" amount="$0.59" />
							<div className="my-1 border-t border-base-content/10" />
							<ReceiptLine label="Buyer pays" amount="$10.61" />
							<div className="text-right font-semibold text-primary">Creator receives $10.00</div>
						</div>
						<p className="mt-3 text-xs text-base-content/45">
							Anthers keeps $0. The Foundation fee on a digital download is half the delivery
							bandwidth—a fraction of a cent. Costs are added on top, never subtracted from your
							earnings.
						</p>
					</Card>
				</div>
			</Section>

			{/* Multi-media */}
			<Section tint>
				<Eyebrow>Every medium</Eyebrow>
				<H2>More than a game marketplace</H2>
				<Lede>
					itch.io is a fantastic game marketplace. Anthers is a home for every kind of creative
					work. If you make games <em>and</em> music, if you write devlogs <em>and</em> record
					podcasts—you don't need four platforms. You need one.
				</Lede>
				<div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
					<MediaCard
						icon={<PuzzlePieceIcon className="h-7 w-7" />}
						title="Games"
						supported="both"
					/>
					<MediaCard icon={<FilmIcon className="h-7 w-7" />} title="Video" supported="anthers" />
					<MediaCard
						icon={<MusicalNoteIcon className="h-7 w-7" />}
						title="Audio"
						supported="anthers"
					/>
					<MediaCard
						icon={<DocumentTextIcon className="h-7 w-7" />}
						title="Writing"
						supported="anthers"
					/>
				</div>
			</Section>

			{/* Feature comparison table */}
			<Section>
				<Eyebrow>Side by side</Eyebrow>
				<H2>Feature by feature</H2>
				<Card className="mx-auto mt-12 max-w-3xl overflow-x-auto">
					<table className="table">
						<thead>
							<tr className="border-base-content/10">
								<th style={serif} className="font-medium">
									Feature
								</th>
								<th style={serif} className="text-center font-medium">
									Anthers
								</th>
								<th style={serif} className="text-center font-medium">
									itch.io
								</th>
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
				</Card>
				<p className="mx-auto mt-6 max-w-xl text-xs leading-relaxed text-base-content/45">
					itch.io has a mature, established feature set built over more than a decade. Some Anthers
					features listed above are actively in development. We're building in the open and shipping
					fast.
				</p>
			</Section>

			{/* Data portability */}
			<Section tint>
				<Eyebrow>Ownership</Eyebrow>
				<H2>Your identity, your data, your choice</H2>
				<Lede>
					itch.io is a great place to publish, but your identity and content live on their servers.
					Anthers is built on the AT Protocol — the same open standard behind Bluesky—so your
					creator identity is a portable DID you truly own.
				</Lede>
				<div className="mx-auto mt-14 grid max-w-4xl gap-8 text-left sm:grid-cols-3">
					<PortabilityPoint icon={<LockOpenIcon className="h-6 w-6" />} title="Portable identity">
						Your creator identity isn't locked to Anthers. It's a DID you own. If you leave, your
						identity goes with you.
					</PortabilityPoint>
					<PortabilityPoint icon={<ArrowPathIcon className="h-6 w-6" />} title="Exportable content">
						Your projects, posts, ratings, and interactions are stored as ATProto records. They
						belong to you structurally, not just by policy.
					</PortabilityPoint>
					<PortabilityPoint icon={<GlobeAltIcon className="h-6 w-6" />} title="Federated future">
						ATProto enables federation—other nodes can join the network, and content is
						interoperable across them.
					</PortabilityPoint>
				</div>
			</Section>

			{/* Import */}
			<Section>
				<Eyebrow>Come on over</Eyebrow>
				<H2>Bring your itch.io projects with you</H2>
				<Lede>
					Already have projects on itch.io? Anthers's import tool can help you bring your project
					metadata over so you can get started quickly. You don't have to choose one or the
					other—publish on both, and let your audience find you wherever they prefer.
				</Lede>
				<div className="mt-9 flex flex-wrap justify-center gap-3">
					<Link
						to={isAuthenticated ? "/dashboard/import" : "/signup"}
						className="btn btn-primary rounded-full px-7"
					>
						Import from itch.io
					</Link>
					<Link
						to="/for-creators"
						className="btn btn-outline rounded-full border-base-content/20 px-7"
					>
						Learn More About Anthers
					</Link>
				</div>
			</Section>

			{/* Closing */}
			<section className="bg-base-200/70">
				<div className="mx-auto max-w-6xl px-6 py-28 text-center">
					<Sprig className="mx-auto mb-6 h-14 w-14 text-primary/70" />
					<h2 style={serif} className="text-balance text-4xl font-light leading-tight sm:text-5xl">
						Ready to try something new?
					</h2>
					<p className="mx-auto mt-5 max-w-4xl text-lg leading-relaxed text-base-content/70">
						Anthers is free to use. No platform cut, no hidden fees. Publish your work and keep 100%
						of what you earn. If you love itch.io, you'll love what comes next.
					</p>
					<div className="mt-8 flex flex-wrap justify-center gap-3">
						<Link
							to={isAuthenticated ? "/dashboard" : "/signup"}
							className="btn btn-primary rounded-full px-7"
						>
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
		</div>
	);
}

// ─── Local building blocks (page-specific; shared editorial primitives —
//     Section/Eyebrow/H2/Lede/Card — come from @anthers/web-shared/decor/sections) ───

/** An icon + heading + body point in the "what Anthers does differently" grid. */
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

/** A label + amount line in a comparison receipt. */
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
			<span className={`font-mono tabular-nums ${negative ? "text-error" : ""}`}>{amount}</span>
		</div>
	);
}

/** A medium card in the "more than a game marketplace" grid. */
function MediaCard({
	icon,
	title,
	supported,
}: {
	icon: React.ReactNode;
	title: string;
	supported: "both" | "anthers";
}) {
	return (
		<Card className="text-center">
			<div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
				{icon}
			</div>
			<h3 style={serif} className="mb-2 text-base font-medium">
				{title}
			</h3>
			{supported === "both" ? (
				<p className="text-xs text-base-content/55">
					<span className="text-primary">✓</span> Anthers & <span className="text-primary">✓</span>{" "}
					itch.io
				</p>
			) : (
				<p className="text-xs text-base-content/55">
					<span className="text-primary">✓</span> Anthers only
				</p>
			)}
		</Card>
	);
}

/** A ✓/– row in the feature-comparison table (`patreon` = the itch.io column). */
function CompRow({
	feature,
	anthers,
	patreon,
}: {
	feature: string;
	anthers?: boolean;
	patreon?: boolean;
}) {
	const check = <span className="font-bold text-primary">✓</span>;
	const dash = <span className="text-base-content/20">—</span>;
	return (
		<tr className="border-base-content/10">
			<td>{feature}</td>
			<td className="bg-primary/5 text-center">{anthers ? check : dash}</td>
			<td className="text-center">{patreon ? check : dash}</td>
		</tr>
	);
}

/** An icon + heading + body point in the data-portability trio. */
function PortabilityPoint({
	icon,
	title,
	children,
}: {
	icon: React.ReactNode;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div>
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
