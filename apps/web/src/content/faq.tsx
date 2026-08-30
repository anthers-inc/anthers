// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The FAQ pool — every question the site answers, in one place, plus which page each
// one is surfaced on.
//
// 🚨 **One pool, several surfaces, and that is the whole reason this file exists.** The
// answers lived inside `FAQPage.tsx` until 2026-08-28, which was fine while /faq was the
// only page that had any. Adding a short FAQ to the bottom of the homepage, /for-creators
// and /subscribe would otherwise have meant three more copies of *"how much do creators
// keep?"* — and a copy of an answer is a second place for it to go stale, in a repository
// that has already paid for that lesson with a hand-typed $9.40 and with five marketing
// pages describing a bandwidth allowance two days after it was deleted.
//
// So a page does not carry FAQ copy. It names a **surface**, and `faqFor()` hands back
// the items assigned to it. /faq is the union: every item here appears there, which is
// what makes "the rest of the questions are on the FAQ" a true sentence at the bottom of
// each page rather than a hopeful one.
//
// ⚠️ **The order in `PAGE_FAQS` is editorial and is not derived from anything.** An FAQ's
// first question is the most important thing about it — it is the objection you believe is
// standing between the reader and the button below it — so the sequence is written per
// page rather than falling out of category order. Ordering by category instead would open
// the signup page's FAQ with a question about the feed.
//
// **Copy rules apply here exactly as they do on a page** (63.01), because this *is* page
// copy — it merely lives one import away from the page. The three that bite most often:
// money figures are derived from the generated tables and never typed; "free forever" and
// the monthly Public Access limit are co-present in the same breath; and supporting
// Anthers never "unlocks" or "opens" Public Access, because Public Access was already free
// to everyone and what changes is the **cap**. `faq.test.ts` holds the ones a regex can
// check.

import {
	ATTENTION_RAW_RETENTION_DAYS,
	FREE_STORAGE_GIB,
	FREE_TIME_POOL,
	PUBLIC_ACCESS_PRICE,
} from "@anthers/shared/constants";
import { DIRECTED_SUPPORT_WORST_CASE, SALE_TABLE } from "@anthers/shared/figures";
import { FREE_PUBLIC_ACCESS_HOURS } from "@anthers/shared/public-access";
import { Link } from "@anthers/web-shared/router";
import type { ReactNode } from "react";

/**
 * Money figures come from the generated table, never typed here — see
 * `scripts/econ-figures.ts`. A hand-typed $9.40 sat in the FAQ for months against a model
 * that said something else.
 */
const SUPPORT = DIRECTED_SUPPORT_WORST_CASE;
const GAME_10 = SALE_TABLE.find((r) => r.label === "game-10-1gib")!;

export interface FAQItem {
	question: string;
	answer: string | ReactNode;
	category: string;
}

/**
 * Every question, keyed by a stable id.
 *
 * **Insertion order is what /faq renders in**, grouped into the categories in the order
 * they first appear here — so this list is sequenced by category deliberately, running
 * from what a newcomer asks to what somebody already committed asks.
 */
export const FAQ_ITEMS = {
	// ── Getting started ──────────────────────────────────────────────────────
	"card-required": {
		category: "Getting Started",
		question: "Do I need a card to sign up?",
		answer: `No. An email address makes an account — or your Bluesky handle, if you'd rather — and what is free stays free forever: downloads of anything free or anything you buy, with no allowance to run out of and no limit on how many devices you use, and ${FREE_PUBLIC_ACCESS_HOURS} hours of Public Access streaming a month. A card is asked for at the moment you choose something that needs one: backing a creator, buying a Work, or supporting Anthers. Signing up is not one of those moments, and there is no trial to forget to cancel.`,
	},
	"whats-free": {
		category: "Getting Started",
		question: "What do I actually get for free?",
		answer: (
			<div className="space-y-2">
				<p>
					An account, following anyone you like, a Library to keep things in, and downloading — of
					anything a creator has released free, and of anything you buy — as many times as you like
					on as many devices as you like, at no cost and with nothing to top up.
				</p>
				<p>
					Streaming is where the one limit sits:{" "}
					<strong>{FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a month, free forever</strong>.
					Public Access is everything a creator has left ungated, and it is free to everyone rather
					than something an account earns its way into — the limit is on how much of it a free
					account streams in a month, and ${PUBLIC_ACCESS_PRICE} a month to Anthers removes that
					limit.
				</p>
				<p>
					A free account still pays creators, which is the part people don't expect. Anthers funds a
					small Time Pool on your behalf — ${FREE_TIME_POOL.toFixed(2)} a month, shared out by the
					time you spend with each creator's work — so watching something free is not the same as it
					earning nothing.
				</p>
			</div>
		),
	},
	"cancel-or-stop": {
		category: "Getting Started",
		question: "Can I change or stop what I give?",
		answer:
			"Whenever you like, from your settings. What you give is a monthly amount rather than a contract: change it, point it at someone else, or stop it entirely, and nothing is held against you for it. Your account, your Library and everything you have bought stay yours either way. The one thing that changes is that work behind a creator's gate closes again when you stop meeting it, because a gate reads what you are giving now rather than what you have given in the past. Deleting the account outright is also yours to do, from the same place: it takes effect after seven days, and signing back in during that week cancels it.",
	},

	// ── Feed & discovery ─────────────────────────────────────────────────────
	"feed-algorithm": {
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
	"custom-feeds": {
		category: "Feed & Discovery",
		question: "What are Custom Feeds?",
		answer:
			"Custom Feeds are alternative feed views created by other users or creators. They can be algorithmic (dynamically adapting to your data) or curated (showing the same content to everyone who subscribes). You can subscribe to any published feed and switch between feeds from the selector on your Home page.",
	},
	"promoted-placement": {
		category: "Feed & Discovery",
		question: "Does Anthers sell promoted or sponsored content placement?",
		answer:
			"No. Anthers does not sell promoted content placement in feeds, search results, or anywhere else. What you see is always based on your relationships, your interests, and your choices -- never on who paid the most.",
	},

	// ── Subscriptions & payments ─────────────────────────────────────────────
	"paying-works": {
		category: "Subscriptions & Payments",
		question: "How does paying for Anthers work?",
		answer: (
			<div className="space-y-2">
				<p>
					Support on Anthers is a <strong>monthly amount you choose</strong>, and every dollar of it
					goes to creators, to the at-cost card processing, or to free access and Anthers'
					charitable programs. It goes one of two ways:
				</p>
				<ul className="list-disc list-inside space-y-1 text-base-content/70">
					<li>
						<strong>Give a creator a monthly amount</strong> — any amount, sent straight to creators
						you pick, Patreon-style. <strong>Anthers takes no cut at all.</strong> The only
						deduction is the at-cost card processing, paid to the processor — on ${SUPPORT.gross} a
						month alone that is ${SUPPORT.cardFee}, so the creator receives ${SUPPORT.net}. It is
						one fee on your whole monthly charge, so the more you give in a month, the more of each
						dollar reaches its creator.
					</li>
					<li>
						<strong>Give Anthers a monthly amount</strong> — ${SUPPORT.gross} a month lifts your
						monthly Public Access limit, and every dollar funds the Time Pool (shared out by the
						time you spend with each creator's work) and leaves a remainder that funds free access
						and the charitable programs. So the more you give, the more your time is worth to the
						creators you spend it with. Your level is your Badge (Root → Blossom, and a "+" beyond)
						— a point-in-time choice, not a rolling total of past spend, and it gates nothing.
					</li>
				</ul>
				<p>
					Downloading costs you nothing on top, ever — no allowance, no wallet, however many devices
					you use. Streaming is free too; the one limit is on <strong>Public Access</strong>, the
					work creators leave open to everyone, which a free account can watch for{" "}
					{FREE_PUBLIC_ACCESS_HOURS} hours a month. Anything you bought or cleared a gate for never
					counts against it. Card processing comes out of what you give, at cost and leaves the
					system entirely; sales tax is the only thing added on top of the price.
				</p>
			</div>
		),
	},
	"data-cap": {
		category: "Subscriptions & Payments",
		question: "Is there a data cap? What does streaming cost me?",
		answer: `There is no data cap and delivery costs you nothing, on every account, free and paying alike, across as many devices as you like — no allowance to run out of, no wallet to top up, and a game you bought re-downloads forever at no cost. Anthers used to meter this, because delivery genuinely was expensive; our object storage now charges nothing for it at any volume, so we charge nothing for it either. Anthers charging less because it costs less is the model working as intended. There is one limit, and it is measured in time rather than data: a free account can stream ${FREE_PUBLIC_ACCESS_HOURS} hours of Public Access a month — the work creators leave open to everyone — free forever, and supporting Anthers lifts it for as long as you keep it up. Time with work you bought, work you cleared a creator's gate for, or work you made yourself never counts against those hours.`,
	},
	"anthers-badge-unlocks": {
		category: "Subscriptions & Payments",
		question: "Does supporting Anthers unlock anything I couldn't see otherwise?",
		answer: `Nothing at all, and that is deliberate rather than an oversight. Public Access is already free to everyone — there is no ladder inside it and nothing there to be let into. What ${money(PUBLIC_ACCESS_PRICE)} a month removes is the monthly limit on your own streaming, and every dollar above that grows the Time Pool for the creators you spend time with, so the same hour of your time pays them more. Your Anthers Badge is standing rather than a key: no work on the platform sits behind it. A commons with rungs in it would only mean better free work for the people who paid more, which is the one thing a free layer exists to avoid.`,
	},
	"what-pays-for-free": {
		category: "Subscriptions & Payments",
		question: "What pays for free access and Anthers' charitable programs?",
		answer:
			"The remainder of what is given to Anthers — what's left after the Time Pool and the at-cost card processing — plus the half-again on creator storage above the free allowance. It is never a cut of anyone's earnings, and direct purchases contribute nothing: Anthers takes no share of a creator's sale. The budget is read obligations-first: lean operating overhead and everyone's free access come off the top, and whatever remains funds the charitable programs — with Admin held to no more than 30% of revenue, so at least 70% goes to programs and services (the CharityNavigator bar). Counting free access as the charitable program it is, the great majority of it is charitable.",
	},
	"direct-purchases": {
		category: "Subscriptions & Payments",
		question: "How do direct purchases work?",
		answer:
			"Direct purchases (a game, an album, a one-time download) are Anthers at a 0% cut — we keep nothing at all. The creator sets the listed price, and that price plus your state's sales tax is exactly what you pay; there are no other additions. One real cost comes out of that price: card processing, paid to the payment processor. Downloading what you bought is free, every time, on every device, for as long as you have the account — there is nothing to run out of. The receipt shows every cent, and none of it is ours.",
	},
	gates: {
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
					What you give <strong>Anthers</strong> gates nothing at all, deliberately. Everything
					streaming that a creator hasn't gated is <strong>Public Access</strong> — free to
					everyone, nothing to clear and nothing to buy. A laddered commons would just mean better
					free work for the people who paid more, which is the one thing the free layer exists to
					avoid.
				</p>
			</div>
		),
	},

	// ── Creators ─────────────────────────────────────────────────────────────
	"creator-take-home": {
		category: "Creators",
		question: "How much do creators keep?",
		answer: `Anthers takes no cut of creator earnings — 0% platform fee, on everything. Creators are funded by the Time Pool (from what viewers give Anthers, distributed by the time people spend with them, and paid out in full) plus what viewers direct to them. The only deduction anywhere is a cost paid to a third party: card processing. A directed $${SUPPORT.gross} a month reaches its creator as $${SUPPORT.net} at worst, and a $${GAME_10.price} game sale returns $${GAME_10.creatorReceives} whatever the download size. Every creator gets ${FREE_STORAGE_GIB} GiB of free storage; beyond that, the only thing a creator pays is their own storage — our object store's rate plus half again, which goes to free access and the charitable programs — and that is entirely their choice.`,
	},
	"what-can-i-publish": {
		category: "Creators",
		question: "What kinds of content can I publish?",
		answer:
			"Anthers supports games (browser-playable and downloadable), video, audio (music, podcasts), and written content (articles, stories, tutorials). All media types are first-class citizens with dedicated player/reader experiences.",
	},
	// ⚠️ **Payout setup gates RELEASE, and this answer is the one that says so plainly.**
	// The Creator Terms always claimed it; the code only started enforcing it on
	// 2026-08-28, and `/parents` had a paragraph describing the gap. All three agree now.
	// The country limit is stated rather than softened because a creator in one of the
	// other ~160 countries finds out at the moment they try to release, and reading it here
	// first is strictly better than discovering it then.
	"creator-getting-started": {
		category: "Creators",
		question: "What do I need before I can publish?",
		answer:
			"A verified email address, and a completed payout setup with Stripe — the second one before you release anything, free work included. It exists for two reasons beyond paying you: it means no work here is stranded without a way to earn from the Time Pool, and because Stripe verifies identity and will not verify a minor, it is what lets us say every creator on Anthers is an adult without ever asking anyone for an ID. We never see those documents; we read back a yes or a no. The honest cost is that Stripe Connect reaches about 34 countries, so at launch you need to be in one of them — a limit we inherited rather than chose, and one we intend to get out of.",
	},
	"creator-payouts": {
		category: "Creators",
		question: "How do I get paid?",
		answer:
			"Money from a direct purchase, or from a monthly amount someone points at you, goes to your own Stripe account, and payouts run on Stripe's schedule rather than on one we invented. You are paid from the Time Pool as well — the share of what people give Anthers that is distributed by the time they spend with your work, where a minute is a minute whether it is a game, a video, audio or writing. Tax is yours to handle, and we report what we are required to report.",
	},
	"creator-costs": {
		category: "Creators",
		question: "What does it cost to publish here?",
		answer: `Publishing costs nothing, and neither does delivery: a creator is never billed for somebody streaming or downloading their work, at any size and at any volume. There is exactly one creator-side charge and it is storage — your first ${FREE_STORAGE_GIB} GiB are free, and above that you pay our storage provider's rate plus half again, where that half funds free access and Anthers' charitable programs. Anthers takes no cut of anything you earn, so nothing else comes out of what reaches you except the card processing the payment network charges.`,
	},
	"creator-ownership": {
		category: "Creators",
		question: "Who owns what I publish?",
		answer:
			"You do. Publishing here gives Anthers permission to store your work, deliver it to the people you have allowed to see it, and show previews of it — that is what hosting is, and nothing else is implied by it. We do not train machine-learning models on your work or your data, and we don't let anyone else do so through us. You can remove a Work at any time, with one obligation that survives the removal: people who already bought it keep it. It leaves public circulation rather than being destroyed, and we email those buyers so they can download a copy to keep.",
	},
	"creator-exclusivity": {
		category: "Creators",
		question: "Do I have to publish only on Anthers?",
		answer:
			"No. Nothing here asks for exclusivity — publish the same work anywhere else you like, at the same time, and price it differently there if that suits you. You can stop publishing on Anthers whenever you choose, too. What survives that is what you already owe the people who paid you, which is the same obligation that removing a single Work carries.",
	},

	// ── Safety & controls ────────────────────────────────────────────────────
	"content-controls": {
		category: "Safety & Controls",
		question: "Can I control what I see, or what someone in my house sees?",
		answer: (
			<div className="space-y-2">
				<p>
					Yes, at two levels. Every Work carries a rating. Most is <strong>General</strong> and
					carries no restriction at all; <strong>Mature</strong> is labeled and blurred behind a
					click for everybody by default, and can be hidden outright; <strong>Adult</strong> is
					invisible — not merely locked — unless an account has both asked for it and passed a
					one-off check that an adult holds the account.
				</p>
				<p>
					Separately, any account can be given a <strong>pin</strong> from its settings, and the pin
					is then required for every change behind it, including turning the controls off. Those
					controls freeze the content settings where you left them, allow or block particular
					creators and kinds of work, soften strong language, and set time limits per day, week or
					month.{" "}
					<Link to="/parents" className="link text-primary decoration-primary/40">
						The page for parents
					</Link>{" "}
					walks through all of it, including the honest limits — a borrowed credit card passes the
					age check, and a time limit counts time spent with a work open rather than screen time.
				</p>
			</div>
		),
	},
	"data-and-ads": {
		category: "Safety & Controls",
		question: "What do you do with my data?",
		answer: (
			<div className="space-y-2">
				<p>
					There is no advertising on Anthers and no mechanism anywhere that earns us money from
					somebody's time, so there is nothing here to profile you for. No ad identifiers, no
					tracking pixels, and no data sold to anyone. We do not train machine-learning models on
					your work or your data, and we don't let anyone else do so through us.
				</p>
				<p>
					What we keep is what running the place requires: your account, what you published, what
					you bought, and a record of what you spent time with and for how long — which is how
					creators get paid. Creators never see who watched their work, only totals, and the
					per-person records are deleted after {ATTENTION_RAW_RETENTION_DAYS} days, leaving
					anonymous totals behind. The{" "}
					<Link to="/privacy" className="link text-primary decoration-primary/40">
						privacy policy
					</Link>{" "}
					is the long version.
				</p>
			</div>
		),
	},

	// ── Platform & identity ──────────────────────────────────────────────────
	bluesky: {
		category: "Platform & Identity",
		question: "What is the Bluesky integration?",
		answer:
			"You can link your Bluesky account to your Anthers account, so the two identities are connected. That's what exists today. Federation -- your content living across a network of independent servers -- is a direction we're committed to and haven't built yet. We'd rather say that plainly than describe it as though it already works.",
	},
	"open-source": {
		category: "Platform & Identity",
		question: "Is Anthers open source?",
		answer:
			"Yes -- the whole platform is licensed under the AGPL-3.0. You can also download everything you've made from Settings, in one click. Running your own node, and federating between them, is a direction we're committed to rather than something that ships today. The goal is that no single entity -- including Anthers itself -- can become a gatekeeper.",
	},
} satisfies Record<string, FAQItem>;

/** The id of a question in the pool. */
export type FAQId = keyof typeof FAQ_ITEMS;

/** A page that carries a short FAQ of its own. */
export type FAQSurface = "users" | "creators" | "signup";

/**
 * Which questions each page ends on, in the order it asks them.
 *
 * ⚠️ **Keep these short.** A page-level FAQ is the last objection standing between a
 * reader and the button under it, not a second copy of /faq — six or seven closed
 * accordions read as a considered list, and fifteen read as a page that gave up
 * explaining itself. The link to /faq underneath is what makes the pruning safe.
 *
 * The ids are checked by the compiler against `FAQ_ITEMS`, so a renamed or deleted
 * question breaks the build here rather than rendering an empty section.
 */
export const PAGE_FAQS: Record<FAQSurface, FAQId[]> = {
	// The homepage. A visitor who has read it knows what the money does and is now asking
	// the two questions every media platform has earned: is the feed manipulating me, and
	// is the free tier real.
	users: [
		"feed-algorithm",
		"promoted-placement",
		"data-cap",
		"anthers-badge-unlocks",
		"gates",
		"content-controls",
	],
	// /for-creators. The page argues the economics at length, so its FAQ deliberately
	// leads with take-home and then covers the practical things the argument never
	// reaches — what to set up, what it costs, and what you are agreeing to.
	creators: [
		"creator-take-home",
		"creator-payouts",
		"creator-getting-started",
		"creator-costs",
		"what-can-i-publish",
		"creator-ownership",
		"creator-exclusivity",
	],
	// /subscribe. Every question here is one somebody asks with their hand on the button,
	// so the sequence is the order the doubts arrive: what will this cost me, what do I
	// get, can I get out, and what happens to my data.
	signup: [
		"card-required",
		"whats-free",
		"anthers-badge-unlocks",
		"cancel-or-stop",
		"bluesky",
		"data-and-ads",
	],
};

/** Every question, in the order /faq renders them. */
export const ALL_FAQ_ITEMS: FAQItem[] = Object.values(FAQ_ITEMS);

/** The categories /faq groups by, in first-appearance order. */
export const FAQ_CATEGORIES = [...new Set(ALL_FAQ_ITEMS.map((item) => item.category))];

/** The questions a page carries, in its own order. */
export function faqFor(surface: FAQSurface): FAQItem[] {
	return PAGE_FAQS[surface].map((id) => FAQ_ITEMS[id]);
}

/**
 * A whole-dollar amount, written without the trailing cents.
 *
 * `PUBLIC_ACCESS_PRICE` is a number, and `$${PUBLIC_ACCESS_PRICE}` renders `$3` today
 * only because the value happens to be integral. Going through here means a price that
 * gains cents renders as `$3.50` rather than silently losing them.
 */
function money(amount: number): string {
	return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}
