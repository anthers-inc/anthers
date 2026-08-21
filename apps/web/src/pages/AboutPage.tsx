// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The About marketing page, in the Meadow design (matching /for-creators and
// /for-users). The route wraps this page in the shared <MeadowDecor> and
// LoggedOutLayout, so this file only styles the content: alternating tinted
// bands, the eyebrow/heading/lede rhythm, cards, and plain prose columns.
//
// ── The order of the page is the argument ────────────────────────────────────
//
// Settled by Parker, 2026-08-21: **what → what that means → what we're for →
// who's running it**. State the plainest, most fundamental fact first (Anthers,
// Inc. is a Colorado nonprofit corporation), then what that fact actually binds,
// then the mission, then the person. An earlier arrangement opened on the mission
// and reached the organization in section five, which buries the one thing a
// reader came here to establish.
//
// ── What this page owns, and what it must not grow back ──────────────────────
//
// Rebuilt 2026-08-21 from ~15,000px and six sections, because the previous
// version argued a case where an About page describes an organization. Every
// reference on the brief — ProPublica, Blender, Alveus, the Mozilla Foundation —
// is a mission line and a handful of paragraphs, and none of them annotates its
// own claims. **For a young organization the honest move is to say less, not to
// hedge more**: the old page carried four programme pillars with a paragraph
// explaining three had no budget, and federation as a numbered principle with a
// disclaimer attached. Cutting them removed the hedging along with them.
//
// Three body sections is the whole scope:
//
//   1. What Anthers is ... the corporate facts, then two lists — what binds us
//                          NOW under the Colorado Act and our own Articles, and
//                          what federal recognition would ADD. Sourced from the
//                          Articles' additional-information attachment (51 §
//                          `Anthers AOI - Additional Information.docx`), not
//                          from a summary of it.
//   2. The mission ....... two cards, What We Do and How We Do It, lifted from
//                          parkerhdavis.com's own structure. The three-card
//                          indictment of commercial platforms is gone; the case
//                          against the incumbents is the section's lede, and it
//                          gets a whole section on /for-creators.
//   3. Who we are ........ Parker, first person, portrait beside the prose.
//
// The programme pillars, the founding-board invitation and the "what comes next"
// list are all on /roadmap already. **This page says what is true; the roadmap
// says when.** That division is why nothing here promises a date.
//
// ── 🚨 Federal status: the rule CHANGED on 2026-08-21 ────────────────────────
//
// 63.01 § Claims & honesty used to read *"say nothing about federal status at
// all"*, and this page said nothing. **Parker's call is that the page states the
// intention** — the two-list structure below is what makes that safe, because it
// partitions present from future explicitly rather than leaving a reader to guess
// which column a sentence belongs in. 63.01 carries the narrowed rule now.
//
// What did NOT change, and what `about-claims.test.ts` still holds:
//
//   • Anthers may not be CALLED a 501(c)(3), or described as tax-exempt, or as
//     having a pending or filed application. The Form 1023 has not been filed.
//   • No money given to Anthers may be called deductible **today**. Where the
//     "soon" column says donations become deductible, the sentence beside it
//     says they are not yet — same co-presence rule as "free forever" and the
//     monthly limit, and the guard asserts the pairing.
//   • ⚠️ **No date.** Parker's note proposed "later this year"; 51.03 puts the
//     Form 1023 deadline at 2028-11-30, counsel is on its critical path and none
//     is engaged, and the organizational meeting has not happened. A date is a
//     claim about the future the project's own sequencing does not support, so
//     the copy states the intention without one. Add a date only when the plan
//     has one.
//
// ── Voice ────────────────────────────────────────────────────────────────────
//
// **This is not a court filing and it is not marketing language** (Parker,
// 2026-08-20). It is the most direct, interpersonal page on the site, and while
// Anthers is one person it should read that way — so § Who We Are is Parker in
// the first person and everything around it stays plain. The rest of the page
// keeps "we". ⚠️ Keep the registers apart: an "I" that wanders into § What
// Anthers Is is the slip.
//
// 🚨 **Do not make a virtue of being small** (Parker, 2026-08-21). An earlier
// draft headed the last section *"Anthers Is One Person"* over a lede about how
// pages like this usually find a way around saying so — which dresses an ordinary
// fact as courage. People can count. What the section is actually for is the
// thing every organization owes a reader: here is who we are.
//
// 🚨 **The reference for the first-person passages is Parker's own about page,
// and its source is on this machine at `~/Daisy/apps/web/src/pages/about.tsx`** —
// read it rather than writing a founder's-note register from scratch, which is
// what an earlier draft did and got wrong. What that page does: it **opens
// declaratively** ("I'm a director, developer, writer, and composer from
// Colorado"), never with a greeting; it builds **long multi-clause sentences**
// rather than punchy short ones; its humour is **dry and rare** ("wore more hats
// than I can count" is as far as an entire page goes); and it **lands a thought
// on a stated principle** ("It matters how we do things, even more than what we
// aim to do"), set in bold, not on a quip. Its **What I Do / How I Do It** pair
// is where this page's two mission cards come from, down to the lock and key.
//
// The hero is 63.01 § The canonical introduction, verbatim, split across the
// headline and the lede. Quote it rather than writing a fresh introduction, so
// the platform sounds like one thing wherever a reader meets it. ⚠️ It replaced
// a hero reading *"Anthers is a federated, open content network…"*, which
// asserted federation that has not shipped — `RETIRED_COPY` carries a rule for
// the wording now, since its ATProto rule matched the claim's other phrasings
// and sailed straight past this one.
//
// ⚠️ A big italic Fraunces display line was tried here as a mission pull-quote
// and rejected on sight — at that size the face reads as a wedding invitation.
// Fraunces stays on the section headings, upright, where the rest of the site
// uses it.

import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Card, Eyebrow, H2, Lede, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link } from "@anthers/web-shared/router";
import { KeyIcon, LockOpenIcon } from "@heroicons/react/24/outline";

const serif = { fontFamily: FONTS.fraunces };

/* ------------------------------------------------------------------ */
/*  Data                                                               */
/* ------------------------------------------------------------------ */

// What the Colorado Act and Anthers' own filed Articles already bind, quoted from
// the additional-information attachment rather than from anyone's summary of it.
// Each of these survives the test 63.01 § Claims & honesty sets — it still holds
// with one director and no federal recognition — because each is in the filing.
const BINDING_NOW = [
	"There are no owners and no shares, and the Articles give Anthers no voting members. Nobody holds a piece of it, so there is nobody to pay a profit to and nothing for anyone to buy.",
	"Nothing Anthers earns may be paid out to anyone inside it. The Articles bar its net earnings from benefiting a director, an officer, or any private person, and require it to serve public rather than private interests. What it may pay is ordinary compensation for work actually done.",
	"If Anthers ever dissolves, its assets go to another charitable organization or to a government for a public purpose — not to a founder, and not to anyone who worked here.",
	"Anthers' purposes are fixed in the Articles, and they are specific: making creative and educational work freely available to the public, releasing the platform's technology under open-source licences, publishing the formats it stores work in so that others can build on or replace it, and enabling creators to host and deliver their own work independently of Anthers.",
];

// What federal recognition would add, chosen for the three people who actually
// need to know — someone deciding whether to publish here, someone deciding
// whether to support a creator here, and someone deciding whether to fund us.
// ⚠️ The first line carries its own present-tense correction; see the header.
const BINDING_SOON = [
	"Donations to Anthers become tax-deductible for the person making them. Until the determination letter arrives, they are not — and we will not say otherwise.",
	"Anthers becomes eligible for the grants and the non-profit rates that foundations and vendors reserve for recognized charities, which is money and service going into the platform rather than out of it.",
	"Anthers' finances become a matter of public record, published every year, so anyone can check what came in and where it went.",
	"The prohibition on paying insiders stops resting on our own Articles alone and becomes something the federal government enforces.",
];

/* ------------------------------------------------------------------ */
/*  Page Component                                                     */
/* ------------------------------------------------------------------ */

/** One of the two fact columns in § What Anthers Is. */
function FactCard({ title, note, items }: { title: string; note: string; items: string[] }) {
	return (
		<Card className="flex h-full flex-col text-left">
			<h3 style={serif} className="text-xl font-medium">
				{title}
			</h3>
			<p className="mt-1 text-sm text-base-content/50">{note}</p>
			<ul className="mt-5 space-y-4 leading-relaxed text-base-content/70">
				{items.map((item) => (
					<li key={item} className="flex gap-3">
						<span aria-hidden className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" />
						<span>{item}</span>
					</li>
				))}
			</ul>
		</Card>
	);
}

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
							A non-profit creative garden{" "}
							<em className="font-medium text-primary not-italic">for everyone.</em>
						</h1>
					</Reveal>
					<Reveal delay={150}>
						<p className="mx-auto mt-8 max-w-3xl text-lg leading-relaxed text-base-content/75">
							A place for videos, games, music, writing, crafts, services, and more, all on an
							open-source, ad-free platform. A harmonious ecosystem where we can all nurture a
							creative internet worth loving again.
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

			{/* ───────────── 1. What Anthers is ───────────── */}
			<Section>
				<Reveal>
					<Eyebrow>The organization</Eyebrow>
					<H2>What Anthers Is</H2>
					<Lede>
						Anthers, Inc. is a Colorado nonprofit corporation, Secretary of State ID 20261969882,
						and we will be filing for federal 501(c)(3) recognition. Those are two different things,
						and each of them binds us in a different way.
					</Lede>
				</Reveal>

				<div className="mx-auto mt-12 grid max-w-5xl gap-6 md:grid-cols-2">
					<Reveal className="h-full">
						<FactCard
							title="What that means now"
							note="In force since incorporation"
							items={BINDING_NOW}
						/>
					</Reveal>
					<Reveal delay={110} className="h-full">
						<FactCard
							title="What that means soon"
							note="What federal recognition adds"
							items={BINDING_SOON}
						/>
					</Reveal>
				</div>
			</Section>

			{/* ───────────── 2. The mission ───────────── */}
			<Section tint>
				<Reveal>
					<Eyebrow>The mission</Eyebrow>
					<H2>What Anthers Is For</H2>
					<Lede>
						Nearly every platform hosting creative work today answers to shareholders, and a
						platform that answers to shareholders will eventually be asked to take a little more
						from the people on it, and then a little more after that. Anthers has nobody to ask.
					</Lede>
				</Reveal>

				<div className="mx-auto mt-12 grid max-w-5xl gap-6 md:grid-cols-2">
					<Reveal className="h-full">
						<Card className="flex h-full flex-col text-left">
							<h3 style={serif} className="mb-4 flex items-center gap-3 text-xl font-medium">
								<LockOpenIcon className="h-6 w-6 shrink-0 text-primary" />
								What We Do
							</h3>
							<div className="space-y-4 leading-relaxed text-base-content/70">
								<p>
									Anthers is a place to publish creative work of every kind — a game, an album, a
									film, an essay, a comic, a course, a piece of software — and to be paid for it by
									the people who come for it.
								</p>
								<p>
									A creator publishes here and decides for themselves how their work is met: free
									for anyone, behind a monthly amount they set, or for sale outright. They name
									their own support levels and choose what each one carries.
								</p>
								<p>
									Making an account takes an email address and nothing else. A free account can
									stream {FREE_PUBLIC_ACCESS_HOURS} hours a month of everything creators have left
									open to everyone, free forever, and supporting Anthers removes that limit.
								</p>
							</div>
						</Card>
					</Reveal>
					<Reveal delay={110} className="h-full">
						<Card className="flex h-full flex-col text-left">
							<h3 style={serif} className="mb-4 flex items-center gap-3 text-xl font-medium">
								<KeyIcon className="h-6 w-6 shrink-0 text-primary" />
								How We Do It
							</h3>
							<div className="space-y-4 leading-relaxed text-base-content/70">
								<p>
									What a creator earns, they keep. Anthers takes no cut of a sale or of support
									given to a creator, and the only deduction is card processing, which is paid to
									the card processor rather than kept by us.
								</p>
								<p>
									There is no advertising on Anthers and there never will be. Audiences see what
									they asked to see, in the order it was published, rather than what an algorithm
									decided would hold them longest. Support given to Anthers is the one place our own
									money comes from — half of it pays creators for the time people spend with their
									work, and what's left funds free access and Anthers' charitable programs.
									{/* ⚠️ "half" is the ONE money figure typed into this page, and prose is the
									    only place it reads well — 50% is colder and the `econ:figures` marker
									    blocks are for tables. It is pinned instead: about-claims.test.ts asserts
									    the word against TIME_POOL_RATE, so moving the rate turns this sentence
									    red rather than wrong. */}
								</p>
								<p>
									The whole platform is open source, and everything a creator makes is one click
									from a file on their own machine. Hosting with us is meant to be a convenience,
									never a requirement.
								</p>
							</div>
						</Card>
					</Reveal>
				</div>

				<Reveal delay={220}>
					<p className="mt-10 text-base-content/70">
						<Link to="/subscribe" className="link link-primary">
							See where every dollar goes
						</Link>
						, line by line.
					</p>
				</Reveal>
			</Section>

			{/* ───────────── 3. Who we are ───────────── */}
			<Section>
				<Reveal>
					<Eyebrow>Who we are</Eyebrow>
					<H2>Meet Parker</H2>
					<Lede>
						Right now, Anthers is one person. That will change as the organization grows; for now,
						here is who is running it.
					</Lede>
				</Reveal>

				<Reveal delay={120} className="mx-auto mt-12 block max-w-5xl">
					<Card className="text-left">
						<div className="flex flex-col gap-8 md:flex-row md:items-start">
							{/* 📷 PORTRAIT SLOT — drop the file at `apps/web/public/images/parker.jpg`
							    (served from the site root as `/images/parker.jpg`, since build.ts copies
							    public/ into dist/) and replace this block with:

							      <img
							          src="/images/parker.jpg"
							          alt="Parker H. Davis"
							          className="w-full shrink-0 rounded-2xl object-cover md:w-64"
							      />

							    Portrait-ish crop, roughly 4:5, ~800px on the short edge is plenty. It sits
							    at 16rem wide beside the prose on desktop and full-width above it on a
							    phone. The placeholder below keeps the layout honest until the file lands —
							    a missing <img> would 404 in the screenshot harness and read as a bug. */}
							<div className="flex aspect-4/5 w-full shrink-0 items-center justify-center rounded-2xl bg-primary/10 md:w-64">
								<span style={serif} className="text-6xl font-light text-primary/70">
									P
								</span>
							</div>
							<div className="space-y-5 leading-relaxed text-base-content/70">
								<div>
									<h3 style={serif} className="text-xl font-medium text-base-content">
										Parker H. Davis
									</h3>
									<p className="text-sm text-base-content/50">Founder</p>
								</div>
								<p>
									I'm Parker: a director, developer, writer, and composer from Colorado, and
									Anthers' founder and, for now, its only director.
								</p>
								<p>
									My earliest creative work was in music production, which turned into freelance
									filmmaking, which turned into a decade in game development where I led teams,
									shipped titles, and wore more hats than I can count. Every medium I have worked in
									and every creative I have worked alongside has deepened my sense of what it takes
									to do this work well — and of how much of it turns on things that have nothing to
									do with the work itself: whether you can afford to keep going, whether the people
									who would love what you make are ever shown it, and whether the terms you agreed
									to last year still mean what they meant when you agreed to them.
								</p>
								<p>
									I have never found anything as worth doing as helping other people feel encouraged
									and equipped to share what they make, and Anthers is that same impulse built out
									into something other people can use. I want a creator's relationship with their
									audience to be the most honest one either of them has, and I want what a creator
									earns to be theirs.
								</p>
								<p>
									<strong>It matters how we do things, even more than what we aim to do.</strong>{" "}
									That is the principle I have built every collaboration of mine on, and it is why
									Anthers is shaped the way it is: I would rather hand you a structure you can check
									than a promise you have to take my word for.
								</p>
							</div>
						</div>
					</Card>
				</Reveal>
			</Section>

			{/* ───────────── Closing ───────────── */}
			<section className="bg-base-200/70">
				<div className="mx-auto max-w-4xl px-6 py-24 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-6 h-14 w-14 text-primary/70" />
						<h2
							style={serif}
							className="text-balance text-4xl font-light leading-tight sm:text-5xl"
						>
							Have a look around
						</h2>
						<p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-base-content/70">
							Whether you make things or you'd just like to find good ones, you're welcome here.
						</p>
						<div className="mt-8 flex flex-wrap justify-center gap-3">
							<Link to="/subscribe" className="btn btn-primary rounded-full px-7">
								Support a creator
							</Link>
							<Link
								to="/for-creators"
								className="btn btn-outline rounded-full border-base-content/20 px-7"
							>
								Start creating
							</Link>
						</div>
					</Reveal>
				</div>
			</section>
		</div>
	);
}
