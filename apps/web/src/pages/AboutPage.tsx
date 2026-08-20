// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The About marketing page — restyled into the Meadow design (matching
// /for-creators and /for-users). Airy editorial forest-green, Fraunces display
// serif over Nunito Sans. The route wraps this page in the shared <MeadowDecor>
// (pollen + woven side vines) and LoggedOutLayout (Meadow footer + grassy
// floor), so this file only styles the content: alternating tinted section
// bands, the eyebrow/heading/lede rhythm, and rounded cards.
//
// 🚨 **This page describes the organization AS IT IS, and as of 2026-08-20 that
// is one person and a state filing.** `Anthers, Inc.` is a Colorado nonprofit
// corporation (2026-08-07, SOS ID 20261969882) with Parker as sole initial
// director. There is no board, the bylaws and the four founding policies are
// drafted and unadopted, and the federal exemption application is not filed.
//
// What was removed on 2026-08-20, and the milestone that earns each back:
//
//   • Three "?" board flip cards (Chair / Treasurer / Secretary) with bios and
//     a *Seeking candidates* tag ....................... the board is seated
//   • A footnote on three-year staggered terms and ED
//     recusal, both from bylaws nobody has adopted ..... the bylaws are adopted
//   • An "Independent Board" governance pillar claiming
//     "authority to override operational decisions" .... the board is seated
//   • "No Private Inurement" resting on *board-approved*
//     compensation (the Articles' prohibition is real
//     and stays; the board approving pay is not) ....... the board is seated
//   • A Reports & Compliance card promising an annual
//     Form 990, Impact Report and independent audit .... each is first published
//
// None of it was a lie about the future and all of it was a claim about the
// present — the same shape as *"where a document claims an absence, that absence
// needs a test"*, arriving from the other side: a reader met a governed
// organization and would have found one person. `about-claims.test.ts` beside
// this file holds the line, one assertion per claim, each naming the milestone
// that lets you delete it. ⚠️ **Delete an assertion in the same commit as the
// milestone, never to make a red test green.**
//
// 🚨 **Federal exemption is not mentioned at all, and that is deliberate.**
// 63.01 § Claims & honesty: don't call it a "501(c)(3)", and don't call the
// exemption "pending" or "applied for" either, because the Form 1023 has not
// been filed. The honest ceiling is *"a Colorado nonprofit corporation"* —
// say nothing about federal status. That is also why "Form 990" is gone rather
// than re-tensed: naming the form invites the phrase back, and "annual public
// filings" says the same thing in the voice this page wants anyway.
//
// **Voice (Parker, 2026-08-20): this is not a court filing and it is not
// marketing language.** It is the most direct, interpersonal page on the site,
// and while Anthers is one person it should read that way — so § Who We Are is
// Parker in the first person and everything around it stays plain. The rest of
// the page keeps "we"; the personal note is visibly his section, which is what
// makes the shift read as candour rather than as a slip.

import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Card, Eyebrow, H2, Lede, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link } from "@anthers/web-shared/router";
import {
	AcademicCapIcon,
	GlobeAltIcon,
	HeartIcon,
	LockClosedIcon,
	MapIcon,
	ScaleIcon,
	ShieldCheckIcon,
	UserGroupIcon,
} from "@heroicons/react/24/outline";

const serif = { fontFamily: FONTS.fraunces };

/* ------------------------------------------------------------------ */
/*  Data                                                               */
/* ------------------------------------------------------------------ */

// The four programme pillars, in the order 60.01 funds them. `fundedNow` marks the
// one that is paid for from the first dollar anyone gives, because free access comes
// out of the same remainder — the other three are commitments with no budget behind
// them yet, and a page showing four equal cards says otherwise.
const FOUNDATION_PILLARS = [
	{
		icon: ShieldCheckIcon,
		title: "Infrastructure Equity",
		description:
			"No creator is priced out of reaching their audience. Anthers subsidizes hosting for small creators, absorbs viral traffic surges, and funds genuinely free access.",
		fundedNow: true,
	},
	{
		icon: AcademicCapIcon,
		title: "Education & Development",
		description:
			"Structured mentorship, financial literacy workshops, and free educational content—connecting people who have knowledge with people who need it.",
	},
	{
		icon: HeartIcon,
		title: "Economic Resilience & Relief",
		description:
			"Creation grants for emerging creators, emergency assistance for those facing hardship, and access to professional services like legal review and tax preparation.",
	},
	{
		icon: GlobeAltIcon,
		title: "Community & Public Benefit",
		description:
			"Open-source tools, published research on creator economics, and partnerships with schools and community organizations that extend the mission beyond the platform.",
	},
];

// What the Articles of Incorporation already do, which is the whole of what can be
// said about Anthers' governance today. Both are in the filing and both are public
// record; neither needs a board or a federal exemption to be true.
const ARTICLES_LOCKS = [
	{
		icon: LockClosedIcon,
		title: "The assets are locked in",
		text: "If Anthers ever stops operating, the Articles send whatever is left to another exempt organization. Not to Parker, and not to anyone else.",
	},
	{
		icon: ScaleIcon,
		title: "Nobody can be paid out",
		text: "The Articles prohibit handing Anthers' earnings to insiders. There are no owners and no shares, so there is nobody positioned to take a share.",
	},
];

/* ------------------------------------------------------------------ */
/*  Page Component                                                     */
/* ------------------------------------------------------------------ */

export default function AboutPage() {
	return (
		<div>
			{/* ───────────── Hero ───────────── */}
			<header className="bg-base-200/70">
				<div className="mx-auto max-w-5xl px-6 pt-24 pb-20 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-5 h-11 w-11 text-primary/60" />
						<p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
							About Anthers
						</p>
						<h1
							style={serif}
							className="text-balance text-5xl font-light leading-[1.05] tracking-tight sm:text-7xl"
						>
							The creative internet{" "}
							<em className="font-medium text-primary not-italic">can work differently.</em>
						</h1>
					</Reveal>
					<Reveal delay={150}>
						<p className="mx-auto mt-8 max-w-4xl text-lg leading-relaxed text-base-content/75">
							Anthers is a federated, open content network for video, audio, text, games, and
							interactive experiences—built and operated as a non-profit so that it is structurally
							incapable of prioritizing profit over people.
						</p>
					</Reveal>
					<Reveal delay={300}>
						<BrandGlyph
							name="divider-botanical"
							className="-mb-20 -mt-5 h-24 w-52 text-primary/45"
						/>
					</Reveal>
				</div>
			</header>

			{/* ───────────── 1. Why We're Here ───────────── */}
			<Section>
				<Reveal>
					<Eyebrow>The problem</Eyebrow>
					<H2>Why We're Here</H2>
					<Lede>
						The creative internet is broken—not by accident, but by design. Commercial platforms are
						structurally incentivized to extract value from creators rather than serve them.
					</Lede>
				</Reveal>

				<div className="mx-auto mt-14 max-w-3xl space-y-10 text-left">
					<Reveal delay={0}>
						<div className="flex flex-col gap-5 md:flex-row md:items-start">
							<div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-2xl text-primary">
								%
							</div>
							<div>
								<h3 style={serif} className="mb-1 text-lg font-medium">
									Escalating Cuts
								</h3>
								<p className="leading-relaxed text-base-content/65">
									Platforms take increasing percentages of creator revenue. They treat the people
									who make the platform valuable as a cost center—and every funding round, every
									IPO, every acquisition shifts incentives further toward extraction.
								</p>
							</div>
						</div>
					</Reveal>

					<Reveal delay={100}>
						<div className="flex flex-col gap-5 md:flex-row md:items-start">
							<div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-secondary/10 text-2xl text-secondary">
								~
							</div>
							<div>
								<h3 style={serif} className="mb-1 text-lg font-medium">
									Algorithmic Manipulation
								</h3>
								<p className="leading-relaxed text-base-content/65">
									What audiences see is optimized for engagement metrics that serve advertisers—not
									for the content people actually asked for. Discovery algorithms systematically
									privilege outrage and lowest-common-denominator content because those things
									generate clicks and ad impressions.
								</p>
							</div>
						</div>
					</Reveal>

					<Reveal delay={200}>
						<div className="flex flex-col gap-5 md:flex-row md:items-start">
							<div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-accent/15 text-2xl text-accent-content">
								&times;
							</div>
							<div>
								<h3 style={serif} className="mb-1 text-lg font-medium">
									Platform Lock-In
								</h3>
								<p className="leading-relaxed text-base-content/65">
									Creator identities, audiences, and livelihoods are held hostage behind proprietary
									walls. Leave, and you lose everything you built. No algorithm change should be
									able to bury a creator's work overnight, and no policy shift should demonetize
									them without recourse.
								</p>
							</div>
						</div>
					</Reveal>
				</div>

				<Reveal>
					<p className="mx-auto mt-12 max-w-xl text-sm italic leading-relaxed text-base-content/50">
						The only way to guarantee a creator-first platform is to remove the profit motive
						entirely—not as a promise, but as a legal and structural constraint.
					</p>
				</Reveal>
			</Section>

			{/* ───────────── 2. What We Do ───────────── */}
			<Section tint>
				<Reveal>
					<Eyebrow>The mission</Eyebrow>
					<H2>What We Do</H2>
					<Lede>
						Anthers advances equity in creative and educational content spaces by providing platform
						infrastructure that is structurally incapable of prioritizing profit over the people it
						serves.
					</Lede>
				</Reveal>

				{/* Mission summary — two-column prose */}
				<div className="mx-auto mt-14 grid max-w-5xl gap-8 text-left md:grid-cols-2">
					<Reveal delay={0} className="h-full">
						<div className="h-full border-l-2 border-primary/30 pl-6">
							<h3 className="mb-3 text-sm uppercase tracking-wider text-primary">For Creators</h3>
							<p className="leading-relaxed text-base-content/65">
								Anthers takes no cut of any support or any direct purchase, and the shared Time Pool
								pays out to creators by time in full. Every dollar a user spends is money to
								creators, the at-cost card processing, or the remainder of what is given to Anthers
								that funds free access and the charitable programs. Anthers, Inc. is a Colorado
								nonprofit corporation—no investors, no profit-taking.
							</p>
						</div>
					</Reveal>
					<Reveal delay={110} className="h-full">
						<div className="h-full border-l-2 border-secondary/30 pl-6">
							<h3 className="mb-3 text-sm uppercase tracking-wider text-secondary">
								For Audiences
							</h3>
							<p className="leading-relaxed text-base-content/65">
								You see what you asked to see. Feeds are chronological and follower-driven by
								default. There are no ads, no data monetization, and no engagement-maximization
								algorithms. You can see exactly where every dollar you give ends up, line by line.
							</p>
						</div>
					</Reveal>
				</div>

				{/* The charitable programs — the heart of the mission */}
				<div className="mt-16">
					<Reveal>
						<h3 style={serif} className="text-2xl font-medium sm:text-3xl">
							Anthers' Charitable Programs
						</h3>
						<p className="mx-auto mt-4 max-w-4xl text-lg leading-relaxed text-base-content/65">
							The programs are the operational heart of Anthers' mission, funded by the remainder of
							what is given to Anthers, plus the half-again on creator storage above the free
							allowance.
						</p>
						<p className="mx-auto mt-4 max-w-4xl text-lg leading-relaxed text-base-content/65">
							Only the first of these four is paid for today. Free access comes out of that same
							remainder from the first dollar anyone gives, so it is funded by the way the model is
							built rather than by a budget we have to find. The other three are commitments with no
							budget behind them yet, and the{" "}
							<Link to="/roadmap" className="link link-primary">
								public roadmap
							</Link>{" "}
							carries the order we expect to reach them in.
						</p>
					</Reveal>
					<div className="mx-auto mt-10 grid max-w-4xl gap-6 text-left md:grid-cols-2">
						{FOUNDATION_PILLARS.map((pillar, i) => (
							<Reveal key={pillar.title} delay={i * 100} className="h-full">
								<Card className="card-lift flex h-full flex-row gap-4">
									<div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-secondary/10 text-secondary">
										<pillar.icon className="h-6 w-6" />
									</div>
									<div>
										<h3 style={serif} className="mb-1 text-lg font-medium">
											{pillar.title}
										</h3>
										{pillar.fundedNow && (
											<p className="mb-1 text-xs uppercase tracking-wider text-secondary">
												Funded from day one
											</p>
										)}
										<p className="text-sm leading-relaxed text-base-content/65">
											{pillar.description}
										</p>
									</div>
								</Card>
							</Reveal>
						))}
					</div>
					<Reveal>
						<div className="mt-10">
							<Link to="/subscribe" className="btn btn-primary rounded-full px-7">
								See Where Your Money Goes
							</Link>
						</div>
					</Reveal>
				</div>
			</Section>

			{/* ───────────── 3. How We Do It ───────────── */}
			<Section>
				<Reveal>
					<Eyebrow>By design</Eyebrow>
					<H2>How We Do It</H2>
					<Lede>
						Some of this is already true and some of it is a commitment we haven't delivered on yet.
						The difference matters, so each one below tells you which it is.
					</Lede>
				</Reveal>

				{/* Numbered principles — vertical timeline layout */}
				<div className="relative mx-auto mt-14 max-w-2xl text-left">
					{/* Vertical line */}
					<div className="absolute left-6 top-0 bottom-0 hidden w-px bg-primary/15 md:block" />

					<div className="space-y-10">
						{[
							{
								num: "01",
								title: "Creators Own Everything",
								text: "The platform is open source under the AGPL, and everything a creator makes is one click from a file on their own machine. The rest of the promise—federation, creators running their own nodes, a presence no single entity can revoke—is a direction we are committed to and have not built yet. It is the point of the whole track, and we would rather signpost it than imply it already works.",
							},
							{
								num: "02",
								title: "Audiences Choose What They See",
								text: "The default feed is chronological and subscriber-driven. Algorithmic discovery is available as an opt-in mode, never the primary experience. Anthers has no ads and nothing to gain from capturing your attention—creators are funded by the time you choose to spend with their work, not by an algorithm built to keep you scrolling.",
							},
							{
								num: "03",
								title: "Funding Flows Directly",
								text: "Money enters through monthly support (given to a creator, or to Anthers) and direct purchases. Every dollar is money to creators, the at-cost card processing, or the remainder of what is given to Anthers. As a non-profit, Anthers takes no profit—that remainder funds free access and the charitable programs.",
							},
							{
								num: "04",
								title: "The Profit Motive Is Structurally Eliminated",
								text: "Not voluntarily set aside — absent. Anthers, Inc. has no owners and no shares, so there is nobody to distribute a profit to, nothing to sell, and no investor to take on. If it ever dissolves, the Articles send its assets to another exempt organization. This one is done, and it was done the day the incorporation was filed.",
							},
							{
								num: "05",
								title: "No Single Entity Can Rug-Pull the Network",
								text: "Federation is meant to make the network resilient to external pressure; non-profit incorporation already makes the organization resilient to internal corruption. Both are necessary and neither is sufficient alone — which is why the second is done and the first is a commitment rather than a claim.",
							},
						].map((item, i) => (
							<Reveal key={item.num} delay={i * 100}>
								<div className="relative flex items-start gap-6">
									<div className="z-10 flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
										{item.num}
									</div>
									<div className="pt-1.5">
										<h3 style={serif} className="mb-1 text-lg font-medium">
											{item.title}
										</h3>
										<p className="text-sm leading-relaxed text-base-content/65">{item.text}</p>
									</div>
								</div>
							</Reveal>
						))}
					</div>
				</div>
			</Section>

			{/* ───────────── 4. Who We Are ───────────── */}
			<Section tint>
				<Reveal>
					<Eyebrow>The team</Eyebrow>
					<H2>Who We Are</H2>
					<Lede>
						Right now, Anthers is one person. That's worth saying plainly, and saying it here rather
						than leaving you to work it out.
					</Lede>
				</Reveal>

				<Reveal className="mx-auto mt-14 block max-w-3xl">
					<Card className="text-left">
						<div className="mb-6 flex items-center gap-4">
							<div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-primary/10">
								<span className="text-2xl font-bold text-primary">P</span>
							</div>
							<div>
								<h3 style={serif} className="text-lg font-medium">
									Parker
								</h3>
								<p className="text-sm text-base-content/50">Founder</p>
							</div>
						</div>
						<div className="space-y-4 leading-relaxed text-base-content/70">
							<p>
								Hi — I'm Parker. I do the architecture, the engineering, the product and the
								operations, which is a long way of saying I do all of it. Anthers, Inc. is filed and
								real, and I'm currently its only director. There's no board yet, no staff, and
								nobody else to blame when something breaks.
							</p>
							<p>
								I'd rather tell you that than show you an org chart with empty chairs in it.
								Everything on this page is either something that already exists or something I've
								said out loud that I intend to do, and I've tried to keep the two clearly apart.
							</p>
						</div>
					</Card>
				</Reveal>

				<Reveal className="mx-auto mt-6 block max-w-3xl">
					<Card className="flex flex-col gap-4 text-left sm:flex-row">
						<div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-secondary/10 text-secondary">
							<UserGroupIcon className="h-6 w-6" />
						</div>
						<div>
							<h3 style={serif} className="mb-2 text-lg font-medium">
								Anthers is looking for its founding board
							</h3>
							<p className="leading-relaxed text-base-content/65">
								A working board of three to five people is the next real step for the organization,
								and every seat is open. What it asks for is time and judgment rather than a name on
								a page — someone to chair meetings, someone comfortable reading a budget, someone to
								keep the records straight, and at least one person whose view of the creator economy
								is nothing like mine. If that sounds like you, or like someone you know, write to{" "}
								<a className="link link-primary" href="mailto:contact@anthers.org">
									contact@anthers.org
								</a>
								.
							</p>
						</div>
					</Card>
				</Reveal>
			</Section>

			{/* ───────────── 5. Non-profit by design ───────────── */}
			<Section>
				<Reveal>
					<Eyebrow>Non-profit by design</Eyebrow>
					<H2>A Colorado Nonprofit Corporation</H2>
					<Lede>
						Anthers, Inc. was incorporated in Colorado on August 7, 2026. Being a non-profit isn't a
						mood we're in — the Articles of Incorporation are a public record, and two of the things
						they say are things a promise couldn't say.
					</Lede>
					{/* The one hard fact on this page, made checkable. Everything else here is either
					    something you can see working or something we've said we intend to do; this is
					    the one you can go and verify without taking our word for any of it. */}
					<p className="mx-auto mt-4 max-w-2xl text-sm text-base-content/50">
						You can look it up — Colorado Secretary of State ID 20261969882.
					</p>
				</Reveal>

				{/* What the Articles already do */}
				<div className="mx-auto mt-14 grid max-w-3xl grid-cols-1 gap-8 sm:grid-cols-2">
					{ARTICLES_LOCKS.map((item, i) => (
						<Reveal key={item.title} delay={i * 100}>
							<div className="text-center">
								<div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
									<item.icon className="h-7 w-7" />
								</div>
								<h3 style={serif} className="mb-1 text-base font-medium">
									{item.title}
								</h3>
								<p className="text-sm leading-relaxed text-base-content/55">{item.text}</p>
							</div>
						</Reveal>
					))}
				</div>

				{/* What comes next */}
				<Reveal className="mx-auto mt-14 block max-w-3xl">
					<Card className="text-left">
						<div className="mb-5 flex items-center gap-2">
							<MapIcon className="h-6 w-6 text-primary" />
							<h3 style={serif} className="text-xl font-medium">
								What comes next
							</h3>
						</div>
						<p className="mb-5 leading-relaxed text-base-content/65">
							Most of what a grown-up non-profit has, Anthers doesn't have yet. Here's what we know
							we owe you, roughly in the order we expect to get there:
						</p>
						<ul className="space-y-4 text-base-content/65">
							{[
								"A founding board, seated as the right people are found rather than to a date on a calendar.",
								"Bylaws and the founding governance policies, which are drafted and which the board adopts once there is a board to adopt them.",
								"Annual public reporting on where the money actually went, once there's a year of it worth reporting on.",
							].map((line) => (
								<li key={line} className="flex gap-3 leading-relaxed">
									<span
										aria-hidden
										className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50"
									/>
									<span>{line}</span>
								</li>
							))}
						</ul>
						<p className="mt-5 leading-relaxed text-base-content/65">
							The{" "}
							<Link to="/roadmap" className="link link-primary">
								public roadmap
							</Link>{" "}
							carries the rest of the sequence, for the organization and the platform both. Where it
							gives timing, read that as our current best guess rather than a commitment.
						</p>
					</Card>
				</Reveal>
			</Section>

			{/* ───────────── Closing CTA ───────────── */}
			<section className="bg-base-200/70">
				<div className="mx-auto max-w-6xl px-6 py-28 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-6 h-14 w-14 text-primary/70" />
						<h2
							style={serif}
							className="text-balance text-4xl font-light leading-tight sm:text-5xl"
						>
							Built to serve creators. Structurally incapable of doing otherwise.
						</h2>
						<p className="mx-auto mt-5 max-w-4xl text-lg leading-relaxed text-base-content/70">
							Whether you create games, videos, music, writing, or interactive experiences—Anthers
							is designed so that every dollar flows to the people who make the platform valuable.
						</p>
						<div className="mt-8 flex flex-wrap justify-center gap-3">
							<Link to="/subscribe" className="btn btn-primary rounded-full px-7">
								Support Creators
							</Link>
							<Link
								to="/for-creators"
								className="btn btn-outline rounded-full border-base-content/20 px-7"
							>
								Start Creating
							</Link>
						</div>
					</Reveal>
				</div>
			</section>
		</div>
	);
}
