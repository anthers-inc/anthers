// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The For Creators marketing page — restyled into the Meadow design (matching
// /for-users). Airy editorial forest-green, Fraunces display serif over Nunito
// Sans, wrapped in the shared <MeadowDecor> (pollen + woven side vines); the
// shared LoggedOutLayout supplies the Meadow footer + grassy floor.
//
// Copy tracks the SUPPORT MODEL (which superseded the V4 "Badge plans"): one primitive,
// a monthly amount, pointed either at a creator (no platform cut, clearing that creator's
// gates at whatever amounts they set) or at Anthers (half into the Time Pool and a
// remainder funding free access and the charitable programs). A fan's Badge IS the amount
// they give Anthers (Root → Blossom = $3 → $12, "+" beyond). ⚠️ The **$3 Seed unit retired
// 2026-08-16** — there is no unit and no granularity floor, so never write a level as a
// count of anything. There is no bandwidth line either: delivery costs $0 at any volume,
// so downloads are unlimited and free on both sides.
//
// 🚨 Corrected 2026-08-14 — this page sold **Anthers Gates**, retired 2026-08-12. There
// is one gate primitive and it points only at you: your work is behind one of YOUR gates
// or it is Public Access, with no Badge threshold in between, and a fan's Anthers Badge
// opens nothing. What support for Anthers does is lift that fan's monthly Public Access
// limit (at the Public Access price) and grow their Time Pool (at every level). The free tier is bounded —
// FREE_PUBLIC_ACCESS_HOURS a month — so never write streaming as unlimited for everyone.
//
// The creator-side through-line, and why the page is sequenced the way it is:
// ① direct support (what fans give you + direct sales) carries no platform cut — the
// wedge, and where the 0%-cut claim is unconditionally true; ② the commons (the
// Time Pool, by time) pays for the work Anthers distributes for you. The
// distributor-pays rule ties them together: whoever distributes a piece of work is
// who pays for it. Streaming is deliberately NOT pitched as out-earning YouTube or
// Spotify per hour — its value is at-cost reach.
//
// Anthers figures derive from @anthers/shared/constants (never hardcoded); competitor
// figures are rough public estimates (illustrative). Claims follow the Copy Style
// Guide (63.01): "0% cut" is now unconditionally true of EVERY creator transaction,
// but "100% to the creator" is RETIRED (2026-08-03) — the at-cost card fee comes out
// of the price. Where a cut and a price appear together the take-home figure must
// appear with them, or a reader concludes the creator gets the whole list price.
// "non-profit", never "501(c)(3)", until the IRS determination letter lands.
//
// Section flow: a brief "The problem" (what's wrong across every kind of platform)
// sets up "The solution" — an interactive matrix (how a fan supports you × the
// medium) showing what reaches the creator vs. the platform on Anthers and
// elsewhere — then "How you get paid" spells out the two channels.

import {
	BADGE_ORDER,
	badgeLabel,
	CARD_FLAT,
	CARD_RATE,
	cardFeeDisplay,
	FREE_STORAGE_GIB,
	PUBLIC_ACCESS_PRICE,
	thresholdForBadge,
	timePoolFor,
} from "@anthers/shared/constants";
import { SALE_TABLE } from "@anthers/shared/figures";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { MeadowDecor } from "@anthers/web-shared/decor/MeadowDecor";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Card, Eyebrow, H2, Lede, Section, SignpostCard } from "@anthers/web-shared/decor/sections";
import { BADGE_ART } from "@anthers/web-shared/economics";
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
	LockClosedIcon,
	MusicalNoteIcon,
	PaintBrushIcon,
	PuzzlePieceIcon,
	ServerStackIcon,
	ShieldCheckIcon,
	ShoppingBagIcon,
	Squares2X2Icon,
	StarIcon,
	UserGroupIcon,
} from "@heroicons/react/24/outline";
import { useState } from "react";

const serif = { fontFamily: FONTS.fraunces };

/** Whole dollars render bare ($6); fractional amounts keep cents ($1.50). */
const fmtMoney = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

export default function ForCreatorsPage() {
	const { isAuthenticated } = useAuth();
	// /subscribe is the one signup door since 2026-08-17 — /signup is now only a
	// redirect to it, and a hop through a redirect is not better than a direct link.
	const startHref = isAuthenticated ? "/dashboard" : "/subscribe";

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
							Anthers is Patreon, Bandcamp, Steam, and itch in one place—games, videos, music, and
							writing under one roof, one identity, one audience. Anthers takes <strong>0%</strong>{" "}
							of every dollar given to you and every sale — no cut, no skim. The only thing that
							ever comes out is the at-cost card processing, and that goes to the processor.
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

			{/* The solution — 0% cut on support and sales; explore the economics live */}
			<Section tint>
				<Reveal>
					<Eyebrow>The solution</Eyebrow>
					<H2>When someone pays you, that's what you get paid.</H2>
					<Lede>
						What a fan gives you and anything they buy from you carry no platform cut at all—no fee,
						no skim, nothing to us. Streaming is the other side: it makes your work discoverable,
						served at cost, and pays you from the Time Pool for the time people spend with it.
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
								<ReceiptLine
									label="Listed price — what the buyer pays"
									amount={`$${SALE_10_2GIB.price}`}
									bold
								/>
								<ReceiptLine
									label={`Payment processing (${(CARD_RATE * 100).toFixed(1)}% + $${CARD_FLAT.toFixed(2)})`}
									amount={`−$${SALE_10_2GIB.cardFee}`}
								/>
								<ReceiptLine
									label={`Delivery (unlimited downloads, ${SALE_10_2GIB.sizeGiB} GiB or 200)`}
									amount="−$0.00"
								/>
								<ReceiptLine label="Anthers" amount="−$0.00" />
								<div className="my-1 border-t border-base-content/10" />
								<ReceiptLine label="You receive" amount={`$${SALE_10_2GIB.creatorReceives}`} bold />
							</div>
							<p className="mt-3 text-xs text-base-content/45">
								The buyer pays your listed price plus sales tax and nothing else. The one thing that
								comes out of it goes to the payment processor — never a cent to us.
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
								title="No fee on your sales"
							>
								Anthers takes <strong>nothing</strong> from a sale or from monthly support. The only
								charge that touches a creator is half again on your storage past the free{" "}
								{FREE_STORAGE_GIB} GiB — your own infrastructure, opt-in, and nothing to do with
								what you sell. Free access and the charitable programs are funded by what's left of
								a fan's monthly support to Anthers after the Time Pool and the card cost, and by
								lean operations—Anthers itself never profits.
							</PricePoint>
						</div>
					</Reveal>
				</div>
				<div className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-3">
					<Reveal delay={0} className="h-full">
						<PricingOption title="Free">
							No charge—anyone can download it or play it in the browser, as many times as they
							like. Great for jam entries, demos, and open-source projects.
						</PricingOption>
					</Reveal>
					<Reveal delay={110} className="h-full">
						{/* 🚨 This card said "Pay What You Want" until 2026-08-16 and we have never built
						    it — `resolvePurchase` charges the stored price and the checkout call sends no
						    amount at all, so there was nothing behind the card. Replaced rather than
						    deleted: the third option is real and shipped, and a two-card row in a
						    three-column grid reads as something missing. */}
						<PricingOption title="Badge Access">
							Open it to supporters at a Badge level you set—any monthly amount you choose. The same
							work can carry a purchase price alongside it; a supporter at that level simply doesn't
							need to pay it.
						</PricingOption>
					</Reveal>
					<Reveal delay={220} className="h-full">
						<PricingOption title="Fixed Price">
							Set the price a buyer sees, and we show you exactly what you'll receive. The only
							deduction is the at-cost card processing—paid to a third party, not to us. Downloads
							are free, at any size.
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
							features={["Multi-platform downloads", "Web game embedding", "Build variants"]}
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
							// ⚠️ "Game jam entry?" sat in this list until 2026-08-17. Jams were retired
							// tables and all (migration 0037), so a feed item type named after them
							// claims a feature Anthers doesn't have — the distinction the retirement
							// sweep drew is that a jam existing *in the world* is still true (a creator
							// may upload work made for Ludum Dare) while Anthers *providing* one is not,
							// and a list of things that "show up in your timeline" is the second sense.
							description="Follow creators you care about and get their updates in a personalized feed. New project? Devlog post? A track, a chapter, a new build? It all shows up in one timeline."
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

			{/* How you get paid — the support model's two channels, creator-side */}
			<Section>
				<Reveal>
					<Eyebrow>How you get paid</Eyebrow>
					<H2>Two ways money reaches you</H2>
					<Lede>
						There's one thing to support on Anthers: a{" "}
						<strong className="font-semibold text-base-content/80">monthly amount</strong>, at
						whatever levels you set. A fan points it at you—and we take no cut of it—or at Anthers,
						where part of it becomes the Time Pool that pays for the work Anthers hands out on your
						behalf. Both reach creators; neither is a cut of your earnings, and{" "}
						<strong className="font-semibold text-base-content/80">
							neither one needs the other
						</strong>
						—a fan who never gives Anthers a cent can still back you in full.
					</Lede>
				</Reveal>
				<div className="mx-auto mt-10 grid max-w-4xl gap-8 text-left sm:grid-cols-2">
					<Reveal delay={0} className="h-full">
						<SignpostCard step="1" title="Direct support — 0% cut" tone="creator">
							The wedge, and the part we'll state flatly: nothing is taken.
							<ul>
								<li>
									<strong className="font-semibold text-base-content/85">Monthly support</strong> —
									any amount they choose, recurring like a membership, with no platform cut and no
									payout processing
								</li>
								<li>
									<strong className="font-semibold text-base-content/85">Anything you sell</strong>{" "}
									— games, albums, books, prints, merch, services: you set the price a buyer sees,
									and we show you exactly what you'll receive before you publish
								</li>
								<li>
									The only deduction is the at-cost card processing—paid to a third party, never a
									cent to Anthers. Delivery is free, at any size and any number of downloads
								</li>
							</ul>
							This is where "0% cut" is simply true, with nothing to qualify.
						</SignpostCard>
					</Reveal>
					<Reveal delay={110} className="h-full">
						<SignpostCard step="2" title="The Anthers commons — the Time Pool" tone="anthers">
							Fans also point a monthly amount at{" "}
							<strong className="font-semibold text-base-content/85">the platform itself</strong>.
							That:
							<ul>
								<li>
									puts {fmtMoney(timePoolFor(PUBLIC_ACCESS_PRICE))} of every{" "}
									{fmtMoney(PUBLIC_ACCESS_PRICE)} into that fan's{" "}
									<strong className="font-semibold text-base-content/85">Time Pool</strong>, split
									across the creators they spend time with, by time
								</li>
								<li>
									counts every medium equally—an hour of reading, listening, playing, and watching
									are the same hour
								</li>
								<li>
									raises their Badge (Root → Blossom)—standing, not a key: it opens no work of yours
									or anyone's
								</li>
							</ul>
							{fmtMoney(PUBLIC_ACCESS_PRICE)} a month also lifts their own Public Access limit, so
							they can spend as much time with your free work as they like. Whatever is left over
							funds free access and the charitable programs—not Anthers' pocket. Anthers is a
							non-profit: no investors, no profit-taking.
						</SignpostCard>
					</Reveal>
				</div>

				{/* The rule that ties the two channels together */}
				<Reveal delay={140} className="mx-auto mt-10 block max-w-3xl">
					<Card className="border-primary/20 bg-primary/[0.04] text-left">
						<h3 style={serif} className="mb-2 text-lg font-medium">
							Whoever hands out the work is who pays you for it
						</h3>
						<p className="text-sm leading-relaxed text-base-content/70">
							Work <em className="not-italic font-medium">you</em> hand out—behind one of your own
							gates, or sold—is paid by direct support, and draws nothing from the Time Pool. Work{" "}
							<em className="not-italic font-medium">Anthers</em> hands out—the streaming work you
							leave ungated, free to everyone—is paid from the Time Pool, funded by everyone backing
							the commons. Every piece of work pays you exactly once, from the side that carried it.
						</p>
					</Card>
				</Reveal>

				{/* What a fan brings to the Time Pool at each Badge (derived from constants) */}
				<Reveal className="mx-auto mt-12 block max-w-2xl">
					<Card className="overflow-x-auto">
						<table className="table">
							<thead>
								<tr className="border-base-content/10">
									{["Badge", "A month to Anthers", "They pay", "Their Time Pool"].map((h, i) => (
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
								{BADGE_ORDER.map((b) => {
									const n = thresholdForBadge(b);
									const isFree = b === "free";
									return (
										<tr
											key={b}
											className={`border-base-content/10 ${isFree ? "text-base-content/45" : ""}`}
										>
											<td className={isFree ? "" : "font-medium"}>
												{!isFree && BADGE_ART[b].emoji} {badgeLabel(b)}
											</td>
											<td className="text-right text-base-content/70">{n}</td>
											<td className="text-right text-base-content/70">
												{isFree ? "$0" : fmtMoney(n)}
											</td>
											<td className="text-right font-medium text-primary">
												${timePoolFor(n).toFixed(2)}
												{isFree ? "*" : ""}
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
						A fan's Badge is what they're giving Anthers right now—a point-in-time choice, not a
						rolling total of past spend—and it keeps scaling past Blossom. Their Time Pool is split
						across every creator they spend time with, so what reaches you is your share of their
						month, not the whole figure. What they give you directly is separate, and carries no
						platform cut. *A free account pays nothing; free access covers its small Time Pool, so
						even a free viewer pays the creators they spend time with—up to{" "}
						{FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a month, which supporting Anthers
						lifts. Delivery costs nothing on either side—no per-GiB charge, however much anyone
						streams or downloads—and you get {FREE_STORAGE_GIB} GiB of free storage.
					</p>
				</Reveal>
			</Section>

			{/* Your ladder — your gates, Public Access, and your own Badges */}
			<Section tint>
				<Reveal>
					<Eyebrow>Your ladder</Eyebrow>
					<H2>Build your own rungs, name them, draw them</H2>
					<Lede>
						There is exactly one gate on Anthers and it points at{" "}
						<em className="not-italic underline decoration-primary/40">you</em>: an amount given to
						you each month. Every piece of work you make is either behind one of your rungs or free
						to everyone—and nothing sits in between, because a commons with a velvet rope isn't one.
					</Lede>
				</Reveal>
				<div className="mx-auto mt-12 grid max-w-4xl gap-6 text-left md:grid-cols-3">
					<Reveal delay={0} className="h-full">
						<Card className="card-lift h-full">
							<h3 style={serif} className="mb-2 text-lg font-medium">
								🌱&nbsp; Your gates
							</h3>
							{/* ⚠️ These example rungs were `PUBLIC_ACCESS_PRICE × 1/2/3` — the Anthers
							    ladder, borrowed. Read as a creator's own options it teaches a $3 step
							    that no longer exists (63.01 § Badge: no granularity floor, "$2 / $7.50
							    / $15 is as valid as $3 / $6 / $9 / $12"), so the illustration is
							    deliberately uneven and deliberately not derived from our price. */}
							<p className="text-sm leading-relaxed text-base-content/70">
								Your own rungs, at any amount you like—$2, $7.50, $15 a month, whatever suits your
								work. You write the names and pick what each one opens. Because support is given
								deliberately, nobody backs into your inner circle by watching.
							</p>
						</Card>
					</Reveal>
					<Reveal delay={110} className="h-full">
						<Card className="card-lift h-full">
							<h3 style={serif} className="mb-2 text-lg font-medium">
								🌼&nbsp; Public Access
							</h3>
							<p className="text-sm leading-relaxed text-base-content/70">
								Or gate nothing at all. Streaming work you leave open is free to everyone, and it
								still earns—the Time Pool pays you for the time people spend with it, so a stranger
								who has never heard of you costs you nothing and pays you anyway.
							</p>
						</Card>
					</Reveal>
					<Reveal delay={220} className="h-full">
						<Card className="card-lift h-full">
							<h3 style={serif} className="mb-2 text-lg font-medium">
								👑&nbsp; Your Badges
							</h3>
							<p className="text-sm leading-relaxed text-base-content/70">
								Every threshold of yours carries a Badge you design—a small collectible emblem your
								supporters wear, the way Anthers' own Badges have their botanical wreaths. Anthers
								sponsors emerging illustrators to help creators make them.
							</p>
						</Card>
					</Reveal>
				</div>
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
	{ key: "seed", label: "Backs you monthly" },
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
	seed: "what a fan gives you each month",
	stream: "an hour a fan spends with your public work",
};

const CS_NOTE = "funds free access & programs";
const PASSTHROUGH = "pure passthrough";
const NO_CUT = "no cut";

/** Derived, never typed — see scripts/econ-figures.ts. */
const SALE_10_2GIB = SALE_TABLE.find((r) => r.label === "game-10-2gib")!;
const SALE_25_PHYSICAL = SALE_TABLE.find((r) => r.label === "merch-25-physical")!;

// A representative engaged fan for the streaming comparison: the Sprout Badge — $6 a
// month to Anthers, $3.00 of it Time Pool — who streams ~28 hrs/month, the same
// reference streamer the economics doc uses. Everything below is derived, never
// typed: the creator earns the fan's Time Pool ÷ their hours, per hour — the SAME for
// every medium (equal-time), and independent of resolution (pay is by time, not bytes).
// The rest of that $6 is the at-cost card fee (inside the price since 2026-08-03) and the
// remainder that funds free access and the charitable programs. Note the per-hour figures fall as they watch more only because the same
// fixed monthly money is spread over more hours — nothing costs more per hour.
const STREAM_FAN_SUPPORT = thresholdForBadge("sprout");
const STREAM_FAN_HOURS = 28;
const STREAM_FAN_SPEND = STREAM_FAN_SUPPORT;
const STREAM_FAN_POOL = timePoolFor(STREAM_FAN_SUPPORT);
const STREAM_FAN_CARD = cardFeeDisplay(STREAM_FAN_SPEND);
const perHour = (total: number) => `~$${(total / STREAM_FAN_HOURS).toFixed(2)}`;
const STREAM_HR_PAY = perHour(STREAM_FAN_POOL);
const STREAM_HR_CARD = perHour(STREAM_FAN_CARD);
const STREAM_HR_FOUNDATION = perHour(STREAM_FAN_SPEND - STREAM_FAN_POOL - STREAM_FAN_CARD);
/** "a Sprout fan ($6/mo, ~28 hrs/month)" — the shared preamble for the stream notes. */
const STREAM_FAN = `a Sprout fan (${fmtMoney(STREAM_FAN_SPEND)}/mo to Anthers, ~${STREAM_FAN_HOURS} hrs/month)`;

/**
 * The monthly-support scenario, and the basis every rival row is scaled to.
 *
 * 🚨 **This silently became $2.** It was `PUBLIC_ACCESS_PRICE * SEED_COUNT` — two whole
 * Seeds, $6 — and the retirement pass dropped the multiplication but left `SEED_COUNT = 2`
 * behind, so the page computed a **$2** scenario while every sentence around it still said
 * $6, including the note that told the reader rival figures were "all-in take-home at the
 * same $6". A comparison table whose stated basis disagrees with its own numbers is worse
 * than one with no basis at all.
 *
 * Two Public Access prices is the editorial choice, so it is written as that rather than
 * as a bare 6 — the figure moves if the price does.
 */
const SUPPORT_SPEND = PUBLIC_ACCESS_PRICE * 2;
const SEED_SPEND = SUPPORT_SPEND;
const SEED_SPEND_STR = `$${SEED_SPEND.toFixed(2)}`;
/** The at-cost card fee if this were the fan's ENTIRE monthly charge — the worst case,
 * and what a creator should plan against. A fan who also backs others spreads the fixed
 * $0.30 further and pays you more. */
const SEED_CARD = cardFeeDisplay(SEED_SPEND);
const SEED_CARD_STR = `$${SEED_CARD.toFixed(2)}`;
const SEED_NET_STR = `$${(SEED_SPEND - SEED_CARD).toFixed(2)}`;
/** Rival all-in take-home on the same monthly support: list × (1 − cutRate),
 * minus the at-cost card fee unless the rival absorbs processing (as YouTube
 * Memberships and Twitch do). Competitor rates are rough public estimates. */
const rivalSeedAllIn = (cutRate: number, absorbsProcessing = false) => {
	const afterCut = SEED_SPEND * (1 - cutRate);
	return `$${(absorbsProcessing ? afterCut : afterCut - SEED_CARD).toFixed(2)}`;
};
const rivalTakes = (cutRate: number) => `$${(SEED_SPEND * cutRate).toFixed(2)}`;
const SEED_SCENARIO = `A fan gives you ${SEED_SPEND_STR} a month`;
const SEED_NOTE = `Monthly support recurs until the fan changes it, and Anthers takes no cut of it — the only deduction is the at-cost card fee, which goes to the processor. That fee is charged once on the fan's WHOLE monthly charge and split pro-rata, so a fan who also backs other creators pays you more, not less. The figure shown is the worst case: this as their entire charge. Rival figures are all-in take-home at the same ${SEED_SPEND_STR} — their stated cut plus the same card processing everyone pays, except where the rival absorbs it.`;

/** Rival all-in take-home on a sale: list × (1 − cutRate), minus the at-cost card
 * fee unless the rival absorbs processing (as Steam and Apple do — they fold the
 * card cost into their percentage). Competitor rates are rough public estimates. */
const rivalPurchaseAllIn = (price: number, cutRate: number, absorbsProcessing = false) => {
	const afterCut = price * (1 - cutRate);
	if (absorbsProcessing) return `$${afterCut.toFixed(2)}`;
	const card = cardFeeDisplay(price);
	return `$${(afterCut - card).toFixed(2)}`;
};
/** What the rival keeps on that sale — their revenue share, derived from the same two
 * numbers as their take-home above, so the two halves of a row can never disagree.
 * Not one of our figures; several of these land on the same amount as a Time Pool
 * rung by coincidence, which is exactly why it is computed rather than typed. */
const rivalPurchaseCut = (price: number, cutRate: number) => `$${(price * cutRate).toFixed(2)}`;

/** The Anthers row for a combo. `platform` is what Anthers itself receives — the
 * remainder of a fan's support for Anthers on a stream (funds free access + the
 * charitable programs, NOT a platform profit cut); $0 on a sale (the purchase fee was
 * removed 2026-08-03) and on direct support (a pure passthrough). */
const anthers = (creator: string, platform: string, platformNote: string): Deal => ({
	name: "Anthers",
	creator,
	platform,
	platformNote,
});

// The itemized Anthers side, shown as a mini-receipt under each comparison. The
// closing line makes the honest point the comparison table can't: Anthers profit is
// always $0 — the remainder funds free access and the charitable programs, and the
// card fee goes to the processor. Streaming isn't
// where Anthers competes on pay; the Time Pool share is small and variable, and the
// real support comes from monthly backing and sales.
const streamReceipt: Line[] = [
	{ label: "To you — your share of the fan's Time Pool, by time", amount: STREAM_HR_PAY },
	{
		label: "Card processing — their share of the at-cost card fee, to the processor",
		amount: STREAM_HR_CARD,
	},
	{
		label: "Free access & programs — what's left of their support for Anthers, across the month",
		amount: STREAM_HR_FOUNDATION,
	},
	{ label: "Anthers profit", amount: "$0.00" },
];
/** A sale. `net` is your take-home; `card` is the only deduction, and it is paid to
 * Stripe. Anthers charges nothing on a purchase (the fee that used to sit here was
 * removed 2026-08-03) and delivery costs nothing (removed 2026-08-12). */
const purchaseReceipt = (net: string, card: string): Line[] => [
	{ label: "To you — the listed price, less the card cost below", amount: net },
	{ label: "Card processing — to the payment processor", amount: card },
	{ label: "Delivery — every download, on every device, forever", amount: "$0.00" },
	{ label: "Anthers — no cut, no profit", amount: "$0.00" },
];
const merchReceipt: Line[] = [
	{
		label: `To you — your $${SALE_25_PHYSICAL.price} listed, less the card cost`,
		amount: `$${SALE_25_PHYSICAL.creatorReceives}`,
	},
	{
		label: "Card processing — to the payment processor",
		amount: `$${SALE_25_PHYSICAL.cardFee}`,
	},
	{ label: "Anthers — no cut, no profit", amount: "$0.00" },
];
const seedReceipt: Line[] = [
	{ label: "To you — their support, less the at-cost card share", amount: SEED_NET_STR },
	{ label: "Card processing — one fee on the fan's whole monthly charge", amount: SEED_CARD_STR },
	{ label: "Anthers — no cut, no profit", amount: "$0.00" },
];

/** The Anthers take-home + receipt for a sale, derived from constants: the list price
 * less at-cost card processing, which since 2026-08-12 is the only deduction — the
 * first download's delivery went with the per-GiB charge, so the work's size no longer
 * enters this at all. Anthers keeps $0 (the purchase fee was removed 2026-08-03). */
const anthersPurchase = (price: number): { netStr: string; receipt: Line[] } => {
	const card = cardFeeDisplay(price);
	const net = Math.round((price - card) * 100) / 100;
	const fmt = (n: number) => `$${n.toFixed(2)}`;
	return { netStr: fmt(net), receipt: purchaseReceipt(fmt(net), fmt(card)) };
};

// Pre-compute the Anthers take-home + receipt for each purchase scenario (the
// MATRIX rows + breakdowns reference these — derived from constants, never typed).
const PURCHASE_VIDEO = anthersPurchase(12);
const PURCHASE_GAMES = anthersPurchase(15);
const PURCHASE_MUSIC = anthersPurchase(10);
const PURCHASE_WRITING = anthersPurchase(8);

// [action][media] → the scenario + who-gets-what + the Anthers breakdown. Anthers
// first. Competitor figures are rough public estimates. `stream` has no `merch`
// entry on purpose — that combo is a joke (see SolutionExplorer).
const MATRIX: Record<ActionKey, Partial<Record<MediaKey, Combo>>> = {
	stream: {
		video: {
			scenario: "A fan watches an hour of your public 1080p video",
			rows: [
				anthers(STREAM_HR_PAY, STREAM_HR_FOUNDATION, CS_NOTE),
				{ name: "YouTube (Ads)", creator: "~$0.03", platform: "~$0.03" },
				{ name: "YouTube (Premium)", creator: "~$0.05–0.20", platform: "~55%" },
			],
			note: `${STREAM_FAN} pays a creator about ${STREAM_HR_PAY.replace("~", "")} for an hour of their time — the same whether they watch 720p on mobile or 1080p on desktop, since pay is by time, not bytes, and it climbs with every dollar they give Anthers. Streaming still isn't where Anthers competes; your public page makes your work discoverable and available effectively at cost, with no ads. The real support comes from monthly backing and sales.`,
			breakdown: streamReceipt,
		},
		games: {
			scenario: "A fan plays an hour of your public browser game",
			rows: [
				anthers(STREAM_HR_PAY, STREAM_HR_FOUNDATION, CS_NOTE),
				{ name: "Steam / itch.io", creator: "$0.00", platform: "$0.00" },
				{ name: "Xbox Game Pass", creator: "pennies", platform: "undisclosed" },
			],
			note: `Almost nowhere pays indie devs for play-time at all — Anthers pays the same ${STREAM_HR_PAY}/hr as any medium (a minute is a minute). Your public browser game is discoverable and served effectively at cost; monthly backing and sales are where fans really pay you.`,
			breakdown: streamReceipt,
		},
		music: {
			scenario: "A fan listens to an hour of your public tracks",
			rows: [
				anthers(STREAM_HR_PAY, STREAM_HR_FOUNDATION, CS_NOTE),
				{ name: "Spotify", creator: "~$0.07", platform: "~30% + labels" },
				{ name: "Apple Music", creator: "~$0.17", platform: "~30% + labels" },
			],
			note: `Honestly: per hour we're in the middle here. Spotify pays roughly $0.07 an hour before a label takes its share, Apple Music about twice that, and Anthers ${STREAM_HR_PAY} — ad-free, and paid by time rather than per stream, so an hour of your tracks earns exactly what an hour of video does. We won't pretend streaming is the win; devoted fans pay you through monthly backing and album sales, and we take no cut of either.`,
			breakdown: streamReceipt,
		},
		writing: {
			scenario: "A fan reads your public writing for an hour",
			rows: [
				anthers(STREAM_HR_PAY, STREAM_HR_FOUNDATION, CS_NOTE),
				{ name: "Medium", creator: "~$0.02", platform: "members only" },
				{ name: "Substack", creator: "$0.00", platform: "no per-read pay" },
			],
			note: `Most writing platforms don't pay per-read at all. Anthers pays by time like everything else — about ${STREAM_HR_PAY.replace("~", "")} for an hour with your work — and your public writing stays free to discover, served at cost. Monthly backing and sales are the real support.`,
			breakdown: streamReceipt,
		},
	},
	purchase: {
		video: {
			scenario: "A fan buys your $12 video",
			rows: [
				anthers(PURCHASE_VIDEO.netStr, "$0.00", NO_CUT),
				{
					name: "Gumroad",
					creator: rivalPurchaseAllIn(12, 0.1),
					platform: rivalPurchaseCut(12, 0.1),
				},
				{
					name: "Apple / iTunes",
					creator: rivalPurchaseAllIn(12, 0.3, true),
					platform: rivalPurchaseCut(12, 0.3),
				},
			],
			breakdown: PURCHASE_VIDEO.receipt,
		},
		games: {
			scenario: "A fan buys your $15 game",
			rows: [
				anthers(PURCHASE_GAMES.netStr, "$0.00", NO_CUT),
				{
					name: "itch.io",
					creator: rivalPurchaseAllIn(15, 0.1),
					platform: rivalPurchaseCut(15, 0.1),
				},
				{
					name: "Steam",
					creator: rivalPurchaseAllIn(15, 0.3, true),
					platform: rivalPurchaseCut(15, 0.3),
				},
			],
			breakdown: PURCHASE_GAMES.receipt,
		},
		music: {
			scenario: "A fan buys your $10 album",
			rows: [
				anthers(PURCHASE_MUSIC.netStr, "$0.00", NO_CUT),
				{
					name: "Bandcamp",
					creator: rivalPurchaseAllIn(10, 0.15),
					platform: rivalPurchaseCut(10, 0.15),
				},
				{
					name: "iTunes Store",
					creator: rivalPurchaseAllIn(10, 0.3, true),
					platform: rivalPurchaseCut(10, 0.3),
				},
			],
			breakdown: PURCHASE_MUSIC.receipt,
		},
		writing: {
			scenario: "A fan buys your $8 ebook",
			rows: [
				anthers(PURCHASE_WRITING.netStr, "$0.00", NO_CUT),
				{
					name: "Gumroad",
					creator: rivalPurchaseAllIn(8, 0.1),
					platform: rivalPurchaseCut(8, 0.1),
				},
				{
					name: "Amazon KDP",
					creator: rivalPurchaseAllIn(8, 0.3, true),
					platform: rivalPurchaseCut(8, 0.3),
				},
			],
			breakdown: PURCHASE_WRITING.receipt,
		},
		merch: {
			scenario: "A fan buys your $25 shirt",
			rows: [
				anthers(`$${SALE_25_PHYSICAL.creatorReceives}`, "$0.00", NO_CUT),
				{
					name: "Etsy",
					creator: rivalPurchaseAllIn(25, 0.11),
					platform: rivalPurchaseCut(25, 0.11),
				},
				{
					name: "Gumroad",
					creator: rivalPurchaseAllIn(25, 0.1),
					platform: rivalPurchaseCut(25, 0.1),
				},
			],
			note: "Excludes production & shipping—a real cost on any platform, including Anthers.",
			breakdown: merchReceipt,
		},
	},
	seed: {
		video: {
			scenario: SEED_SCENARIO,
			rows: [
				anthers(SEED_NET_STR, "$0.00", PASSTHROUGH),
				{
					name: "YouTube Memberships",
					creator: rivalSeedAllIn(0.3, true),
					platform: rivalTakes(0.3),
				},
				{ name: "Twitch (sub)", creator: rivalSeedAllIn(0.5, true), platform: rivalTakes(0.5) },
			],
			note: SEED_NOTE,
			breakdown: seedReceipt,
		},
		games: {
			scenario: SEED_SCENARIO,
			rows: [
				anthers(SEED_NET_STR, "$0.00", PASSTHROUGH),
				{ name: "Patreon", creator: rivalSeedAllIn(0.1), platform: rivalTakes(0.1) },
				{ name: "Ko-fi", creator: rivalSeedAllIn(0.05), platform: rivalTakes(0.05) },
			],
			note: SEED_NOTE,
			breakdown: seedReceipt,
		},
		music: {
			scenario: SEED_SCENARIO,
			rows: [
				anthers(SEED_NET_STR, "$0.00", PASSTHROUGH),
				{ name: "Patreon", creator: rivalSeedAllIn(0.1), platform: rivalTakes(0.1) },
				{
					name: "Bandcamp (subscription)",
					creator: rivalSeedAllIn(0.15),
					platform: rivalTakes(0.15),
				},
			],
			note: SEED_NOTE,
			breakdown: seedReceipt,
		},
		writing: {
			scenario: SEED_SCENARIO,
			rows: [
				anthers(SEED_NET_STR, "$0.00", PASSTHROUGH),
				{ name: "Substack", creator: rivalSeedAllIn(0.1), platform: rivalTakes(0.1) },
				{ name: "Patreon", creator: rivalSeedAllIn(0.1), platform: rivalTakes(0.1) },
			],
			note: SEED_NOTE,
			breakdown: seedReceipt,
		},
		merch: {
			scenario: SEED_SCENARIO,
			rows: [
				anthers(SEED_NET_STR, "$0.00", PASSTHROUGH),
				{ name: "Patreon", creator: rivalSeedAllIn(0.1), platform: rivalTakes(0.1) },
				{ name: "Buy Me a Coffee", creator: rivalSeedAllIn(0.05), platform: rivalTakes(0.05) },
			],
			note: `${SEED_NOTE} Monthly support backs you, not one thing you made — whatever you turn out next is already covered.`,
			breakdown: seedReceipt,
		},
	},
};

/** The interactive heart of "the solution": pick how a fan supports you (purchase /
 * Seed / stream) and the medium, and see exactly what reaches the creator vs.
 * the platform on Anthers and elsewhere. Leads with purchase — the categorical 0%-cut
 * win. Scenario assumptions are stated in-card; figures are estimates and Anthers'
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
						{/* The honest Anthers breakdown — the comparison's "to the Platform" funds free
							access and the charitable programs, not profit; this itemizes where the rest
							goes and lands on the line the table can't show: Anthers profit is always $0. */}
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
				Anthers never profits. On a sale, the only deduction from your listed price is the at-cost
				card processing, paid to Stripe — never a cent to Anthers (the purchase fee was removed
				2026-08-03), and delivery costs nothing however large the work or however often it is
				downloaded. On a stream, what's left of the fan's support for Anthers after the Time Pool
				and the at-cost card fee funds free access and the charitable programs. What a fan gives you
				is a pure passthrough. Scenario figures are illustrative; competitor rates are rough public
				estimates, all-in take-home at the same list price.
			</p>
		</Card>
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

/**
 * A pricing-model card (Free / Badge Access / Fixed Price).
 *
 * ⚠️ Said "Free / PWYW / Fixed" until 2026-08-16, and a grep is the only thing that could
 * have caught it: `econ:figures` blanks comments before matching, deliberately, so a
 * docstring naming a mechanism we do not have is out of the guard's reach by design.
 */
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
