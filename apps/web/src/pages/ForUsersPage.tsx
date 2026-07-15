// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The For Users marketing page — the production Meadow design (ported from the
// Meadow design-lab reference, since removed; see git history). Airy editorial
// forest-green over a soft-yellow accent, Fraunces display serif over Nunito Sans.
// Renders inside the
// shared LoggedOutLayout (site nav + footer); the shared <MeadowDecor> supplies
// the pollen surface, woven climbing side vines, and grassy flowered floor around
// the content. Copy is Parker's rewrite; every economics number derives from the
// V4 model via @anthers/shared/constants (through the shared economics cards).
//
// Motion: content fades up on load (hero) and as it scrolls into view (sections),
// via the shared <Reveal>; content cards get a gentle hover lift (`card-lift`).
// Both are motion-safe — a visitor who prefers reduced motion sees neither.

import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { MeadowDecor } from "@anthers/web-shared/decor/MeadowDecor";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Card, Eyebrow, H2, Lede, Section } from "@anthers/web-shared/decor/sections";
import {
	BADGE_LADDER,
	InfoDot,
	PurchaseExample,
	SubscriptionCalculator,
} from "@anthers/web-shared/economics";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link } from "@anthers/web-shared/router";

const serif = { fontFamily: FONTS.fraunces };

// Shared hover/press affordance for the primary CTA buttons (motion-safe lift).
const ctaMotion = "transition duration-200 motion-safe:hover:-translate-y-0.5";

// What a plan's monthly bandwidth allowance roughly buys — the (i) helper in the
// signpost card. Free plans include 5 GiB; paid plans scale up to 50 GiB.
const GIB_TIP =
	"Bandwidth covers streaming and downloads. As a rough guide, 10 GiB is several hours of FHD video, far more of music, or effectively unlimited reading each month.";

// Creator-defined per-creator Seed ladder (illustrative rungs) vs. the platform-wide
// Badge ladder — the two ways a creator can gate exclusive content.
const SEED_GATES = [
	{ amount: "$1", name: "Follow+", perk: "Chat access, community polls" },
	{ amount: "$2", name: "Insider", perk: "Early access, community posts" },
	{ amount: "$3", name: "Supporter", perk: "Behind-the-scenes, extended cuts" },
	{ amount: "$5", name: "Champion", perk: "Monthly Q&A, name in credits" },
] as const;

const BADGE_GATES = [
	{ amount: "$4", name: "Root", perk: "Root-level content, platform-wide" },
	{ amount: "$8", name: "Sprout", perk: "Sprout-level content, platform-wide" },
	{ amount: "$16", name: "Petal", perk: "Petal-level content, platform-wide" },
	{ amount: "$32", name: "Blossom", perk: "Blossom-level content, platform-wide" },
] as const;

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
							Someplace ours,
							<br />
							<em className="font-medium text-primary not-italic">
								where we can all grow together
							</em>
						</h1>
					</Reveal>
					<Reveal delay={150}>
						<p className="text-justify [text-align-last:center] mx-auto mt-8 max-w-4xl text-lg leading-relaxed text-base-content/75">
							Anthers is a creative garden for everyone—a peaceful place for videos, games, music,
							writing, crafts, services, and more, all on an open, distributed network. A harmonious
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
							No payment required to use Anthers, ever. All accounts have an allowance of free
							access every month, forever, no strings attached.
						</p>
						<BrandGlyph
							name="divider-botanical"
							className="-mb-20 -mt-5 h-24 w-52 text-primary/45"
						/>
					</Reveal>
				</div>
			</header>

			{/* How it works — three ways */}
			<Section>
				<Reveal>
					<Eyebrow>How it works</Eyebrow>
					<H2>Three ways to explore the garden</H2>
					<Lede>
						When you're ready for more than what we provide for free, there are two ways to get it:
						you can{" "}
						<strong className="font-semibold text-base-content/80">choose a Badge plan</strong> to
						fund creators and unlock a bigger bandwidth allowance and gated content, and you can{" "}
						<strong className="font-semibold text-base-content/80">purchase</strong> games, albums,
						books, merch, even services—100% to the creator, every time.
					</Lede>
					<p className="mx-auto mt-4 max-w-4xl text-lg leading-relaxed text-base-content/65">
						Whatever path you walk through Anthers, every dollar of your plans and purchases goes to
						the people who make what you love, to free access for new and small users and creators,
						or to Anthers Foundation charitable programs like educational ventures and content
						bounties—never to a platform's bottom line. Curious where your money goes? See our{" "}
						<Link to="/resources" className="link text-primary decoration-primary/40">
							financial transparency page
						</Link>
						.
					</p>
				</Reveal>
				<div className="mt-14 grid gap-8 text-left sm:grid-cols-3">
					<Reveal delay={0}>
						<SignpostCard step="1" title="Free Use">
							Browse, stream, interact, and download any content made public by any creator within a
							generous free allowance. You might end up wanting more, but let's put it this way: if
							you want to watch 1–2 hours of HD video from a creator's public page every week, you
							can do that for free, with no ads, forever.
						</SignpostCard>
					</Reveal>
					<Reveal delay={110}>
						<SignpostCard step="2" title="Subscriptions &amp; Seeds">
							Choose a <strong className="font-semibold text-base-content/85">Badge plan</strong>
							—Root $4, Sprout $8, Petal $16, or Blossom $32 a month. Your plan pays creators
							automatically for the time you spend with their work (the Time Pool), sends its
							included Seeds straight to creators you pick, and comes with a monthly bandwidth
							allowance <InfoDot tip={GIB_TIP} />. To go even deeper with one creator, sow extra
							Seeds—$1 each, 100% to them.
						</SignpostCard>
					</Reveal>
					<Reveal delay={220}>
						<SignpostCard step="3" title="One-Time Purchases">
							Buy games, albums, films, books, or anything else you like, and receive digital
							content that's yours to download and own forever. You can even buy real-world stuff
							like physical media, merch, and services. Creators receive 100% of the purchase price,
							and the biggest fees you'll ever pay on top are the standard card fees and taxes.
						</SignpostCard>
					</Reveal>
				</div>
			</Section>

			{/* (1) Free use */}
			<Section tint>
				<Reveal>
					<Eyebrow>① Free Use</Eyebrow>
					<H2>Free, and always will be</H2>
					<Lede>
						Every account on Anthers receives a bandwidth allowance of free access every
						month—enough for a few hours of HD video, far more of music, or thousands of articles
						with media. This isn't a trial or a trick (we're a non-profit; there's not much
						incentive for either), it's an attempt to fulfill what we believe is a common right for
						everyone to share and experience creativity and community with their neighbors around
						the world.
					</Lede>
				</Reveal>
				<div className="mx-auto mt-12 grid max-w-4xl gap-6 text-left md:grid-cols-2">
					<Reveal delay={0} className="h-full">
						<Card className="card-lift h-full">
							<h3 style={serif} className="mb-3 text-xl font-medium">
								🌿&nbsp; How free stays free
							</h3>
							<p className="text-sm leading-relaxed text-base-content/70">
								Every free tier is paid for by your fellow community members. On most of the
								internet, advertisers own the roads and make you the product. But it doesn't have to
								be that complicated. Here on Anthers, a free viewer's small bandwidth cost is
								subsidized by the Anthers Foundation from a pool that all paying members support.
							</p>
						</Card>
					</Reveal>
					<Reveal delay={110} className="h-full">
						<Card className="card-lift h-full">
							<h3 style={serif} className="mb-3 text-xl font-medium">
								🎁&nbsp; What free access includes
							</h3>
							<ul className="flex flex-col gap-2.5 text-sm">
								<FreeItem yes>
									5 GiB of content delivery each month—your free bandwidth allowance, covered by the
									Foundation.
								</FreeItem>
								<FreeItem yes>
									Everything that creators have made public, including posts, videos, games, and
									much more.
								</FreeItem>
								<FreeItem>
									Content that creators have gated behind Seeds ($1 increments sown directly to
									them) and Badges (the plan you choose).
								</FreeItem>
							</ul>
							<p className="mt-4 border-t border-base-content/10 pt-3 text-xs leading-relaxed text-base-content/55">
								Choose a plan from $4/month to unlock gated content, a bigger bandwidth allowance,
								and Seeds for your favorite creators.
							</p>
						</Card>
					</Reveal>
				</div>
				<Reveal>
					<p
						style={serif}
						className="mt-12 text-balance text-2xl font-light leading-snug text-primary sm:text-3xl"
					>
						By sharing the load together, mountains diffuse into pebbles—and we all get a healthier,
						better internet for it.
					</p>
				</Reveal>
			</Section>

			{/* (2) Subscriptions & Seeds */}
			<Section>
				<Reveal>
					<Eyebrow>② Subscriptions &amp; Seeds</Eyebrow>
					<H2>Support creators, not middlemen</H2>
					<Lede>
						We all deserve a way to support the creators we love without tossing more money onto a
						pile for some Fortune 500 company. Our favorite video platforms choke us with ads and
						give creators crumbs even if we start paying. Our favorite game platforms take 30% of
						the developers' revenue from every sale. And our favorite music platforms pay less than
						a cent for every song streamed. The problem is straightforward: these are for-profit
						companies. It doesn't{" "}
						<em className="not-italic underline decoration-primary/40">have</em> to be like that.
					</Lede>
					<p className="mx-auto mt-4 max-w-4xl text-lg leading-relaxed text-base-content/65">
						On Anthers, your subscription goes as directly as possible to the things that really
						matter, and we stay as out of the way as possible. Here's what it looks like, no
						secrets:
					</p>
				</Reveal>
				<Reveal delay={120} className="mx-auto mt-12 block max-w-3xl">
					<SubscriptionCalculator />
				</Reveal>
			</Section>

			{/* (3) One-time purchases */}
			<Section tint>
				<Reveal>
					<Eyebrow>③ One-Time Purchases</Eyebrow>
					<H2>Buy once, own forever</H2>
					<Lede>
						Whether you're buying a new game, an album of music, an e-book, or even a hoodie, the
						creator receives 100% of the listed price, period. The biggest fees you pay on top of
						that are standard card fees and taxes.
					</Lede>
				</Reveal>
				<Reveal delay={120} className="mx-auto mt-12 block max-w-3xl">
					<PurchaseExample />
				</Reveal>
			</Section>

			{/* The Anthers Badges (+ gates) */}
			<Section>
				<Reveal>
					<Eyebrow>The Anthers Badges</Eyebrow>
					<H2>Show your support and unlock exclusive content</H2>
					<Lede>
						Choose a Badge plan and you'll wear its Badge—Root, Sprout, Petal, or Blossom—for as
						long as you hold it. It's the plan you pick, not a rolling total of past spend.
					</Lede>
				</Reveal>
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
								{i < BADGE_LADDER.length - 1 && (
									<span className="pointer-events-none absolute -right-3 top-8 hidden text-base-content/25 md:block">
										→
									</span>
								)}
							</div>
						</Reveal>
					))}
				</div>
				<Reveal>
					<p className="mx-auto mt-10 max-w-4xl text-lg leading-relaxed text-base-content/65">
						The more your support grows, the more special content and perks you'll receive. Creators
						can gate exclusive content in one of two ways:
					</p>
				</Reveal>
				<div className="mx-auto mt-8 grid max-w-4xl gap-6 text-left md:grid-cols-2">
					<Reveal delay={0} className="h-full">
						<Card className="card-lift h-full">
							<p className="text-xs font-semibold uppercase tracking-wider text-accent">
								Across the platform
							</p>
							<h3 style={serif} className="mb-4 text-xl font-medium">
								Anthers Gates
							</h3>
							{BADGE_GATES.map((g) => (
								<GateRow key={g.name} {...g} />
							))}
						</Card>
					</Reveal>
					<Reveal delay={110} className="h-full">
						<Card className="card-lift h-full">
							<p className="text-xs font-semibold uppercase tracking-wider text-primary/80">
								For one creator
							</p>
							<h3 style={serif} className="mb-4 text-xl font-medium">
								Seed Gates
							</h3>
							{SEED_GATES.map((g) => (
								<GateRow key={g.name} {...g} />
							))}
						</Card>
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
							Plant something worth growing
						</h2>
						<p className="mx-auto mt-5 max-w-4xl text-lg leading-relaxed text-base-content/70">
							Support the creators you love, on terms you can see and trust. Browse the whole
							catalog free with an account you can create in seconds.
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

/** A numbered signpost card for the "three ways" section. */
function SignpostCard({
	step,
	title,
	children,
}: {
	step: string;
	title: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<Card className="card-lift h-full">
			<div
				style={serif}
				className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-xl font-semibold text-primary"
			>
				{step}
			</div>
			<h3 style={serif} className="mb-2 text-xl font-medium">
				{title}
			</h3>
			<p className="text-justify text-sm leading-relaxed text-base-content/70">{children}</p>
		</Card>
	);
}

/** A ✓ / – line in the "what free access includes" list. */
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

function GateRow({ amount, name, perk }: { amount: string; name: string; perk: string }) {
	return (
		<div className="flex items-center gap-3 border-t border-base-content/10 py-2.5 first:border-t-0">
			<span className="w-10 shrink-0 font-mono text-xs text-primary">{amount}</span>
			<span style={serif} className="w-24 shrink-0 font-medium">
				{name}
			</span>
			<span className="text-xs text-base-content/55">{perk}</span>
		</div>
	);
}
