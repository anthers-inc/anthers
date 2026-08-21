// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The About marketing page, in the Meadow design (matching /for-creators and
// /for-users). The route wraps this page in the shared <MeadowDecor> and
// LoggedOutLayout, so this file only styles the content: alternating tinted
// bands, the eyebrow/heading/lede rhythm, and plain prose columns.
//
// 🚨 **This page describes the organization AS IT IS, and that is one person, a
// state filing, and a working platform.** `Anthers, Inc.` is a Colorado nonprofit
// corporation (SOS ID 20261969882) with Parker as sole initial director. There is
// no board, the bylaws and the founding policies are drafted and unadopted, and
// the federal exemption application is not filed. `about-claims.test.ts` beside
// this file holds that line — one assertion per claim we may not yet make, each
// naming the milestone that lets you delete it. ⚠️ **Delete an assertion in the
// same commit as the milestone, never to make a red test green.**
//
// 🚨 **Federal exemption is not mentioned at all, and that is deliberate.**
// 63.01 § Claims & honesty: don't call it a "501(c)(3)", and don't call the
// exemption "pending" or "applied for" either, because the Form 1023 has not been
// filed. The honest ceiling is *"a Colorado nonprofit corporation"* — say nothing
// about federal status. Naming the annual return invites the phrase back, so this
// page says "published annual reporting" and lets /roadmap carry the form number.
//
// ── What this page owns, and what it must not grow back ──────────────────────
//
// Rebuilt 2026-08-21, from ~15,000px down to four sections, because the previous
// version argued a case where an About page describes an organization. Every
// reference Parker chose — ProPublica, Blender, Alveus, the Mozilla Foundation —
// is a mission line and a handful of paragraphs, and none of them annotates its
// own claims. **For a young organization the honest move is to say less, not to
// hedge more**: the old page carried four programme pillars with a paragraph
// explaining three had no budget, and federation as a numbered principle with a
// disclaimer attached. Cutting them removed the hedging along with them.
//
// So the four sections are the whole scope, and each names what it deliberately
// does NOT carry:
//
//   1. The mission ....... one sentence, then two paragraphs. The case against
//                          the incumbents is ONE CLAUSE here; the three-card
//                          indictment lives on /for-creators.
//   2. What we do ........ publishing, access, money — in prose, no prices.
//                          The itemized breakdown is /subscribe's job, and
//                          keeping a price off this page is also what keeps it
//                          clear of 63.01's co-presence rules.
//   3. Why a non-profit .. the CONSEQUENCES (no owners, no shares, asset lock),
//                          not the filing. A filing date is paperwork; nobody
//                          reads an About page to learn one. The SOS ID stays,
//                          because on a page about trustworthiness one checkable
//                          fact outweighs several unverifiable ones.
//   4. Who we are ........ Parker, first person, signed.
//
// The programme pillars, the founding-board invitation, the "what comes next"
// list and the federation track are all on /roadmap already. **This page says
// what is true; the roadmap says when.** That division is why nothing here
// promises a date.
//
// **Voice (Parker, 2026-08-20): this is not a court filing and it is not
// marketing language.** It is the most direct, interpersonal page on the site,
// and while Anthers is one person it should read that way — so § Who We Are is
// Parker in the first person and everything around it stays plain. The rest of
// the page keeps "we"; the personal note is visibly his section, which is what
// makes the shift read as candour rather than as a slip. ⚠️ Keep the registers
// apart: an "I" that wanders into § Why a non-profit is the slip.
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
// aim to do"), set in bold, not on a quip. Note this page's **"What We Do"**
// heading is lifted from that site too — the structure was his before the prose
// was.
//
// The hero is 63.01 § The canonical introduction, verbatim, split across the
// headline and the lede. Quote it rather than writing a fresh introduction, so
// the platform sounds like one thing wherever a reader meets it. ⚠️ It replaced
// a hero reading *"Anthers is a federated, open content network…"*, which
// asserted federation that has not shipped — `RETIRED_COPY` carries a rule for
// the wording now, since its ATProto rule matched the claim's other phrasings
// and sailed straight past this one.

import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Card, Eyebrow, H2, Lede, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link } from "@anthers/web-shared/router";

const serif = { fontFamily: FONTS.fraunces };

/** The prose column the descriptive sections share — left-aligned inside a centered band. */
const PROSE =
	"mx-auto mt-12 max-w-3xl space-y-6 text-left text-lg leading-relaxed text-base-content/70";

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

			{/* ───────────── 1. The mission ───────────── */}
			<Section>
				<Reveal>
					<Eyebrow>The mission</Eyebrow>
					{/* The mission sentence IS the heading here, set as a pull-quote — the shape
					    ProPublica and Blender both use, and the reason this section needs no
					    other title. Keep it one sentence; the moment it needs a second, it has
					    stopped being a mission and started being a summary of the page. */}
					<h2
						style={serif}
						className="mx-auto max-w-4xl text-balance text-2xl font-light italic leading-snug sm:text-4xl"
					>
						To give creative work a home that belongs to the people who make it and the people who
						love it, and to build it so that nobody can come between them.
					</h2>
				</Reveal>

				<Reveal delay={120} className={PROSE}>
					<p>
						Anthers is a place to publish creative work of every kind — a game, an album, a film, an
						essay, a comic, a course, a piece of software — and to be paid for it by the people who
						come for it. Creators keep their work and keep what they earn. Audiences see what they
						asked to see, in the order it was published, with nothing sold in between.
					</p>
					<p>
						None of that is unusual to want, and all of it is difficult to find, because nearly
						every platform hosting creative work today answers to shareholders — and a platform that
						answers to shareholders will eventually be asked to take a little more from the people
						on it, and then a little more after that. Anthers is organized so that there is nobody
						to ask.
					</p>
				</Reveal>
			</Section>

			{/* ───────────── 2. What we do ───────────── */}
			<Section tint>
				<Reveal>
					<Eyebrow>The platform</Eyebrow>
					<H2>What We Do</H2>
					<Lede>
						Creators publish and set their own terms. Audiences watch, play, read and listen. What
						an audience pays a creator goes to that creator, and Anthers takes no cut of it.
					</Lede>
				</Reveal>

				<Reveal delay={120} className={PROSE}>
					<p>
						A creator publishes here and decides for themselves how their work is met: free for
						anyone, behind a monthly amount they set, or for sale outright. They name their own
						support levels and choose what each one carries. The whole platform is open source, and
						everything a creator makes is one click from a file on their own machine — hosting with
						us is meant to be a convenience, never a requirement.
					</p>
					<p>
						Making an account takes an email address and nothing else. A free account can stream{" "}
						{FREE_PUBLIC_ACCESS_HOURS} hours a month of everything creators have left open to
						everyone, free forever, and supporting Anthers removes that limit. Anything you buy is
						yours to download as often as you like, on as many devices as you like, at no further
						cost.
					</p>
					<p>
						There is no advertising on Anthers and there never will be. What a creator earns, they
						keep: Anthers takes no cut of a sale or of support given to a creator, and the only
						deduction is card processing, which is paid to the card processor rather than kept by
						us. Support given to Anthers is the one place our own money comes from — half of it pays
						creators for the time people spend with their work, and what's left funds free access
						and Anthers' charitable programs.
						{/* ⚠️ "half" is the ONE money figure typed into this page, and prose is the only
						    place it reads well — 50% is colder and the `econ:figures` marker blocks are
						    for tables. It is pinned instead: about-claims.test.ts asserts the word against
						    TIME_POOL_RATE, so moving the rate turns this sentence red rather than wrong. */}
					</p>
					<p>
						<Link to="/subscribe" className="link link-primary">
							See where every dollar goes
						</Link>
						, line by line.
					</p>
				</Reveal>
			</Section>

			{/* ───────────── 3. Why a non-profit ───────────── */}
			<Section>
				<Reveal>
					<Eyebrow>Non-profit by design</Eyebrow>
					<H2>Nobody Owns Anthers</H2>
					<Lede>
						Anthers, Inc. is a Colorado nonprofit corporation, and the useful part of that is not
						the paperwork. It is what the paperwork makes impossible.
					</Lede>
				</Reveal>

				<Reveal delay={120} className={PROSE}>
					<p>
						There are no owners and no shares. Nobody holds a piece of Anthers, so there is nobody
						to pay a profit to, nothing for an investor to buy a say in, and no acquisition to be
						had. If Anthers ever stops operating, whatever is left of it goes to another non-profit
						rather than to a founder, a director, or anyone who worked here. Those are not
						commitments we are asking you to trust: they are in the Articles of Incorporation, which
						are public record, and which cannot be changed without that change being public too.
					</p>
					<p>
						A company can mean every word of a commitment like that and still be structurally free
						to abandon it later, once there are investors to answer to or a buyer at the door. We
						would rather not be able to.
					</p>
					{/* The one hard fact on this page, made checkable. Everything else here is either
					    something you can see working or something we've said we intend to do; this is
					    the one you can go and verify without taking our word for any of it. */}
					<p className="text-base text-base-content/50">
						You can look it up: Anthers, Inc., Colorado Secretary of State ID 20261969882.
					</p>
					<p>
						That part is finished. Most of what an established non-profit has is not — a seated
						board, adopted bylaws, published annual reporting on where the money actually went. All
						of it is ahead of us rather than behind us, and the{" "}
						<Link to="/roadmap" className="link link-primary">
							public roadmap
						</Link>{" "}
						carries the order we expect to reach it in.
					</p>
				</Reveal>
			</Section>

			{/* ───────────── 4. Who we are ───────────── */}
			<Section tint>
				<Reveal>
					<Eyebrow>Who we are</Eyebrow>
					<H2>Anthers Is One Person</H2>
					<Lede>
						That is worth saying outright, because it is the sort of thing a page like this usually
						finds a way around.
					</Lede>
				</Reveal>

				<Reveal delay={120} className="mx-auto mt-12 block max-w-3xl">
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
						<div className="space-y-5 leading-relaxed text-base-content/70">
							<p>
								I'm Parker: a director, developer, writer, and composer from Colorado, and Anthers'
								founder and, for now, its only director.
							</p>
							<p>
								My earliest creative work was in music production, which turned into freelance
								filmmaking, which turned into a decade in game development where I led teams,
								shipped titles, and wore more hats than I can count. Every medium I have worked in
								and every creative I have worked alongside has deepened my sense of what it takes to
								do this work well — and of how much of it turns on things that have nothing to do
								with the work itself: whether you can afford to keep going, whether the people who
								would love what you make are ever shown it, and whether the terms you agreed to last
								year still mean what they meant when you agreed to them.
							</p>
							<p>
								I have never found anything as worth doing as helping other people feel encouraged
								and equipped to share what they make, and Anthers is that same impulse built out
								into something other people can use. I want a creator's relationship with their
								audience to be the most honest one either of them has, and I want what a creator
								earns to be theirs.
							</p>
							<p>
								<strong>It matters how we do things, even more than what we aim to do.</strong> That
								is the principle I have built every collaboration of mine on, and it is why Anthers
								is shaped the way it is: I would rather hand you a structure you can check than a
								promise you have to take my word for.
							</p>
						</div>
					</Card>
				</Reveal>
			</Section>

			{/* ───────────── Closing ───────────── */}
			<section>
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
