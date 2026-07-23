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
// ways — always Anthers-Seeds first, creator Seeds second. It LEADS with the Anthers
// commons (Anthers-Seeds that support Anthers itself, fund free public content via the
// Time Pool, and set the rank that unlocks Anthers-gated content — with the free rank
// folded in as the commons' subsidized floor), then direct creator support (Seeds +
// purchases, 100% to the creator — the wedge). Gates are framed as one primitive with
// two directions: support the commons (Anthers Gate) or support a creator (Seed Gate).
// All numbers derive from the support model: a Seed is $3/month, and rank =
// Anthers-Seed count (Root–Blossom = 1–4, "+" beyond).
//
// Motion: content fades up on load (hero) and as it scrolls into view (sections),
// via the shared <Reveal>; content cards get a gentle hover lift (`card-lift`).
// Both are motion-safe — a visitor who prefers reduced motion sees neither.

import { FREE_FLOOR_GIB, GIB_PER_SEED } from "@anthers/shared/constants";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { MeadowDecor } from "@anthers/web-shared/decor/MeadowDecor";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Card, Eyebrow, H2, Lede, Section } from "@anthers/web-shared/decor/sections";
import { BADGE_LADDER, InfoDot, PurchaseExample } from "@anthers/web-shared/economics";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link } from "@anthers/web-shared/router";

const serif = { fontFamily: FONTS.fraunces };

// Shared hover/press affordance for the primary CTA buttons (motion-safe lift).
const ctaMotion = "transition duration-200 motion-safe:hover:-translate-y-0.5";

// What the monthly streaming allowance roughly buys — the (i) helper.
const GIB_TIP = `Every account streams ${FREE_FLOOR_GIB} GiB free each month, and each Anthers-Seed adds ${GIB_PER_SEED} GiB — all at cost. As a rough guide, ${FREE_FLOOR_GIB} GiB is several hours of 1080p video, far more of music, or effectively unlimited reading.`;

// Two ways a creator can gate exclusive content, under one idea: a level of support,
// pointed at a creator (Seed Gate) or at the commons (Anthers Gate). Illustrative rungs,
// in whole $3 Seeds — the creator names their own levels; Anthers ranks have fixed names.
const SEED_GATES = [
	{ amount: "$3", name: "Follow+", perk: "Chat access, community polls" },
	{ amount: "$6", name: "Insider", perk: "Early access, community posts" },
	{ amount: "$9", name: "Supporter", perk: "Behind-the-scenes, extended cuts" },
	{ amount: "$12", name: "Champion", perk: "Monthly Q&A, name in credits" },
] as const;

const ANTHERS_GATES = [
	{ amount: "$3", name: "Root", perk: "Root-level content, across the platform" },
	{ amount: "$6", name: "Sprout", perk: "Sprout-level content, across the platform" },
	{ amount: "$9", name: "Petal", perk: "Petal-level content, across the platform" },
	{ amount: "$12", name: "Blossom", perk: "Blossom-level content, across the platform" },
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
							our creative garden,
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

			{/* How it works — two products, the Anthers commons first */}
			<Section>
				<Reveal>
					<Eyebrow>How it works</Eyebrow>
					<H2>Back the people you love — the garden grows from there</H2>
					<Lede>
						Everything on Anthers starts{" "}
						<strong className="font-semibold text-base-content/80">free</strong>, with no ads or
						strings attached. We believe creative and informative media is a common good, and should
						be available to the community with no obligations or ulterior motives.
					</Lede>
					<Lede>
						When you want to go past free public access, use Seeds to increase your support in one
						of two ways:
					</Lede>
					<div className="my-6 grid gap-8 text-left sm:grid-cols-2">
						<Reveal delay={0}>
							<SignpostCard step="1" title="Join the Anthers commons">
								Point Seeds at Anthers—
								<strong className="font-semibold text-base-content/85">Anthers-Seeds</strong>, $3
								each—to fund the free public content everyone enjoys (creators earn from the Time
								Pool for the time you spend with their public work). The count you hold is your{" "}
								<strong className="font-semibold text-base-content/85">rank</strong>—Root, Sprout,
								Petal, or Blossom—unlocking Anthers-gated content across every creator. And every
								account, Seeds or none, gets a free streaming allowance <InfoDot tip={GIB_TIP} />{" "}
								each month, forever.
							</SignpostCard>
						</Reveal>
						<Reveal delay={110}>
							<SignpostCard step="2" title="Support creators directly">
								Give a creator <strong className="font-semibold text-base-content/85">Seeds</strong>
								—$3 each, as often as you like—or{" "}
								<strong className="font-semibold text-base-content/85">buy</strong> their games,
								albums, books, art, even merch and services. Either way the creator keeps 100%; the
								most you'll ever pay on top is standard card fees and tax. Direct support, with no
								middleman taking a slice.
							</SignpostCard>
						</Reveal>
					</div>
					<p className="mx-auto mt-4 max-w-4xl text-lg leading-relaxed text-base-content/65">
						The commons is what makes the garden worth wandering—and it gets better the more
						creators plant here. Direct support is the one we're proudest of: when you back a
						creator here, they keep all of it. Either way, every dollar goes to the people who make
						what you love, to delivering your streams at cost, or to free access and the Anthers
						Foundation's charitable programs—never to a platform's bottom line. Curious where it all
						goes? See our{" "}
						<Link to="/resources" className="link text-primary decoration-primary/40">
							financial transparency page
						</Link>
						.
					</p>
				</Reveal>
			</Section>

			{/* ① The Anthers commons — free floor + Anthers-Seeds + Time Pool */}
			<Section tint>
				<Reveal>
					<Eyebrow>① The Anthers commons</Eyebrow>
					<H2>A garden that stays free for everyone</H2>
					<Lede>
						Every account receives a bandwidth allowance of free access every month—enough for a few
						hours of 1080p video, far more of music, or thousands of articles. This isn't a trial or
						a trick (we're a non-profit; there's little incentive for either), it's an attempt to
						fulfill what we believe is a common right: for everyone to share and experience
						creativity and community with their neighbors around the world.
					</Lede>
					<p className="mx-auto mt-4 max-w-4xl text-lg leading-relaxed text-base-content/65">
						Anthers-Seeds are how you help keep it that way. Each Seed you point at Anthers covers
						your own streaming at cost, funds the free public content everyone enjoys—creators earn
						from the <strong className="font-semibold text-base-content/80">Time Pool</strong> for
						the time people spend with their public work—and raises your rank, unlocking a growing
						library of Anthers-gated content across every creator. The more the garden fills in, the
						more each Seed gives you.
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
								free viewer's small bandwidth cost is subsidized by the Anthers Foundation, from a
								pool that every Anthers-Seed supports. By sharing the load together, mountains
								diffuse into pebbles—and we all get a healthier internet for it.
							</p>
						</Card>
					</Reveal>
					<Reveal delay={110} className="h-full">
						<Card className="card-lift h-full">
							<h3 style={serif} className="mb-3 text-xl font-medium">
								🎋&nbsp; What Anthers-Seeds add
							</h3>
							<ul className="flex flex-col gap-2.5 text-sm">
								<FreeItem yes>
									A larger monthly streaming allowance, growing with every Seed.
								</FreeItem>
								<FreeItem yes>
									A Time Pool that pays creators for the time you spend with their public work.
								</FreeItem>
								<FreeItem yes>
									A rank that opens a growing library of Anthers-gated content, across every
									creator.
								</FreeItem>
							</ul>
							<p className="mt-4 border-t border-base-content/10 pt-3 text-xs leading-relaxed text-base-content/55">
								Anthers-Seeds are $3 a month each—hold 1 for Root, up to 4+ for Blossom. Supporting
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
									{i === BADGE_LADDER.length - 1 ? "+" : ""} Anthers-Seed{i > 0 ? "s" : ""}
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
								whenever you like. It reaches them 100%, with no fee and no processing skim, and it
								keeps going each month until you change it. Giving Seeds is also how you unlock that
								creator's own gated content.
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
								keep. The creator receives 100% of the listed price. The biggest thing you'll ever
								pay on top is standard card fees and tax (and card fees drop to near-zero if you pay
								by bank transfer).
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
						0% cut. 100% to the creator. We're a non-profit—there's no margin for us to take.
					</p>
				</Reveal>
			</Section>

			{/* ③ Unlocking more — one gating primitive, two directions */}
			<Section tint>
				<Reveal>
					<Eyebrow>③ Unlocking more</Eyebrow>
					<H2>One idea, two directions</H2>
					<Lede>
						Creators can reserve special content for their supporters—and "support" means one simple
						thing: a level of backing, pointed either at the commons or at that creator. Clear
						either one and you're in. It's the same mechanism, just aimed two different ways.
					</Lede>
				</Reveal>
				<div className="mx-auto mt-10 grid max-w-4xl gap-6 text-left md:grid-cols-2">
					<Reveal delay={0} className="h-full">
						<Card className="card-lift h-full">
							<p className="text-xs font-semibold uppercase tracking-wider text-accent">
								Support the commons
							</p>
							<h3 style={serif} className="mb-1 text-xl font-medium">
								Anthers Gates
							</h3>
							<p className="mb-4 text-xs leading-relaxed text-base-content/55">
								Unlocked by the Anthers-Seeds you currently hold—across every creator.
							</p>
							{ANTHERS_GATES.map((g) => (
								<GateRow key={g.name} {...g} />
							))}
						</Card>
					</Reveal>
					<Reveal delay={110} className="h-full">
						<Card className="card-lift h-full">
							<p className="text-xs font-semibold uppercase tracking-wider text-primary/80">
								Support a creator
							</p>
							<h3 style={serif} className="mb-1 text-xl font-medium">
								Seed Gates
							</h3>
							<p className="mb-4 text-xs leading-relaxed text-base-content/55">
								Unlocked by the Seeds you've given that creator—100% to them.
							</p>
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
							Support the creators you love, on terms you can see and trust. Start now with a free
							account you can create in seconds. No ads, no data brokers, free forever.
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

/** A numbered signpost card for the "how it works" section. */
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

/** A ✓ / – line in the "What Anthers-Seeds add" list. */
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
