// SPDX-License-Identifier: AGPL-3.0-or-later
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Link } from "@anthers/web-shared/router";
import { type ReactNode, useState } from "react";

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
						<strong>Ambient:</strong> Content matching your stated interests (tags, jams) -- never
						paid promotion
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
					Every dollar you pay goes to creators, to bandwidth at cost, or to a small charitable
					Community Share. There are two ways to pay:
				</p>
				<ul className="list-disc list-inside space-y-1 text-base-content/70">
					<li>
						<strong>Choose a Badge plan</strong> — Free, Root ($4), Sprout ($8), Petal ($16), or
						Blossom ($32) a month. A plan's price is money to creators (the Time Pool, shared out by
						the time you spend with each creator's work, plus included Seeds sent straight to
						creators you pick) and a small Community Share to the Anthers Foundation. Your Badge is
						simply the plan you hold—a point-in-time choice, not a rolling total of past spend.
					</li>
					<li>
						<strong>Sow Seeds</strong> — $1 units you direct to specific creators, Patreon-style.
						100% goes to the creator, with nothing skimmed for a fee or processing.
					</li>
				</ul>
				<p>
					Streaming and downloads draw from a separate <strong>bandwidth wallet</strong>—prepaid at
					cost ($0.01/GiB)—and every plan includes a free monthly bandwidth allowance (5 GiB on
					Free, up to 50 GiB on Blossom). Bandwidth is billed at cost, with no markup. Card
					processing and sales tax are added on top and leave the system entirely.
				</p>
			</div>
		),
	},
	{
		category: "Subscriptions & Payments",
		question: "What is the bandwidth wallet?",
		answer:
			"Streaming and downloading content moves real data, which costs real money to deliver. On Anthers that cost is decoupled from creator funding: it's a prepaid wallet you top up at cost ($0.01/GiB, DigitalOcean's rate), and every Badge plan comes with a free monthly bandwidth allowance (5 GiB on Free, then 10 / 20 / 30 / 50 GiB up the ladder) that's drawn down first. Bandwidth is neutral—none of it is a platform cut, and it never changes what a creator earns.",
	},
	{
		category: "Subscriptions & Payments",
		question: "What is the Anthers Foundation?",
		answer:
			"The Anthers Foundation is funded by the Community Share built into each Badge plan, plus small Foundation fees on creator storage (half of a creator's storage cost) and on direct downloads (half of that download's bandwidth) — never a cut of anyone's earnings. Its revenue splits three ways: 10% to operations, 40% to charitable programs, and 50% to a shared subsidy pool that pays for everyone's free access — free bandwidth allowances, free-user Time Pool and Seeds, and free creator storage. Counting free access as the charitable program it is, roughly 90% of the fee is charitable.",
	},
	{
		category: "Subscriptions & Payments",
		question: "How do direct purchases work?",
		answer:
			"Direct purchases (a game, an album, a one-time download) are Anthers at a 0% cut: the creator sets a price and keeps 100% of it. On top, the buyer pays the delivery bandwidth at cost, a small Foundation fee (for a digital download, half that bandwidth; for a physical good or service, 1% of the price), and card processing plus sales tax. Every added line is a real cost or a charitable fee on top of the price—never subtracted from what the creator earns.",
	},
	{
		category: "Subscriptions & Payments",
		question: "How do gated content and gates work?",
		answer: (
			<div className="space-y-2">
				<p>
					There are two types of gates on Anthers, and creators can combine them with AND/OR logic:
				</p>
				<ul className="list-disc list-inside space-y-1 text-base-content/70">
					<li>
						<strong>Seed gates</strong> — per-creator gates based on how many Seeds you've sown to
						that creator this month. Creators set the thresholds in $1 increments and name the tiers
						themselves.
					</li>
					<li>
						<strong>Anthers gates</strong> — based on the Badge plan you currently hold (Root,
						Sprout, Petal, or Blossom). These unlock the same content across every creator,
						regardless of which one you're viewing.
					</li>
				</ul>
				<p>
					This means a creator could gate content behind "Sprout plan OR $2/mo in Seeds to me,"
					giving users multiple paths to access.
				</p>
			</div>
		),
	},
	{
		category: "Creators",
		question: "How much do creators keep?",
		answer:
			"Nothing is taken out of creator earnings. Creators are funded by the Time Pool (from subscribers' Badge plans, distributed by the time people spend with them) plus 100% of every Seed directed to them. On direct purchases they keep 100% of their listed price. Every creator gets 50 GiB of free storage; beyond that, the only thing a creator pays is their own storage — DigitalOcean's rate plus a small Foundation storage fee — which is entirely their choice.",
	},
	{
		category: "Creators",
		question: "What kinds of content can I publish?",
		answer:
			"Anthers supports games (browser-playable and downloadable), video, audio (music, podcasts), and written content (articles, stories, tutorials). All media types are first-class citizens with dedicated player/reader experiences.",
	},
	{
		category: "Jams & Contests",
		question: "What are Jams?",
		answer:
			"Jams are creative contests where sponsors put out calls for content and creators compete. They support all media types -- not just games. Jams can be sponsored by companies, educators, organizations, the Anthers Foundation, or individual creators. Some jams are size-gated to ensure emerging creators get fair opportunities.",
	},
	{
		category: "Platform & Identity",
		question: "What is AT Protocol / Bluesky integration?",
		answer:
			"Anthers is built on the AT Protocol, the same decentralized protocol that powers Bluesky. This means your identity, content, and relationships are portable -- you're not locked into Anthers. You can link your Bluesky account to sign in and eventually your content will be federated across the AT Protocol network.",
	},
	{
		category: "Platform & Identity",
		question: "Is Anthers open source?",
		answer:
			"Anthers is built with federation in mind. The platform uses open protocols (AT Protocol) so creators can eventually host their own nodes. The goal is that no single entity -- including Anthers itself -- can become a gatekeeper.",
	},
];

const CATEGORIES = [...new Set(FAQ_ITEMS.map((item) => item.category))];

function FAQAccordion({ item }: { item: FAQItem }) {
	const [open, setOpen] = useState(false);

	return (
		<div className="collapse collapse-arrow bg-base-200">
			<input type="checkbox" checked={open} onChange={() => setOpen(!open)} />
			<div className="collapse-title font-medium text-sm">{item.question}</div>
			<div className="collapse-content text-sm text-base-content/70">
				{typeof item.answer === "string" ? <p>{item.answer}</p> : item.answer}
			</div>
		</div>
	);
}

export default function FAQPage() {
	return (
		<div className="container mx-auto px-4 py-8 max-w-3xl">
			<Reveal>
				<h1 className="text-3xl font-bold mb-2">Frequently Asked Questions</h1>
			</Reveal>
			<Reveal delay={120}>
				<p className="text-base-content/60 mb-8">
					Everything you need to know about how Anthers works.
				</p>
			</Reveal>

			{CATEGORIES.map((category) => (
				<section key={category} className="mb-8">
					<h2 className="text-lg font-semibold mb-3 text-base-content/80">{category}</h2>
					<div className="flex flex-col gap-2">
						{FAQ_ITEMS.filter((item) => item.category === category).map((item, i) => (
							<Reveal key={item.question} delay={i * 60}>
								<FAQAccordion item={item} />
							</Reveal>
						))}
					</div>
				</section>
			))}

			<Reveal className="text-center py-8 border-t border-base-300/50 mt-8">
				<p className="text-sm text-base-content/50 mb-3">Still have questions?</p>
				<div className="flex gap-3 justify-center">
					<Link to="/about" className="btn btn-ghost btn-sm">
						About Anthers
					</Link>
					<Link to="/wiki" className="btn btn-ghost btn-sm">
						Wiki
					</Link>
				</div>
			</Reveal>
		</div>
	);
}
