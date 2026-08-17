// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The For Users marketing page — the production Meadow design (ported from the
// Meadow design-lab reference, since removed; see git history). Airy editorial
// forest-green over a soft-yellow accent, Fraunces display serif over Nunito Sans.
// Renders inside the shared LoggedOutLayout (site nav + footer); the shared
// <MeadowDecor> supplies the pollen surface, woven climbing side vines, and grassy
// flowered floor around the content.
//
// The page is sequenced as TWO products, not three ways: direct creator support first
// (monthly giving + purchases, no platform cut — the wedge), the Anthers commons second
// (what goes to Anthers funds free public content via the Time Pool and lifts the
// viewer's own Public Access limit).
//
// 🚨 RESEQUENCED 2026-08-17, and it ran the other way round for as long as this page had
// existed. Support for Anthers led because it used to be the load-bearing gate — it paid
// for streaming bandwidth generally, so everyone needed some. It buys **Public Access**
// now, and nothing else, and early visitors arrive at the invitation of a creator who is
// already here: with few creators there is little Public Access to want yet, so the
// commons is not the tip of the funnel. Lead with *support the creators you love, and
// Anthers takes no cut, so you pay less and they make more*; Public Access is the
// second, optional thing. Reordering this back is a product decision, not a layout one.
//
// 🚨 Rewritten 2026-08-14, because the page taught two retired mechanisms. It framed
// gates as "one primitive pointed two ways" and sold Anthers' Badges on the content they
// unlocked — but **Anthers Gates are retired** (2026-08-12): there is one gate primitive
// and it points only at creators, so a Work is gated by its creator or it is Public
// Access, with no Badge threshold in between. A Badge is now **standing, not
// entitlement**. What supporting Anthers actually buys is the *lifted Public Access
// limit* (at the Public Access price, whole) and a *larger Time Pool* for the creators you
// spend time with (linearly, at every level). Write the ladder as what your giving does,
// never as what you get to see — 63.01 § Words, "Anthers' Badges".
//
// ⚠️ And the free tier is bounded: FREE_PUBLIC_ACCESS_HOURS a month. 63.01 makes
// co-presence mandatory — "free forever" without the limit beside it reads as unlimited,
// and the limit is the whole reason to start giving. Never say this page's old
// "streams without a meter".
//
// All numbers derive from the support model. Anthers' Badges sit at $3–$12 a month given
// to Anthers (Root–Blossom, "+" beyond); ⚠️ the $3 Seed UNIT retired 2026-08-16, so a
// level is an amount and never a count of anything.
//
// Motion: content fades up on load (hero) and as it scrolls into view (sections),
// via the shared <Reveal>; content cards get a gentle hover lift (`card-lift`).
// Both are motion-safe — a visitor who prefers reduced motion sees neither.

import { PUBLIC_ACCESS_PRICE, thresholdForBadge } from "@anthers/shared/constants";
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
							Anthers is a non-profit creative garden for everyone: a place for videos, games,
							music, writing, crafts, services, and more, all on an open-source, ad-free platform. A
							harmonious ecosystem where we can all nurture a creative internet worth loving again.
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
							{/* 🚨 /subscribe, not /signup, and the sentence below is the reason. `/subscribe`
							    collects an address and nothing else — the handle and any password are asked
							    for at `/welcome`, after the account exists — while `/signup` is still the
							    four-field form. Sending a reader who has just been promised "an email address
							    is all it takes" to a username + password + confirm form makes the promise
							    false at the click. It also puts the creator picker in front of a new account,
							    which is the thing this page now leads with. */}
							<Link to="/subscribe" className={`btn btn-primary rounded-lg px-8 ${ctaMotion}`}>
								Start Exploring
							</Link>
						</div>
						<p className="mx-auto mt-6 max-w-xl text-sm text-base-content/50">
							An email address is all it takes — no card, no trial, nothing to cancel. Every account
							downloads freely and streams {FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a
							month, free forever. You'll only ever be asked to pay when you decide to back a
							creator.
						</p>
						<BrandGlyph
							name="divider-botanical"
							className="-mb-20 -mt-5 h-24 w-52 text-primary/45"
						/>
					</Reveal>
				</div>
			</header>

			{/* How it works — two products, direct creator support first */}
			<Section>
				<Reveal>
					<Eyebrow>How it works</Eyebrow>
					<H2>Support the creators you love, and grow the garden for all</H2>
					<Lede>
						Anthers is where you back the people whose work you love. Give a creator a{" "}
						<strong className="font-semibold text-base-content/80">monthly amount</strong>, or buy
						something they made outright — and Anthers takes no cut of either one. You pay less and
						they keep more, which is most of the reason this place exists.
					</Lede>
					<Lede>
						The rest of it is that everything a creator leaves ungated starts{" "}
						<strong className="font-semibold text-base-content/80">free</strong>, with no ads or
						strings attached. We believe creative and informative media is a common good, and should
						be available to the community with no obligations or ulterior motives. So a monthly
						amount points one of two ways:
					</Lede>
					<div className="my-6 grid gap-8 text-left sm:grid-cols-2">
						<Reveal delay={0} className="h-full">
							<SignpostCard step="1" title="Support Creators" tone="creator">
								Directing a monthly amount to a creator does the following:
								<ul>
									<li>Send that creator your support with no platform cut</li>
									<li>Unlock new creator-gated content and interactions</li>
									<li>Receive special discounts and early access on direct purchases</li>
								</ul>
								And remember: whether you back a creator monthly or buy from them directly, Anthers
								takes no cut of it. The price you see is the price you pay, and sales tax is the
								only thing ever added.
							</SignpostCard>
						</Reveal>
						<Reveal delay={110} className="h-full">
							<SignpostCard step="2" title="Support Anthers" tone="anthers">
								Giving Anthers a monthly amount — entirely optional, and separate from anything you
								give a creator — does the following:
								<ul>
									<li>Increase the pool of money distributed to creators you spend time with</li>
									<li>Fund Anthers' free public access and charitable programs for all</li>
								</ul>
								${PUBLIC_ACCESS_PRICE} a month also lifts your monthly Public Access limit, so you
								can watch, read, listen and play as much as you like. As you give more, you'll grow
								your
								<strong className="font-semibold text-base-content/85"> Anthers Badge</strong>, from
								Root all the way to Blossom — a mark of what your giving does, not a key to
								anything. Nothing on Anthers is ever gated behind it.
							</SignpostCard>
						</Reveal>
					</div>
					<p className="mx-auto mt-4 max-w-4xl text-lg leading-relaxed text-base-content/65">
						No matter where you direct it each month, you can rest assured that you're supporting
						amazing creators and free public access to their work. No shareholders, no advertisers,
						no data brokers. Every dollar goes to one of three places: the real people who make what
						you love, the at-cost card processing that moves the money, or what's left—which funds
						free access and Anthers' other charitable programs.
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

			{/* ① Support creators directly — the wedge, and the tip of the funnel */}
			<Section tint>
				<Reveal>
					<Eyebrow>① Support creators directly</Eyebrow>
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
								🌱&nbsp; Back them monthly
							</h3>
							<p className="text-sm leading-relaxed text-base-content/70">
								Pick an amount and give it to a creator every month—whatever you like, changed
								whenever you like. Anthers takes no cut of it — no fee, no skim — and it keeps going
								until you change it. It is also how you unlock that creator's own gated content.
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

			{/* ② The Anthers commons — free floor + support for Anthers + Time Pool.
			    Second, deliberately: see the resequencing note in the page header. */}
			<Section>
				<Reveal>
					<Eyebrow>② The Anthers commons</Eyebrow>
					<H2>A garden that stays free for everyone</H2>
					<Lede>
						Everything above is between you and a creator. This part is the ground it grows in, and
						you are never asked to pay for it: every account downloads without a meter—no allowance
						to run out of, no data cap, no per-gigabyte charge, on as many devices as you like—and
						streams {FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a month, free forever. This
						isn't a trial or a trick (we're a non-profit; there's little incentive for either), it's
						an attempt to fulfill what we believe is a common right: for everyone to share and
						experience creativity and community with their neighbors around the world.
					</Lede>
					<p className="mx-auto mt-4 max-w-4xl text-lg leading-relaxed text-base-content/65">
						If you want more time than that, or simply want to hold the gates open for everyone
						else, ${PUBLIC_ACCESS_PRICE} a month to Anthers lifts that limit for as long as you keep
						it up—and every dollar of it funds the free public content everyone enjoys, because
						creators earn from the{" "}
						<strong className="font-semibold text-base-content/80">Time Pool</strong> for the time
						people spend with their public work. Give more and your hours are worth more to the
						people you spend them with. The more the garden fills in, the further each dollar
						reaches.
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
								free access, from a pool that everything given to Anthers supports. By sharing the
								load together, mountains diffuse into pebbles—and we all get a healthier internet
								for it.
							</p>
						</Card>
					</Reveal>
					<Reveal delay={110} className="h-full">
						<Card className="card-lift h-full">
							<h3 style={serif} className="mb-3 text-xl font-medium">
								🎋&nbsp; What supporting Anthers adds
							</h3>
							<ul className="flex flex-col gap-2.5 text-sm">
								<FreeItem yes>
									Public Access with no monthly limit, from ${PUBLIC_ACCESS_PRICE} a month.
								</FreeItem>
								<FreeItem yes>
									A bigger Time Pool, so the same hour of your time pays the creator more.
								</FreeItem>
								<FreeItem yes>
									A Badge on your profile—Root to Blossom—that says you hold the garden open.
								</FreeItem>
							</ul>
							<p className="mt-4 border-t border-base-content/10 pt-3 text-xs leading-relaxed text-base-content/55">
								The Badges run ${thresholdForBadge("root")} to ${thresholdForBadge("blossom")} a
								month, and "+" beyond. Supporting Anthers is separate from supporting a creator
								directly—one keeps the commons free, the other reaches a creator in full.
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
								<p className="mt-0.5 text-[11px] text-base-content/45">a month to Anthers</p>
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
							Support the creators you love, on terms you can see and trust. Start with a free
							account and an email address—that's the whole of it, and a card is only ever needed
							when you decide to back someone. {FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a
							month, free forever. No ads, no data brokers, nothing to cancel.
						</p>
						<div className="mt-8 flex flex-wrap justify-center gap-3">
							{/* /subscribe for the same reason as the hero CTA — see the note there. */}
							<Link to="/subscribe" className={`btn btn-primary rounded-lg px-7 ${ctaMotion}`}>
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

/** A ✓ / – line in the "What supporting Anthers adds" list. */
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
