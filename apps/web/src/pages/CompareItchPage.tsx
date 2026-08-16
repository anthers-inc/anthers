// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The "Anthers vs itch.io" comparison page — restyled into the Meadow design.
// Airy editorial forest-green, Fraunces display serif over Nunito Sans. The route
// wraps this page in <MeadowDecor> (pollen + woven side vines), so this file only
// styles the content: a tinted hero header, alternating Section bands, rounded
// cards, and the feature-comparison table.
//
// Every money figure here derives from SALE_TABLE. The restyle preserved the copy
// verbatim, which is how three hand-typed $9.40s rode through it; the sale figures
// are read from the model now, and the buyer's first download is no longer a
// deduction anywhere (retired 2026-08-12 with the per-GiB charge).

import { SALE_TABLE } from "@anthers/shared/figures";
import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Card, Eyebrow, H2, Lede, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link } from "@anthers/web-shared/router";
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

const serif = { fontFamily: FONTS.fraunces };

/**
 * The $10 sale both receipts are built from — derived, never typed. See
 * `scripts/econ-figures.ts`; a hand-typed $9.40 sat on this page in three places for
 * months, and survived the sweep that retired the charge it was built from.
 *
 * itch.io's column quotes the same `cardFee` on purpose: every platform pays the same
 * card cost, and 63.01 § Comparisons requires all-in against all-in. Only their
 * revenue share is theirs.
 */
const GAME_10 = SALE_TABLE.find((r) => r.label === "game-10-1gib")!;
const ITCH_SHARE = (Number(GAME_10.price) * 0.1).toFixed(2);
const ITCH_RECEIVES = (
	Number(GAME_10.price) -
	Number(ITCH_SHARE) -
	Number(GAME_10.cardFee)
).toFixed(2);

export default function CompareItchPage() {
	const { isAuthenticated } = useAuth();

	return (
		<div>
			{/* Hero */}
			<header className="bg-base-200/70">
				<div className="mx-auto max-w-5xl px-6 pt-24 pb-20 text-center">
					<Reveal>
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
					</Reveal>
					<Reveal delay={150}>
						<p className="mx-auto mt-8 max-w-4xl text-lg leading-relaxed text-base-content/75">
							itch.io is a beloved platform that's done more for indie creators than almost anyone.
							Anthers builds on that same spirit — creator-first economics, open publishing — and
							extends it with multi-media support, transparent pricing, and data portability.
						</p>
					</Reveal>
					<Reveal delay={300}>
						<div className="mt-9 flex flex-wrap justify-center gap-3">
							<Link
								to={isAuthenticated ? "/dashboard" : "/signup"}
								className="btn btn-primary rounded-full px-8"
							>
								Try Anthers Free
							</Link>
						</div>
						<BrandGlyph
							name="divider-botanical"
							className="-mb-20 -mt-5 h-24 w-52 text-primary/45"
						/>
					</Reveal>
				</div>
			</header>

			{/* Respectful positioning */}
			<Section>
				<Reveal>
					<Eyebrow>Shared roots</Eyebrow>
					<H2>Standing on the shoulders of a great platform</H2>
					<Lede>
						itch.io pioneered creator-friendly game distribution. They proved that a platform could
						put creators first—with open publishing, flexible revenue sharing, customizable pages,
						and a vibrant community of game jams. Millions of indie games have found their audience
						because itch.io exists.
					</Lede>
					<p className="mx-auto mt-6 max-w-4xl text-lg leading-relaxed text-base-content/65">
						Anthers aims to carry that mission forward and expand it. We believe no platform should
						take a cut of a creator's earnings, that every medium a creator works in deserves
						support, and that identity and data should genuinely belong to them. If itch.io is the
						place that showed the world what indie game distribution could be, Anthers is our
						attempt to build the next chapter—for games, videos, music, and writing all in one
						place.
					</p>
				</Reveal>
			</Section>

			{/* Key differences */}
			<Section tint>
				<Reveal>
					<Eyebrow>The difference</Eyebrow>
					<H2>What Anthers does differently</H2>
				</Reveal>
				<div className="mx-auto mt-14 grid max-w-5xl gap-x-12 gap-y-10 text-left md:grid-cols-2">
					<Reveal delay={0}>
						<DiffCard
							icon={<CurrencyDollarIcon className="h-6 w-6" />}
							title="0% platform fee—no revenue share"
							description={`itch.io defaults to a 10% revenue share (which creators set themselves, anywhere from 0% to 100%). Anthers never takes a percentage at all. The only deduction from your price is a cost paid to a third party—card processing—itemized in full. On a $${GAME_10.price} game that is $${GAME_10.creatorReceives} to you, whatever the download size.`}
						/>
					</Reveal>
					<Reveal delay={100}>
						<DiffCard
							icon={<GlobeAltIcon className="h-6 w-6" />}
							title="One home for every medium"
							description="itch.io is primarily built for games. If you also make videos, music, or written content, you need separate platforms. Anthers gives you one profile, one audience, and one URL for everything you create—games, devlogs, soundtracks, essays, and more."
						/>
					</Reveal>
					<Reveal delay={200}>
						<DiffCard
							icon={<EyeIcon className="h-6 w-6" />}
							title="Transparent, itemized pricing"
							description="On itch.io, the platform's share is deducted from your sale. On Anthers there is no platform share at all — the only deduction is card processing, at cost and itemized. Buyers see exactly where their money goes."
						/>
					</Reveal>
					<Reveal delay={300}>
						<DiffCard
							icon={<LockOpenIcon className="h-6 w-6" />}
							title="Open, and yours to leave"
							description="The whole platform is open source under the AGPL, and you can download everything you've made in one click. Hosting with Anthers is meant to be a convenience, never a requirement. You can link your Bluesky identity today; federation is a direction we're committed to, not something we've shipped."
						/>
					</Reveal>
					<Reveal delay={400}>
						<DiffCard
							icon={<UserGroupIcon className="h-6 w-6" />}
							title="Subscription model that funds creators"
							description="Beyond individual sales, Anthers offers a subscription pool where subscriber payments are distributed to creators based on actual time spent—what people play, watch, read, and listen to. It's a new revenue stream that rewards engagement, not just transactions."
						/>
					</Reveal>
					<Reveal delay={500}>
						<DiffCard
							icon={<ChartBarIcon className="h-6 w-6" />}
							title="Unified creator dashboard"
							description="Manage all your projects, posts, analytics, and audience from one place. itch.io's dashboard is focused on game sales and analytics. Anthers' dashboard covers your entire creative output—games, posts, audio, video—with follow and feed mechanics built in."
						/>
					</Reveal>
				</div>
			</Section>

			{/* Revenue comparison */}
			<Section>
				<Reveal>
					<Eyebrow>The economics</Eyebrow>
					<H2>Keep more of what you earn</H2>
					<Lede>
						itch.io's revenue sharing is flexible—creators can set their own rate, even down to 0%.
						But the default is 10%, and many creators leave it there. Anthers takes a fundamentally
						different approach: your price is your revenue, always.
					</Lede>
				</Reveal>
				<div className="mx-auto mt-12 grid max-w-4xl gap-6 text-left md:grid-cols-2">
					{/* itch.io receipt */}
					<Reveal delay={0} className="h-full">
						<Card className="h-full">
							<h3 style={serif} className="mb-1 text-lg font-medium">
								itch.io
							</h3>
							<p className="mb-4 text-xs text-base-content/45">$10 game sale (default 10% share)</p>
							<div className="flex flex-col gap-2 text-sm">
								<ReceiptLine label="Sale price" amount={`$${GAME_10.price}`} />
								{/* econ:allow — itch.io's own revenue share, not one of our figures */}
								<ReceiptLine label="itch.io share (10%)" amount={`-$${ITCH_SHARE}`} negative />
								<ReceiptLine label="Payment processing" amount={`-$${GAME_10.cardFee}`} negative />
								<div className="my-1 border-t border-base-content/10" />
								<ReceiptLine label="Creator receives" amount={`$${ITCH_RECEIVES}`} bold />
							</div>
							<p className="mt-3 text-xs text-base-content/45">
								Creators can set their share to 0%, but the default is 10%.
							</p>
						</Card>
					</Reveal>

					{/* Anthers receipt */}
					<Reveal delay={110} className="h-full">
						<Card className="ring-1 ring-primary/20 h-full">
							<h3 style={serif} className="mb-1 text-lg font-medium">
								Anthers
							</h3>
							<p className="mb-4 text-xs text-base-content/45">$10 game sale (0% platform fee)</p>
							<div className="flex flex-col gap-2 text-sm">
								<ReceiptLine label="Sale price" amount={`$${GAME_10.price}`} />
								<ReceiptLine label="Anthers share" amount="-$0.00" />
								<ReceiptLine
									label="Payment processing (2.9% + $0.30)"
									amount={`-$${GAME_10.cardFee}`}
									negative
								/>
								<ReceiptLine label="Delivery (unlimited, any size)" amount="$0.00" />
								<div className="my-1 border-t border-base-content/10" />
								<ReceiptLine label="Creator receives" amount={`$${GAME_10.creatorReceives}`} bold />
							</div>
							<p className="mt-3 text-xs text-base-content/45">
								Anthers keeps nothing. The one deduction is the card processing every platform pays,
								to a third party. Downloads are free at any size, on any number of devices, forever.
								The buyer pays ${GAME_10.price}, plus any applicable tax.
							</p>
						</Card>
					</Reveal>
				</div>
			</Section>

			{/* Multi-media */}
			<Section tint>
				<Reveal>
					<Eyebrow>Every medium</Eyebrow>
					<H2>More than a game marketplace</H2>
					<Lede>
						itch.io is a fantastic game marketplace. Anthers is a home for every kind of creative
						work. If you make games <em>and</em> music, if you write devlogs <em>and</em> record
						podcasts—you don't need four platforms. You need one.
					</Lede>
				</Reveal>
				<div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
					<Reveal delay={0} className="h-full">
						<MediaCard
							icon={<PuzzlePieceIcon className="h-7 w-7" />}
							title="Games"
							supported="both"
						/>
					</Reveal>
					<Reveal delay={100} className="h-full">
						<MediaCard icon={<FilmIcon className="h-7 w-7" />} title="Video" supported="anthers" />
					</Reveal>
					<Reveal delay={200} className="h-full">
						<MediaCard
							icon={<MusicalNoteIcon className="h-7 w-7" />}
							title="Audio"
							supported="anthers"
						/>
					</Reveal>
					<Reveal delay={300} className="h-full">
						<MediaCard
							icon={<DocumentTextIcon className="h-7 w-7" />}
							title="Writing"
							supported="anthers"
						/>
					</Reveal>
				</div>
			</Section>

			{/* Feature comparison table */}
			<Section>
				<Reveal>
					<Eyebrow>Side by side</Eyebrow>
					<H2>Feature by feature</H2>
				</Reveal>
				<Reveal>
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
								<CompRow feature="Customizable project pages" anthers patreon />
								<CompRow feature="Ratings & comments" anthers patreon />
								<CompRow feature="Devlogs & posts" anthers patreon />
								<CompRow feature="Video hosting" anthers />
								<CompRow feature="Audio & music hosting" anthers />
								<CompRow feature="Long-form writing" anthers />
								<CompRow feature="Unified creator profile" anthers />
								<CompRow feature="Follow & feed system" anthers />
								<CompRow feature="0% platform fee (always)" anthers />
								<CompRow feature="Adjustable revenue share" patreon />
								<CompRow feature="Transparent itemized fees" anthers />
								<CompRow feature="Subscription pool model" anthers />
								{/* Identity LINKING is what ships — OAuth against a Bluesky PDS. Record sync,
								    lexicons and federation are deferred (41.01), so the row names the live
								    thing rather than the protocol it might one day sit on. */}
								<CompRow feature="Bluesky identity linking" anthers />
								<CompRow feature="Desktop client" patreon />
								{/* 🚨 Ours was checked here until 2026-08-16 and **we have never had it**.
								    `resolvePurchase` charges the stored `access.price` and the checkout call
								    sends no amount at all, so there is nothing a buyer could pay more with.
								    itch genuinely does have it, so the row stays and the ✓ moves — 63.01
								    § Comparisons requires conceding where we lose, and deleting the row
								    would concede by omission.
								    econ:allow — credits itch.io, not us; `patreon` is the itch column */}
								<CompRow feature="Pay-what-you-want pricing" patreon />
								<CompRow feature="Creator analytics" anthers patreon />
								<CompRow feature="Bundles" patreon />
							</tbody>
						</table>
					</Card>
				</Reveal>
				<Reveal>
					<p className="mx-auto mt-6 max-w-xl text-xs leading-relaxed text-base-content/45">
						itch.io has a mature, established feature set built over more than a decade. Some
						Anthers features listed above are actively in development. We're building in the open
						and shipping fast.
					</p>
				</Reveal>
			</Section>

			{/* Data portability */}
			<Section tint>
				<Reveal>
					<Eyebrow>Ownership</Eyebrow>
					<H2>Your identity, your data, your choice</H2>
					<Lede>
						itch.io is a great place to publish, but leaving a platform usually means leaving your
						work behind. Anthers is open source under the AGPL, and everything you make is one click
						from a file on your own machine.
					</Lede>
				</Reveal>
				<div className="mx-auto mt-14 grid max-w-4xl gap-8 text-left sm:grid-cols-3">
					{/*
					 * 🚨 This section claimed content was "stored as ATProto records" and identity
					 * was "a portable DID you truly own". Neither ships: `atproto_uri` columns are
					 * future-proofing and sit unpopulated, and what exists is Bluesky identity
					 * LINKING (41.01). The replacement is not weaker — it is two things that are
					 * actually true and testable today, plus a promise kept in the future tense.
					 */}
					<Reveal delay={0}>
						<PortabilityPoint
							icon={<ArrowPathIcon className="h-6 w-6" />}
							title="Take your work with you"
						>
							One button in Settings and you get a file with everything you've made — works, posts,
							purchases, the lot. Today, not eventually.
						</PortabilityPoint>
					</Reveal>
					<Reveal delay={110}>
						<PortabilityPoint icon={<LockOpenIcon className="h-6 w-6" />} title="Open source">
							The whole platform is AGPL-3.0. Hosting with us is meant to be a convenience rather
							than a requirement — and a licence is a harder promise to walk back than a policy.
						</PortabilityPoint>
					</Reveal>
					<Reveal delay={220}>
						<PortabilityPoint icon={<GlobeAltIcon className="h-6 w-6" />} title="Federation, later">
							Linking your Bluesky identity works today. Running your own node, and federating
							between them, is a direction we're committed to — we haven't built it yet, and we'd
							rather say so.
						</PortabilityPoint>
					</Reveal>
				</div>
			</Section>

			{/* Import */}
			<Section>
				<Reveal>
					<Eyebrow>Come on over</Eyebrow>
					<H2>Bring your itch.io projects with you</H2>
					<Lede>
						Already have projects on itch.io? Anthers' import tool can help you bring your project
						metadata over so you can get started quickly. You don't have to choose one or the
						other—publish on both, and let your audience find you wherever they prefer.
					</Lede>
				</Reveal>
				<Reveal delay={120}>
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
				</Reveal>
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
							Ready to try something new?
						</h2>
						<p className="mx-auto mt-5 max-w-4xl text-lg leading-relaxed text-base-content/70">
							Anthers is free to use, and takes a 0% cut of your sales—a ${GAME_10.price} game
							returns ${GAME_10.creatorReceives} to you whatever its size, the rest being card
							processing, at cost. If you love itch.io, you'll love what comes next.
						</p>
						<div className="mt-8 flex flex-wrap justify-center gap-3">
							<Link
								to={isAuthenticated ? "/dashboard" : "/signup"}
								className="btn btn-primary rounded-full px-7"
							>
								Create Your Account
							</Link>
						</div>
					</Reveal>
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
		<Card className="text-center card-lift h-full">
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
