// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The FAQ — restyled into the Meadow design 2026-08-14, because it was still the
// pre-design-pass page (a bare container, DaisyUI's default collapse) sitting one
// footer link away from /for-users and /for-creators. It now composes the same shared
// primitives they do: <MeadowDecor>, the hero/Section/Eyebrow rhythm, Fraunces over
// Nunito, and the closing band.
//
// Content note: the answers are the load-bearing part. See the money figures rule
// below, and 63.01 for the vocabulary — the gates answer in particular describes ONE
// gate primitive pointed at a creator, because Anthers Gates were retired 2026-08-12.

import { FREE_STORAGE_GIB } from "@anthers/shared/constants";
import { DIRECTED_SUPPORT_WORST_CASE, SALE_TABLE } from "@anthers/shared/figures";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { MeadowDecor } from "@anthers/web-shared/decor/MeadowDecor";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Eyebrow, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link } from "@anthers/web-shared/router";
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";

const serif = { fontFamily: FONTS.fraunces };

/**
 * Money figures come from the generated table, never typed here — see
 * `scripts/econ-figures.ts`. A hand-typed $9.40 sat in this file for months against a
 * model that said something else.
 */
const SEED = DIRECTED_SUPPORT_WORST_CASE;
const GAME_10 = SALE_TABLE.find((r) => r.label === "game-10-1gib")!;

interface FAQItem {
	question: string;
	answer: string | ReactNode;
	category: string;
}

const FAQ_ITEMS: FAQItem[] = [
	{
		category: "Feed & Discovery",
		question: "How does the feed work? Is there an algorithm like other social/media sites?",
		answer: (
			<div className="space-y-2">
				<p>
					The Anthers feed is not driven by a traditional engagement-maximizing algorithm. By
					default, you see content in three layers:
				</p>
				<ul className="list-disc list-inside space-y-1 text-base-content/70">
					<li>
						<strong>Primary:</strong> Content from creators you follow and support
					</li>
					<li>
						<strong>Network:</strong> Things your follows have liked, shared, or purchased
					</li>
					<li>
						<strong>Ambient:</strong> Content matching your stated interests (tags) -- never paid
						promotion
					</li>
				</ul>
				<p>
					Everything in your feed is attributed so you know exactly why it's there. You can also
					subscribe to Custom Feeds and Custom Algorithms created by other users, giving you full
					control over what you see. Anthers never uses paid promotion or engagement optimization to
					influence your feed.
				</p>
			</div>
		),
	},
	{
		category: "Feed & Discovery",
		question: "What are Custom Feeds?",
		answer:
			"Custom Feeds are alternative feed views created by other users or creators. They can be algorithmic (dynamically adapting to your data) or curated (showing the same content to everyone who subscribes). You can subscribe to any published feed and switch between feeds from the selector on your Home page.",
	},
	{
		category: "Feed & Discovery",
		question: "Does Anthers sell promoted or sponsored content placement?",
		answer:
			"No. Anthers does not sell promoted content placement in feeds, search results, or anywhere else. What you see is always based on your relationships, your interests, and your choices -- never on who paid the most.",
	},
	{
		category: "Subscriptions & Payments",
		question: "How does paying for Anthers work?",
		answer: (
			<div className="space-y-2">
				<p>
					Support on Anthers is all in the form of <strong>Seeds</strong> — a flat{" "}
					<strong>$3/month</strong> each — and every dollar goes to creators, to the at-cost card
					processing, or to free access and Anthers' charitable programs. A Seed goes one of two
					ways:
				</p>
				<ul className="list-disc list-inside space-y-1 text-base-content/70">
					<li>
						<strong>Give Seeds to a creator</strong> — $3/month each, sent straight to creators you
						pick, Patreon-style. <strong>Anthers takes no cut at all.</strong> The only deduction is
						the at-cost card processing, paid to the processor — on a single $3 a month that is $
						{SEED.cardFee}, so the creator receives ${SEED.net}. It is one fee on your whole monthly
						charge, so the more you give in a month, the more of each dollar reaches its creator.
					</li>
					<li>
						<strong>Give Seeds to Anthers</strong> — $3/month each. The first one lifts your monthly
						Public Access limit, and every one of them funds the Time Pool (shared out by the time
						you spend with each creator's work) and leaves a remainder that funds free access and
						the charitable programs. So the more you give, the more your time is worth to the
						creators you spend it with. Your count is your Badge (Root → Blossom, and a "+" beyond)
						— a point-in-time choice, not a rolling total of past spend, and it gates nothing.
					</li>
				</ul>
				<p>
					Downloading costs you nothing on top, ever — no allowance, no wallet, no per-GiB charge,
					however many devices you use. Streaming is free too; the one limit is on{" "}
					<strong>Public Access</strong>, the work creators leave open to everyone, which a free
					account can watch for {FREE_PUBLIC_ACCESS_HOURS} hours a month. Anything you bought or
					cleared a gate for never counts against it. Card processing comes out of your Seeds at
					cost and leaves the system entirely; sales tax is the only thing added on top of the
					price.
				</p>
			</div>
		),
	},
	{
		category: "Subscriptions & Payments",
		question: "Is there a data cap? What does streaming cost me?",
		answer: `There is no data cap and delivery costs you nothing, on every account, free and paying alike, across as many devices as you like — no allowance to run out of, no wallet to top up, no per-GiB line on your bill, and a game you bought re-downloads forever at no cost. Anthers used to meter this, because delivery genuinely was expensive; our object storage now charges nothing for it at any volume, so we charge nothing for it either. Anthers charging less because it costs less is the model working as intended. There is one limit, and it is measured in time rather than data: a free account can stream ${FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a month — the work creators leave open to everyone — free forever, and a single Seed given to Anthers lifts it for as long as you hold it. Time with work you bought, work you cleared a creator's gate for, or work you made yourself never counts against those hours.`,
	},
	{
		category: "Subscriptions & Payments",
		question: "What pays for free access and Anthers' charitable programs?",
		answer:
			"The remainder of each Seed given to Anthers — what's left after the Time Pool and the at-cost card processing — plus the half-again on creator storage above the free allowance. It is never a cut of anyone's earnings, and direct purchases contribute nothing: Anthers takes no share of a creator's sale. The budget is read obligations-first: lean operating overhead and everyone's free access come off the top, and whatever remains funds the charitable programs — with Admin held to no more than 30% of revenue, so at least 70% goes to programs and services (the CharityNavigator bar). Counting free access as the charitable program it is, the great majority of it is charitable.",
	},
	{
		category: "Subscriptions & Payments",
		question: "How do direct purchases work?",
		answer:
			"Direct purchases (a game, an album, a one-time download) are Anthers at a 0% cut — we keep nothing at all. The creator sets the listed price, and that price plus your state's sales tax is exactly what you pay; there are no other additions. One real cost comes out of that price: card processing, paid to the payment processor. Downloading what you bought is free, every time, on every device, for as long as you have the account — there is no first-download allowance and nothing to run out of. The receipt shows every cent, and none of it is ours.",
	},
	{
		category: "Subscriptions & Payments",
		question: "How do gated content and gates work?",
		answer: (
			<div className="space-y-2">
				<p>
					There is one kind of gate on Anthers and it points at a creator: a <strong>Badge</strong>{" "}
					is a monthly amount given to that creator this month. Meet it and the Work opens. Creators
					set the thresholds themselves and name their own Badges, and a gate doesn't have to sit
					exactly on one — a creator can gate at $9 whether or not they've named a Badge there.
				</p>
				<p>
					A creator can offer more than one way in, and the ways combine with OR — clear any one of
					them and you're in, never all of them. So a Work can be free to anyone giving that creator
					$9 a month <em>or</em> buyable outright by anyone else, and you take whichever route suits
					you.
				</p>
				<p>
					Seeds you give <strong>Anthers</strong> gate nothing at all, deliberately. Everything
					streaming that a creator hasn't gated is <strong>Public Access</strong> — free to
					everyone, nothing to clear and nothing to buy. A laddered commons would just mean better
					free work for the people who paid more, which is the one thing the free layer exists to
					avoid.
				</p>
			</div>
		),
	},
	{
		category: "Creators",
		question: "How much do creators keep?",
		answer: `Anthers takes no cut of creator earnings — 0% platform fee, on everything. Creators are funded by the Time Pool (from the Seeds viewers give Anthers, distributed by the time people spend with them, and paid out in full) plus the Seeds directed to them. The only deduction anywhere is a cost paid to a third party: card processing. A $3 directed Seed reaches its creator as $${SEED.net} at worst, and a $${GAME_10.price} game sale returns $${GAME_10.creatorReceives} whatever the download size. Every creator gets ${FREE_STORAGE_GIB} GiB of free storage; beyond that, the only thing a creator pays is their own storage — our object store's rate plus half again, which goes to free access and the charitable programs — and that is entirely their choice.`,
	},
	{
		category: "Creators",
		question: "What kinds of content can I publish?",
		answer:
			"Anthers supports games (browser-playable and downloadable), video, audio (music, podcasts), and written content (articles, stories, tutorials). All media types are first-class citizens with dedicated player/reader experiences.",
	},
	{
		category: "Platform & Identity",
		question: "What is the Bluesky integration?",
		answer:
			"You can link your Bluesky account to your Anthers account, so the two identities are connected. That's what exists today. Federation -- your content living across a network of independent servers -- is a direction we're committed to and haven't built yet. We'd rather say that plainly than describe it as though it already works.",
	},
	{
		category: "Platform & Identity",
		question: "Is Anthers open source?",
		answer:
			"Yes -- the whole platform is licensed under the AGPL-3.0. You can also download everything you've made from Settings, in one click. Running your own node, and federating between them, is a direction we're committed to rather than something that ships today. The goal is that no single entity -- including Anthers itself -- can become a gatekeeper.",
	},
];

const CATEGORIES = [...new Set(FAQ_ITEMS.map((item) => item.category))];

/**
 * One question.
 *
 * A native `<details>` rather than DaisyUI's checkbox-and-sibling-selector collapse,
 * which is what this was. The checkbox version needed `useState` per row to hold a
 * value nothing else read, and it presented a *form control* to a screen reader for
 * something that is not a form — `<details>` announces as a disclosure, opens on Enter
 * and Space for free, and is findable by the browser's own in-page search when closed.
 * The arrow is drawn here because `list-style` on a summary is the one part of this
 * element browsers still disagree about.
 */
function FAQAccordion({ item }: { item: FAQItem }) {
	return (
		<details className="group rounded-2xl border border-base-content/10 bg-base-100/80 shadow-sm transition-colors open:bg-base-100 hover:border-primary/30">
			<summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-5 py-4 text-left text-sm font-medium marker:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
				{item.question}
				<ChevronDownIcon className="h-4 w-4 shrink-0 text-primary/60 transition-transform duration-200 group-open:rotate-180" />
			</summary>
			<div className="space-y-2 px-5 pb-5 text-sm leading-relaxed text-base-content/70">
				{typeof item.answer === "string" ? <p>{item.answer}</p> : item.answer}
			</div>
		</details>
	);
}

export default function FAQPage() {
	return (
		<MeadowDecor floor={false} style={{ fontFamily: FONTS.nunito }}>
			{/* Hero — the same three-beat fade the other marketing pages open with. */}
			<header className="bg-base-200/70">
				<div className="mx-auto max-w-5xl px-6 pt-24 pb-16 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-5 h-11 w-11 text-primary/60" />
						<p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
							Questions &amp; Answers
						</p>
						<h1
							style={serif}
							className="text-balance text-5xl font-light leading-[1.05] tracking-tight sm:text-6xl"
						>
							How this place
							<br />
							<em className="font-medium text-primary not-italic">actually works</em>
						</h1>
					</Reveal>
					<Reveal delay={150}>
						<p className="mx-auto mt-8 max-w-2xl text-lg leading-relaxed text-base-content/75">
							Where the money goes, what supporting does, what we haven't built yet. If something
							here reads like a dodge, tell us — we'd rather fix the answer than the wording.
						</p>
						<BrandGlyph
							name="divider-botanical"
							className="-mb-16 -mt-4 h-24 w-52 text-primary/45"
						/>
					</Reveal>
				</div>
			</header>

			{CATEGORIES.map((category, c) => (
				<Section key={category} tint={c % 2 === 1}>
					<Reveal>
						<Eyebrow>{category}</Eyebrow>
					</Reveal>
					<div className="mx-auto mt-8 flex max-w-3xl flex-col gap-3 text-left">
						{FAQ_ITEMS.filter((item) => item.category === category).map((item, i) => (
							<Reveal key={item.question} delay={i * 70}>
								<FAQAccordion item={item} />
							</Reveal>
						))}
					</div>
				</Section>
			))}

			{/* Closing — the same band shape /for-users and /for-creators end on. */}
			<section className="bg-base-200/70">
				<div className="mx-auto max-w-6xl px-6 py-24 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-6 h-12 w-12 text-primary/70" />
						<h2
							style={serif}
							className="text-balance text-3xl font-light leading-tight sm:text-4xl"
						>
							Still have questions?
						</h2>
						<p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-base-content/70">
							The long version of nearly all of this is written down and public.
						</p>
						<div className="mt-8 flex flex-wrap justify-center gap-3">
							<Link to="/about" className="btn btn-primary rounded-lg px-7">
								About Anthers
							</Link>
							<Link
								to="/resources"
								className="btn btn-outline rounded-lg border-base-content/20 px-7"
							>
								Resources
							</Link>
						</div>
					</Reveal>
				</div>
			</section>
		</MeadowDecor>
	);
}
