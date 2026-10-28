// SPDX-License-Identifier: Apache-2.0
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
// user came here to establish.
//
// ── What this page owns, and what it must not grow back ──────────────────────
//
// Rebuilt 2026-08-21 from ~15,000px and six sections, because the previous
// version argued a case where an About page describes an organization. Every
// reference on the brief — ProPublica, Blender, Alveus, the Mozilla Foundation —
// is a mission line and a handful of paragraphs, and none of them annotates its
// own claims. **For a young organization the honest move is to say less, not to
// hedge more**: the old page carried four program pillars with a paragraph
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
//   3. Who we are ........ Parker, first person: a landscape portrait beside the
//                          opening prose, the rest of the bio below it in one
//                          column, and the Rilke line closing the section.
//
// The program pillars, the founding-board invitation and the "what comes next"
// list are all on the wiki's roadmap already. **This page says what is true; the
// roadmap says when.** That division is why nothing here promises a date.
//
// ── 🚨 Federal status: the rule CHANGED on 2026-08-21 ────────────────────────
//
// The wiki's *How Anthers Talks About Itself* § Claims used to read *"say nothing about federal status at
// all"*, and this page said nothing. **Parker's call is that the page states the
// intention** — the two-list structure below is what makes that safe, because it
// partitions present from future explicitly rather than leaving a user to guess
// which column a sentence belongs in. The wiki's *How Anthers Talks About Itself* carries the narrowed rule now.
//
// What did NOT change, and what `about-claims.test.ts` still holds:
//
//   • Anthers may not be CALLED a 501(c)(3), or described as tax-exempt, or as
//     having a pending or filed application. The Form 1023 has not been filed.
//   • No money given to Anthers may be called deductible **today**. Where the
//     "soon" column says donations become deductible, the sentence beside it
//     says they are not yet — same co-presence rule as "free forever" and the
//     monthly limit, and the guard asserts the pairing.
//   • ⚠️ **No date.** Parker's note proposed "later this year"; the vault's Colorado Nonprofit
//     Compliance Reference puts the
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
// thing every organization owes a user: here is who we are.
//
// 🚨 **Do not edit the first-person passage of Parker's bio; that will always be hand-written.**
//
// ⚠️ **The bio is a single 48rem column, and the portrait is framed by the row
// it sits in.** Five of twelve grid columns hold the photo beside the first two
// paragraphs; the rest of the prose runs the full measure below, so the section
// reads as one rectangle rather than a wide block sitting over a narrow one. The
// frame takes its height from that row (`md:h-full`), which is what keeps the
// image and the text beside it the same height at every width; a fixed aspect
// ratio puts a short landscape photo next to a tall block of prose and leaves the
// gap underneath. The Rilke line closes the section rather than dividing it: it
// is the last thing in the passage, and it reads as the bio's landing, so moving
// it up to make a hard split would reorder Parker's own ending.
//
// The hero is the standing introduction, verbatim (the wiki's *How Anthers Talks About
// Itself* § The Standing Introduction), split across the
// headline and the lede. Quote it rather than writing a fresh introduction, so
// the platform sounds like one thing wherever a user meets it. ⚠️ It replaced
// a hero reading *"Anthers is a federated, open content network…"*, which
// asserted federation that has not shipped. That phrasing must not come back: it is
// the claim the wiki's vocabulary rules forbid, and a narrower check on its other
// phrasings sails straight past this one.
//
// ⚠️ A big italic Fraunces display line was tried here as a mission pull-quote
// and rejected on sight — at that size the face reads as a wedding invitation.
// Fraunces stays on the section headings, upright, where the rest of the site
// uses it.

import { FREE_STORAGE_GIB } from "@anthers/shared/constants";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Card, Eyebrow, H2, Lede, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { usePageTitle } from "@anthers/web-shared/page-title";
import { Link } from "@anthers/web-shared/router";
import { KeyIcon, LockOpenIcon } from "@heroicons/react/24/outline";

const serif = { fontFamily: FONTS.fraunces };

/* ------------------------------------------------------------------ */
/*  Data                                                               */
/* ------------------------------------------------------------------ */

// What the Colorado Act and Anthers' own filed Articles already bind, quoted from
// the additional-information attachment rather than from anyone's summary of it.
// Each of these survives the test the wiki's *How Anthers Talks About Itself* § Claims sets — it still holds
// with one director and no federal recognition — because each is in the filing.
const BINDING_NOW = [
	"There are no owners and no shares, and the Articles give Anthers no voting members. Nobody holds a piece of it, so there is nobody to pay a profit to and nothing for anyone to buy.",
	"Nothing Anthers earns may be paid out to anyone inside it. The Articles bar its net earnings from benefiting a director, an officer, or any private person, and require it to serve public rather than private interests. What it may pay is ordinary compensation for work actually done.",
	"If Anthers ever dissolves, its assets can only be transferred to another charitable organization or to a government for a public purpose. They don't go to a founder or anyone working here, to shareholders (which we can't have), to any for-profit entity, nothing like that.",
	"Anthers' purposes are fixed in the Articles, and they are specific: making creative and educational work freely available to the public, releasing the platform's technology under open-source licenses, and enabling creators to host and deliver their own work independently of Anthers.",
];

// What federal recognition would add, chosen for the three people who actually
// need to know — someone deciding whether to publish here, someone deciding
// whether to support a creator here, and someone deciding whether to fund us.
// ⚠️ The first line carries its own present-tense correction; see the header.
const BINDING_SOON = [
	"Donations to Anthers become tax-deductible for the person making them. Until the determination letter arrives, they aren't, and that's why we don't yet solicit donations.",
	"Anthers becomes eligible for special grants and discounts that foundations and vendors reserve for recognized charities, which is money and service going into the platform rather than out of it.",
	"Anthers' finances become a matter of public record, published every year, so anyone can check what came in and where it went. We do our best to be transparent already, but that will increase significantly once the determination letter arrives.",
	"The prohibition on paying insiders, which the filed Articles already bind us to, is entrenched further once federal recognition arrives.",
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
	usePageTitle("About");
	return (
		<div>
			{/* ───────────── Hero ───────────── */}
			<header className="bg-base-200/70">
				<div className="mx-auto max-w-6xl px-6 pt-24 pb-20 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-5 h-11 w-11 text-primary/60" />
						<p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
							About Anthers
						</p>
						<h1
							style={serif}
							className="text-balance text-5xl font-light leading-[1.05] tracking-tight sm:text-7xl"
						>
							A nonprofit creative garden{" "}
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
						Anthers, Inc. is a Colorado nonprofit corporation, Secretary of State ID 20261969882. We
						aren't a registered 501(c)(3) exempt organization yet; we intend to file for that
						recognition. In case you're not familiar with the terms, there are some differences
						between the two:
					</Lede>
				</Reveal>

				<div className="mx-auto mt-12 grid max-w-5xl gap-6 md:grid-cols-2">
					<Reveal className="h-full">
						<FactCard
							title="What's Already True"
							note="Since incorporation as a Colorado nonprofit"
							items={BINDING_NOW}
						/>
					</Reveal>
					<Reveal delay={110} className="h-full">
						<FactCard
							title="What That Means Soon"
							note="Once the IRS determination letter arrives"
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
						from the people on it, and then a little more after that. Anthers can't have
						shareholders. Think of it as an anti-enshittification protection.
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
									Anthers is a place to publish creative work of every kind: videos, games, music,
									essays, comics, courses, software, merch, services, anything. We want you to have
									a safe and free place to share your work, and to be paid for it by the people who
									enjoy it, whether through paid subscriptions, direct purchases, or revenue from
									Public Access streaming.
								</p>
								<p>
									We're committed not only to making these things available and easy to use, but
									also to making them as free and accessible as possible. Free users can enjoy{" "}
									{FREE_PUBLIC_ACCESS_HOURS} hours of Public Access streaming a month, free forever.
									Creators can host hours of video (or the equivalent of games, music, writing,
									anything) within every account's {FREE_STORAGE_GIB} GiB of combined storage, free,
									forever. And when users and creators need more than we offer for free, we offer
									upgrades, and what they bring in above cost goes back into free access for other
									users and creators, and our other charitable programs.
								</p>
								<p>
									That's the beauty of being a nonprofit in this space: Whatever money we bring in
									above what's needed to keep the lights on, whether that's through subscriptions to
									Anthers itself, or purchases of Anthers merch, or donations to our nonprofit (not
									possible yet), it all goes straight to supporting creators, providing free access,
									and expanding our other charitable services and programs.
								</p>
								<p>
									Turns out, it's possible to build a place that creators and their audiences can
									love, to support small and marginalized users and creators, and to do all of it
									without manipulating people, without squeezing a user base for pennies to give to
									billionaires and corporations, and without... well, without being assholes. It's
									really not that hard. You just have to decide that you're okay not making a bunch
									of money off people. We've been told it's not the best mindset for starting a
									business. So we started a nonprofit instead.
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
									We want you to experience everything the Anthers community builds without
									advertisements, without manipulative algorithms, and without a for-profit platform
									aiming to extract the max out of you and your communities. We don't take a cut off
									the top of anything users pay directly to you; that's your money. The only
									deduction between you and your users is card processing, charged at cost to the
									processor and already inside the price; sales tax is added on top.
								</p>
								<p>
									And we're also committed to building a free, open, and durable internet. Our
									entire platform is open source, built on the AT Protocol for identity and the
									public catalog: the same protocol and standards behind Bluesky. The records of
									what you publish are readable by anyone's software, and you can download
									everything you've made from your settings at any time. We want to make Anthers the
									best place to do everything you can do on Anthers. But at the end of the day, your
									data, your identity, and your creativity belong to you. We aim to help build the
									best home for it, but it belongs to you and always will.
								</p>
								<p>
									The creative and educational internet is a beautiful thing; it has been for a long
									time. We grew up with it, the good and the bad. But we all see the ways in which
									the last generation or two have really been wrung out by extractive and
									manipulative platforms, and it doesn't have to be like that. It really is possible
									to create connection between creators and their audiences, let them make the
									magic, and just get out of the way.
								</p>
							</div>
						</Card>
					</Reveal>
				</div>

				<Reveal delay={220}>
					<p className="mt-10 text-base-content/70">
						<Link to="/signup" className="link link-primary">
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
						Anthers is a growing organization, and we have lots of amazing friends and family and
						other folks helping us get off the ground. But for now, the Anthers team is just Parker
						(that's me, writing this).
					</Lede>
				</Reveal>

				<Reveal delay={120} className="mx-auto mt-12 block max-w-3xl text-left">
					<div className="grid gap-8 md:grid-cols-12 md:items-stretch md:gap-10">
						<figure className="md:col-span-5">
							{/* 📷 PORTRAIT SLOT — drop the file at `apps/web/public/images/parker.jpg`
							    (served from the site root as `/images/parker.jpg`, since build.ts copies
							    public/ into dist/) and replace the placeholder div below with:

							      <img
							          src="/images/parker.jpg"
							          alt="Parker H. Davis"
							          className="h-full w-full object-cover"
							      />

							    A landscape crop, roughly 3:2, ~1600px on the long edge, framed so
							    his face survives a little off-center cropping. On desktop the frame
							    is as tall as the two paragraphs beside it, which trims roughly a
							    fifth off the sides of a 3:2 source; on a phone it runs full-width
							    above them at 3:2 and nothing is cropped. The placeholder keeps the
							    layout honest until the file lands — a missing <img> would 404 in the
							    screenshot harness and read as a bug. */}
							<div className="flex aspect-3/2 items-center justify-center overflow-hidden rounded-2xl bg-primary/10 md:aspect-auto md:h-full">
								<span style={serif} className="text-6xl font-light text-primary/70">
									P
								</span>
							</div>
						</figure>
						<div className="space-y-5 leading-relaxed text-base-content/70 md:col-span-7">
							<div>
								<h3 style={serif} className="text-xl font-medium text-base-content">
									Parker H. Davis
								</h3>
								<p className="text-sm text-base-content/50">Founder</p>
							</div>
							<p>
								I'm Parker, and I'm a multimedia director, developer, writer, and composer from
								Colorado.
							</p>
							<p>
								My earliest creative work was in music production, which turned into freelance
								filmmaking, which turned into a years-long tenure in game development where I led
								teams, shipped titles, and wore more hats than I can count.
							</p>
						</div>
					</div>

					<div className="mt-10 space-y-5 leading-relaxed text-base-content/70 md:mt-12">
						<p>
							Every medium I've worked in and every creative person I've worked alongside has
							deepened my sense of what it takes to do this work well, and of how much of it turns
							on things that have nothing to do with the work itself: whether you can afford to keep
							going, whether the people who would love what you make ever get to see it, and whether
							the terms you agreed to last year still mean what they meant when you agreed to them.
						</p>
						<p>
							I've worked in a lot of media across a lot of companies, and while I've made some
							things I'm truly proud of, nothing prepared me for the pride of leading a game dev
							team. I saw such a spectrum of creative talent, personal perspective, and professional
							ingenuity; I knew right away that nothing I could ever build alone would be anywhere
							near as worthwhile as my ability to help other people feel encouraged and equipped to
							create and share what means the most to them.
						</p>
						<p>
							Anthers, at the most fundamental level, is that same impulse built out into a real,
							material tool for other people. I want a creator's relationship with their audience to
							be the kind of beautiful, honest thing that it's so obvious it can be when you take
							all the manipulative, extractive corporate stuff out of the way. I want what a fan
							enjoys and experiences to truly be theirs; I want what a creator shares and earns to
							truly be theirs. No artistic work I could ever make alone could be more impactful than
							that.
						</p>
						<p>
							If there's one guiding principle that's underpinned everything I've done in my adult
							life, it's that{" "}
							<strong>it matters how we do things, often even more than what we aim to do.</strong>{" "}
							That is the philosophy I have built every collaboration of mine on, it is why I can
							never be convinced that you have to be an asshole to be impactful, and (selfishly) it
							is why Anthers is what it is: a place where I can be helpful.
						</p>
					</div>

					<figure className="mt-12 border-t border-base-content/10 pt-8 text-center">
						<blockquote className="text-balance text-xl italic leading-relaxed text-base-content/60">
							"Nearly everything that matters is a challenge, and everything matters."
						</blockquote>
						<figcaption className="mt-3 text-sm text-base-content/50">
							- Rainer Maria Rilke, Letters to a Young Poet
						</figcaption>
					</figure>
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
							Join us on Anthers
						</h2>
						<p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-base-content/70">
							Whether you want to make things, to experience what others make, to do a bit of both,
							or you're not sure yet, we hope Anthers becomes the best, friendliest place for you to
							be.
						</p>
						<div className="mt-8 flex flex-wrap justify-center gap-3">
							<Link to="/signup" className="btn btn-primary rounded-full px-7">
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
