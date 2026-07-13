// SPDX-License-Identifier: AGPL-3.0-or-later
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";

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
					There's no fixed subscription. You make two independent, prepaid choices, and Anthers
					keeps nothing—every dollar you pay is itemized:
				</p>
				<ul className="list-disc list-inside space-y-1 text-base-content/70">
					<li>
						<strong>Usage</strong> — open, watch-anything access, bought per GiB. Every GiB is
						$0.03: $0.01 bandwidth at cost, $0.005 to the Anthers Foundation, and $0.015 to creators
						through the Time Pool. Sold in 100 GiB / $3.00 packs, with your first 3 GiB free.
					</li>
					<li>
						<strong>Boost</strong> — $1 units you direct to specific creators, Patreon-style. 100%
						goes to the creator, with no fee and nothing skimmed for processing.
					</li>
				</ul>
				<p>
					Your combined Usage + Boost spend earns a rolling <strong>Anthers Badge</strong>—Root
					(≥$3), Sprout (≥$7), Petal (≥$15), or Blossom (≥$30)—which unlocks platform-wide gated
					content. There's no platform cut at any level: half of every usage dollar funds creators,
					a third is real bandwidth, a sixth is the Foundation's charity fee, and every boost dollar
					goes straight to a creator. Card processing and sales tax are added on top and leave the
					system entirely.
				</p>
			</div>
		),
	},
	{
		category: "Subscriptions & Payments",
		question: "What is the Anthers Foundation?",
		answer:
			"The Anthers Foundation is funded by the Anthers Foundation Fee (AFF) — 50% of the bandwidth you use, plus 50% of a creator's storage cost — never a cut of anyone's earnings. Its revenue splits three ways: 10% to operations, 40% to charitable programs, and 50% to a shared subsidy pool that pays for everyone's free access (free usage for users, free storage for creators). Counting free access as the charitable program it is, roughly 90% of the fee is charitable.",
	},
	{
		category: "Subscriptions & Payments",
		question: "How do direct purchases work?",
		answer:
			"Direct purchases (a game, an album, a one-time download) sit outside the Usage and Boost system. The creator sets a price and keeps 100% of it. On top, the buyer pays the delivery bandwidth at cost, the Anthers Foundation Fee (for a digital download, half that bandwidth; for a physical good or service, 1% of the price), and card processing plus sales tax. Anthers keeps $0 — every line is a real cost or a charitable fee, never a platform cut.",
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
						<strong>Boost gates</strong> — per-creator gates based on how much you've boosted that
						creator this month. Creators set the thresholds in $1 increments and name the tiers
						themselves.
					</li>
					<li>
						<strong>Anthers gates</strong> — based on your current Anthers Badge (Root, Sprout,
						Petal, or Blossom), earned from your combined Usage + Boost spend. These unlock the same
						content across every creator, regardless of which one you're viewing.
					</li>
				</ul>
				<p>
					This means a creator could gate content behind "Sprout badge OR $2/mo boost to me," giving
					users multiple paths to access.
				</p>
			</div>
		),
	},
	{
		category: "Creators",
		question: "How much do creators keep?",
		answer:
			"Anthers never takes a cut. Creators are funded by the Time Pool (from users' Usage, distributed by the time people spend with them) plus 100% of every Boost dollar directed to them. On direct purchases they keep 100% of their listed price. The only thing a creator pays is their own storage beyond a free 3 GiB -- DigitalOcean's rate plus the Foundation's storage fee -- which is entirely their choice.",
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
