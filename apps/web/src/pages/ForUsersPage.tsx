// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The For Users marketing page — the production Meadow design (ported from the
// Meadow design-lab reference, since removed; see git history). Airy editorial
// forest-green over a soft-yellow accent, Fraunces display serif over Nunito Sans.
// Renders inside the shared LoggedOutLayout (site nav + footer); the shared
// <MeadowDecor> supplies the pollen surface, woven climbing side vines, and grassy
// flowered floor around the content.
//
// SKETCH (support-model keystone): the page is sequenced as TWO products, not three
// ways — always Seeds given to Anthers first, Seeds given to creators second. It LEADS
// with the Anthers commons (Seeds to Anthers fund free public content via the Time Pool
// and lift the viewer's own Public Access limit), then direct creator support (Seeds +
// purchases, no platform cut — the wedge).
//
// 🚨 Rewritten 2026-08-14, because the page taught two retired mechanisms. It framed
// gates as "one primitive pointed two ways" and sold Anthers' Badges on the content they
// unlocked — but **Anthers Gates are retired** (2026-08-12): there is one gate primitive
// and it points only at creators, so a Work is gated by its creator or it is Public
// Access, with no Badge threshold in between. A Badge is now **standing, not
// entitlement**. What a Seed to Anthers actually buys is the *lifted Public Access limit*
// (the first one, whole) and a *larger Time Pool* for the creators you spend time with
// (every one, linearly). Write the ladder as what your giving does, never as what you get
// to see — 63.01 § Words, "Anthers' Badges".
//
// ⚠️ And the free tier is bounded: FREE_PUBLIC_ACCESS_HOURS a month. 63.01 makes
// co-presence mandatory — "free forever" without the limit beside it reads as unlimited,
// and the limit is the whole reason to give a first Seed. Never say this page's old
// "streams without a meter".
//
// All numbers derive from the support model: a Seed is $3/month, and Anthers' Badges sit
// at 1–4 Seeds given to Anthers (Root–Blossom, "+" beyond).
//
// Motion: content fades up on load (hero) and as it scrolls into view (sections),
// via the shared <Reveal>; content cards get a gentle hover lift (`card-lift`).
// Both are motion-safe — a visitor who prefers reduced motion sees neither.

import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { MeadowDecor } from "@anthers/web-shared/decor/MeadowDecor";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Card, Eyebrow, H2, Lede, Section, SignpostCard } from "@anthers/web-shared/decor/sections";
import { BADGE_LADDER, PurchaseExample } from "@anthers/web-shared/economics";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link } from "@anthers/web-shared/router";

const serif = { fontFamily: FONTS.fraunces };

// Shared hover/press affordance for the primary CTA buttons (motion-safe lift).
const ctaMotion = "transition duration-200 motion-safe:hover:-translate-y-0.5";

export default function ForUsersPage() {
	return (
		<MeadowDecor floor={false} style={{ fontFamily: FONTS.nunito }}>
			{/* Hero — fades up on load in three staggered beats. */}
			<header className="bg-base-200/70">
				<div className="mx-auto max-w-5xl px-6 pt-24 pb-20 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-5 h-11 w-11 text-primary/60" />
						<p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
							For the Players, Listeners, Viewers, Readers, &amp; Fans
						</p>
						<h1
							style={serif}
							className="text-balance text-5xl font-light leading-[1.05] tracking-tight sm:text-7xl"
						>
							Our creative garden,
							<br />
							<em className="font-medium text-primary not-italic">
								where we can all grow together
							</em>
						</h1>
					</Reveal>
					<Reveal delay={150}>
						<p className="text-justify [text-align-last:center] mx-auto mt-8 max-w-4xl text-lg leading-relaxed text-base-content/75">
							Anthers is a creative garden for everyone: a place for videos, games, music, writing,
							crafts, services, and more, all on an open, distributed network. A harmonious
							ecosystem supported by a new non-profit foundation, where we can all nurture a
							creative internet worth loving again.
						</p>
						<p className="text-justify [text-align-last:center] mx-auto mt-4 max-w-4xl text-lg leading-relaxed text-base-content/75">
							Here, your relationship with the creators and content you love belongs to you. Not to
							advertisers, data brokers, or billionaire edgelords. This is the place where we open
							the gates, and let you and the artists and artisans who inspire you be free.
						</p>
						<p className="text-justify [text-align-last:center] mx-auto mt-4 max-w-4xl text-lg leading-relaxed text-base-content/75">
							No ads, ever. No shareholders, ever. Just freedom to see and be seen, to listen and be
							heard, and to understand and be understood.
						</p>
					</Reveal>
					<Reveal delay={300}>
						<div className="mt-9 flex flex-wrap justify-center gap-3">
							<Link to="/signup" className={`btn btn-primary rounded-lg px-8 ${ctaMotion}`}>
								Start Exploring
							</Link>
						</div>
						<p className="mx-auto mt-6 max-w-xl text-sm text-base-content/50">
							No payment required to use Anthers, ever. Every account downloads freely and streams{" "}
							{FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a month — free forever, no trial,
							nothing to cancel.
						</p>
						<BrandGlyph
							name="divider-botanical"
							className="-mb-20 -mt-5 h-24 w-52 text-primary/45"
						/>
					</Reveal>
				</div>
			</header>

			{/* How it works — two products, the Anthers commons first */}
			<Section>
				<Reveal>
					<Eyebrow>How it works</Eyebrow>
					<H2>Support the creators you love, and grow the garden for all</H2>
					<Lede>
						Everything on Anthers starts{" "}
						<strong className="font-semibold text-base-content/80">free</strong>, with no ads or
						strings attached. We believe creative and informative media is a common good, and should
						be available to the community with no obligations or ulterior motives.
					</Lede>
					<Lede>
						When you want to go past free public access, use
						<strong className="font-semibold text-base-content/80"> Seeds </strong>
						to increase your support in one of two ways:
					</Lede>
					<div className="my-6 grid gap-8 text-left sm:grid-cols-2">
						<Reveal delay={0} className="h-full">
							<SignpostCard step="1" title="Support Anthers" tone="anthers">
								Each $3/month Seed you give Anthers does the following:
								<ul>
									<li>Increase the pool of money distributed to creators you spend time with</li>
									<li>Fund Anthers' free public access and charitable programs for all</li>
								</ul>
								The first one also lifts your monthly Public Access limit, so you can watch, read,
								listen and play as much as you like. As you give more, you'll grow your
								<strong className="font-semibold text-base-content/85"> Anthers Badge</strong>, from
								Root all the way to Blossom — a mark of what your giving does, not a key to
								anything. Nothing on Anthers is ever gated behind it.
							</SignpostCard>
						</Reveal>
						<Reveal delay={110} className="h-full">
							<SignpostCard step="2" title="Support Creators" tone="creator">
								Each $3/month Seed you direct to a Creator does the following:
								<ul>
									<li>Send that creator your support with no platform cut</li>
									<li>Unlock new creator-gated content and interactions</li>
									<li>Receive special discounts and early access on direct purchases</li>
								</ul>
								And remember: whether you back a creator with monthly Seeds or buy from them
								directly, Anthers takes no cut of it. The price you see is the price you pay, and
								sales tax is the only thing ever added.
							</SignpostCard>
						</Reveal>
					</div>
					<p className="mx-auto mt-4 max-w-4xl text-lg leading-relaxed text-base-content/65">
						No matter where you direct your Seeds each month, you can rest assured that you're
						supporting amazing creators and free public access to their work. No shareholders, no
						advertisers, no data brokers. Every dollar goes to one of three places: the real people
						who make what you love, the at-cost card processing that moves the money, or what's
						left—which funds free access and Anthers' other charitable programs.
					</p>
					<p className="mx-auto mt-4 max-w-4xl text-lg leading-relaxed text-base-content/65">
						Still curious about where exactly it all goes? See our{" "}
						<Link to="/resources" className="link text-primary decoration-primary/40">
							financial transparency page
						</Link>
						.
					</p>
				</Reveal>
			</Section>

			{/* ① The Anthers commons — free floor + Seeds to Anthers + Time Pool */}
			<Section tint>
				<Reveal>
					<Eyebrow>① The Anthers commons</Eyebrow>
					<H2>A garden that stays free for everyone</H2>
					<Lede>
						Every account downloads without a meter—no allowance to run out of, no data cap, no
						per-gigabyte charge, on as many devices as you like—and streams{" "}
						{FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a month, free forever. This isn't a
						trial or a trick (we're a non-profit; there's little incentive for either), it's an
						attempt to fulfill what we believe is a common right: for everyone to share and
						experience creativity and community with their neighbors around the world.
					</Lede>
					<p className="mx-auto mt-4 max-w-4xl text-lg leading-relaxed text-base-content/65">
						Seeds given to Anthers are how you help keep it that way. The first one lifts that
						monthly limit for as long as you hold it—and every one of them funds the free public
						content everyone enjoys, because creators earn from the{" "}
						<strong className="font-semibold text-base-content/80">Time Pool</strong> for the time
						people spend with their public work. Give more and your hours are worth more to the
						people you spend them with. The more the garden fills in, the further each Seed reaches.
					</p>
				</Reveal>
				<div className="mx-auto mt-12 grid max-w-4xl gap-6 text-left md:grid-cols-2">
					<Reveal delay={0} className="h-full">
						<Card className="card-lift h-full">
							<h3 style={serif} className="mb-3 text-xl font-medium">
								🌿&nbsp; How free stays free
							</h3>
							<p className="text-sm leading-relaxed text-base-content/70">
								On most of the internet, advertisers own the roads and make you the product. Here, a
								free viewer still pays the creators they watch—their small Time Pool is covered as
								free access, from a pool that every Seed given to Anthers supports. By sharing the
								load together, mountains diffuse into pebbles—and we all get a healthier internet
								for it.
							</p>
						</Card>
					</Reveal>
					<Reveal delay={110} className="h-full">
						<Card className="card-lift h-full">
							<h3 style={serif} className="mb-3 text-xl font-medium">
								🎋&nbsp; What Seeds to Anthers add
							</h3>
							<ul className="flex flex-col gap-2.5 text-sm">
								<FreeItem yes>
									Public Access with no monthly limit, from your very first Seed.
								</FreeItem>
								<FreeItem yes>
									A bigger Time Pool, so the same hour of your time pays the creator more.
								</FreeItem>
								<FreeItem yes>
									A Badge on your profile—Root to Blossom—that says you hold the garden open.
								</FreeItem>
							</ul>
							<p className="mt-4 border-t border-base-content/10 pt-3 text-xs leading-relaxed text-base-content/55">
								Seeds are $3 a month each—give Anthers 1 for Root, up to 4+ for Blossom. Supporting
								Anthers is separate from supporting a creator directly—one keeps the commons free,
								the other reaches a creator in full.
							</p>
						</Card>
					</Reveal>
				</div>
				<div className="mx-auto mt-14 grid max-w-4xl grid-cols-2 gap-6 md:grid-cols-4">
					{BADGE_LADDER.map((b, i) => (
						<Reveal key={b.name} delay={i * 90}>
							<div className="relative text-center">
								<div className="relative mx-auto mb-3 flex h-24 w-24 items-center justify-center">
									<BrandGlyph
										name={b.wreath}
										className="absolute inset-0 h-full w-full text-primary/55"
									/>
									<span aria-hidden="true" className="text-4xl">
										{b.emoji}
									</span>
								</div>
								<h3 style={serif} className="text-lg font-medium">
									{b.name}
								</h3>
								<p className="mt-0.5 font-mono text-xs text-primary">{b.threshold}</p>
								<p className="mt-0.5 text-[11px] text-base-content/45">
									{i + 1}
									{i === BADGE_LADDER.length - 1 ? "+" : ""} Seed{i > 0 ? "s" : ""} to Anthers
								</p>
								{i < BADGE_LADDER.length - 1 && (
									<span className="pointer-events-none absolute -right-3 top-8 hidden text-base-content/25 md:block">
										→
									</span>
								)}
							</div>
						</Reveal>
					))}
				</div>
			</Section>

			{/* ② Support creators directly — the wedge */}
			<Section>
				<Reveal>
					<Eyebrow>② Support creators directly</Eyebrow>
					<H2>When you pay a creator, that's what they get</H2>
					<Lede>
						We all deserve a way to support the people we love without tossing more money onto a
						pile for some Fortune 500 company. Our favorite video platforms choke us with ads and
						give creators crumbs even if we start paying. Our favorite game stores take 30% of every
						sale. Our favorite music apps pay less than a cent per stream. The problem is
						straightforward: these are for-profit companies. It doesn't{" "}
						<em className="not-italic underline decoration-primary/40">have</em> to be like that.
					</Lede>
					<p className="mx-auto mt-4 max-w-4xl text-lg leading-relaxed text-base-content/65">
						On Anthers there are two ways to back a creator directly, and both reach them in full:
					</p>
				</Reveal>
				<div className="mx-auto mt-10 grid max-w-4xl gap-6 text-left md:grid-cols-2">
					<Reveal delay={0} className="h-full">
						<Card className="card-lift h-full">
							<h3 style={serif} className="mb-3 text-xl font-medium">
								🌱&nbsp; Give Seeds
							</h3>
							<p className="text-sm leading-relaxed text-base-content/70">
								A Seed is $3 of direct support you give to a creator—give one, or a handful,
								whenever you like. Anthers takes no cut of it — no fee, no skim — and it keeps going
								each month until you change it. Giving Seeds is also how you unlock that creator's
								own gated content.
							</p>
						</Card>
					</Reveal>
					<Reveal delay={110} className="h-full">
						<Card className="card-lift h-full">
							<h3 style={serif} className="mb-3 text-xl font-medium">
								🎁&nbsp; Buy their work
							</h3>
							<p className="text-sm leading-relaxed text-base-content/70">
								Buy a game, an album, a book, a print—even merch or a service—and it's yours to
								keep. You pay the listed price plus your state's sales tax, and nothing else.
								Anthers keeps none of it: the one thing that comes out of that price is card
								processing, at cost. Downloading it again, on any device, costs nothing.
							</p>
						</Card>
					</Reveal>
				</div>
				<Reveal delay={120} className="mx-auto mt-10 block max-w-3xl">
					<PurchaseExample />
				</Reveal>
				<Reveal>
					<p
						style={serif}
						className="mt-12 text-balance text-2xl font-light leading-snug text-primary sm:text-3xl"
					>
						0% cut. Not a cent of it is ours. That's why Anthers is a non-profit; it's not about us.
					</p>
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
							Plant something worth growing
						</h2>
						<p className="mx-auto mt-5 max-w-4xl text-lg leading-relaxed text-base-content/70">
							Support the creators you love, on terms you can see and trust. Start now with a free
							account you can create in seconds—{FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a
							month, free forever. No ads, no data brokers, nothing to cancel.
						</p>
						<div className="mt-8 flex flex-wrap justify-center gap-3">
							<Link to="/signup" className={`btn btn-primary rounded-lg px-7 ${ctaMotion}`}>
								Start Exploring
							</Link>
						</div>
					</Reveal>
				</div>
			</section>
		</MeadowDecor>
	);
}

// ─── Local building blocks ───

/** A ✓ / – line in the "What Seeds to Anthers add" list. */
function FreeItem({ yes, children }: { yes?: boolean; children: React.ReactNode }) {
	return (
		<li className="flex gap-2.5">
			<span
				className={`mt-0.5 shrink-0 font-semibold ${yes ? "text-primary" : "text-base-content/30"}`}
			>
				{yes ? "✓" : "–"}
			</span>
			<span className="text-base-content/70">{children}</span>
		</li>
	);
}
