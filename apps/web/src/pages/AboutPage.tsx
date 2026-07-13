// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The About marketing page — restyled into the Meadow design (matching
// /for-creators and /for-users). Airy editorial forest-green, Fraunces display
// serif over Nunito Sans. The route wraps this page in the shared <MeadowDecor>
// (pollen + woven side vines) and LoggedOutLayout (Meadow footer + grassy
// floor), so this file only styles the content: alternating tinted section
// bands, the eyebrow/heading/lede rhythm, and rounded cards. Copy is verbatim;
// the FlipCard interaction is preserved.

import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Card, Eyebrow, H2, Lede, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import {
	AcademicCapIcon,
	DocumentTextIcon,
	EyeIcon,
	GlobeAltIcon,
	HeartIcon,
	LockClosedIcon,
	ScaleIcon,
	ShieldCheckIcon,
	UserGroupIcon,
} from "@heroicons/react/24/outline";
import { useState } from "react";
import { Link } from "react-router-dom";

const serif = { fontFamily: FONTS.fraunces };

/* ------------------------------------------------------------------ */
/*  Data                                                               */
/* ------------------------------------------------------------------ */

const FOUNDATION_PILLARS = [
	{
		icon: ShieldCheckIcon,
		title: "Infrastructure Equity",
		description:
			"No creator is priced out of reaching their audience. The Foundation subsidizes hosting for small creators, absorbs viral traffic surges, and funds genuinely free access.",
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

const TEAM_MEMBERS = [
	{
		initials: "P",
		name: "Parker",
		role: "Founder & Executive Director",
		bio: "Architecture, engineering, product, and operations. Building the platform, the organization, and the case that non-profit infrastructure can replace extractive alternatives.",
	},
	{
		initials: "?",
		name: "Board Chair",
		role: "Board of Directors",
		bio: "Independent chair with non-profit board experience. Runs board meetings, manages ED evaluation, and ensures governance discipline from day one.",
		placeholder: true,
	},
	{
		initials: "?",
		name: "Treasurer",
		role: "Board of Directors",
		bio: "Oversees budgets, reviews financial statements, and chairs the finance function. Leads the compensation review process and audit oversight.",
		placeholder: true,
	},
	{
		initials: "?",
		name: "Secretary",
		role: "Board of Directors",
		bio: "Responsible for meeting minutes, document retention, and ensuring the organization maintains proper records and governance compliance.",
		placeholder: true,
	},
];

/* ------------------------------------------------------------------ */
/*  Flip Card Component                                                */
/* ------------------------------------------------------------------ */

function FlipCard({
	initials,
	name,
	role,
	bio,
	placeholder,
}: {
	initials: string;
	name: string;
	role: string;
	bio: string;
	placeholder?: boolean;
}) {
	const [flipped, setFlipped] = useState(false);

	return (
		<div
			className="perspective-[800px] h-64 w-full"
			onMouseEnter={() => setFlipped(true)}
			onMouseLeave={() => setFlipped(false)}
		>
			<div
				className={`relative w-full h-full transition-transform duration-500 ${
					flipped ? "[transform:rotateY(180deg)]" : ""
				}`}
				style={{ transformStyle: "preserve-3d" }}
			>
				{/* Front */}
				<div
					className="absolute inset-0 flex flex-col items-center justify-center rounded-3xl border border-base-content/10 bg-base-100 p-6 text-center shadow-sm"
					style={{ backfaceVisibility: "hidden" }}
				>
					<div
						className={`w-20 h-20 rounded-full mb-4 flex items-center justify-center ${
							placeholder
								? "bg-base-300 border-2 border-dashed border-base-content/20"
								: "bg-primary/10"
						}`}
					>
						<span
							className={`text-2xl font-bold ${
								placeholder ? "text-base-content/25" : "text-primary"
							}`}
						>
							{initials}
						</span>
					</div>
					<h3
						style={serif}
						className={`text-lg font-medium ${placeholder ? "text-base-content/40" : ""}`}
					>
						{name}
					</h3>
					<p className="text-sm text-base-content/50">{role}</p>
				</div>

				{/* Back */}
				<div
					className="absolute inset-0 flex flex-col items-center justify-center rounded-3xl border border-base-content/10 bg-base-100 p-6 text-center shadow-sm [transform:rotateY(180deg)]"
					style={{ backfaceVisibility: "hidden" }}
				>
					<h3
						style={serif}
						className={`mb-3 text-lg font-medium ${placeholder ? "text-base-content/40" : ""}`}
					>
						{name}
					</h3>
					<p className="text-sm text-base-content/60 leading-relaxed">{bio}</p>
					{placeholder && (
						<span className="mt-3 text-xs text-base-content/30 uppercase tracking-wider">
							Seeking candidates
						</span>
					)}
				</div>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Page Component                                                     */
/* ------------------------------------------------------------------ */

export default function AboutPage() {
	return (
		<div>
			{/* ───────────── Hero ───────────── */}
			<header className="bg-base-200/70">
				<div className="mx-auto max-w-5xl px-6 pt-24 pb-20 text-center">
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
					<p className="mx-auto mt-8 max-w-4xl text-lg leading-relaxed text-base-content/75">
						Anthers is a federated, open content network for video, audio, text, games, and
						interactive experiences—built and operated as a 501(c)(3) non-profit so that it is
						structurally incapable of prioritizing profit over people.
					</p>
					<BrandGlyph name="divider-botanical" className="mt-10 h-14 w-52 text-primary/45" />
				</div>
			</header>

			{/* ───────────── 1. Why We're Here ───────────── */}
			<Section>
				<Eyebrow>The problem</Eyebrow>
				<H2>Why We're Here</H2>
				<Lede>
					The creative internet is broken—not by accident, but by design. Commercial platforms are
					structurally incentivized to extract value from creators rather than serve them.
				</Lede>

				<div className="mx-auto mt-14 max-w-3xl space-y-10 text-left">
					<div className="flex flex-col gap-5 md:flex-row md:items-start">
						<div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-2xl text-primary">
							%
						</div>
						<div>
							<h3 style={serif} className="mb-1 text-lg font-medium">
								Escalating Cuts
							</h3>
							<p className="leading-relaxed text-base-content/65">
								Platforms take increasing percentages of creator revenue. They treat the people who
								make the platform valuable as a cost center—and every funding round, every IPO,
								every acquisition shifts incentives further toward extraction.
							</p>
						</div>
					</div>

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
								walls. Leave, and you lose everything you built. No algorithm change should be able
								to bury a creator's work overnight, and no policy shift should demonetize them
								without recourse.
							</p>
						</div>
					</div>
				</div>

				<p className="mx-auto mt-12 max-w-xl text-sm italic leading-relaxed text-base-content/50">
					The only way to guarantee a creator-first platform is to remove the profit motive
					entirely—not as a promise, but as a legal and structural constraint.
				</p>
			</Section>

			{/* ───────────── 2. What We Do ───────────── */}
			<Section tint>
				<Eyebrow>The mission</Eyebrow>
				<H2>What We Do</H2>
				<Lede>
					Anthers advances equity in creative and educational content spaces by providing platform
					infrastructure that is structurally incapable of prioritizing profit over the people it
					serves.
				</Lede>

				{/* Mission summary — two-column prose */}
				<div className="mx-auto mt-14 grid max-w-5xl gap-8 text-left md:grid-cols-2">
					<div className="border-l-2 border-primary/30 pl-6">
						<h3 className="mb-3 text-sm uppercase tracking-wider text-primary">For Creators</h3>
						<p className="leading-relaxed text-base-content/65">
							Every dollar a user spends is one of three things: bandwidth at cost, money to
							creators, or the Anthers Foundation fee. There is no platform margin—Anthers keeps
							nothing. Creators keep 100% of every Boost and every direct purchase, while the shared
							Time Pool pays out to creators by watch-time.
						</p>
					</div>
					<div className="border-l-2 border-secondary/30 pl-6">
						<h3 className="mb-3 text-sm uppercase tracking-wider text-secondary">For Audiences</h3>
						<p className="leading-relaxed text-base-content/65">
							Consumers see what they asked to see. Feeds are chronological and subscriber-driven by
							default. There are no ads, no data monetization, and no engagement-maximization
							algorithms. Subscribers know exactly where every dollar goes—and can see it.
						</p>
					</div>
				</div>

				{/* The Anthers Foundation — the heart of the mission */}
				<div className="mt-16">
					<h3 style={serif} className="text-2xl font-medium sm:text-3xl">
						The Anthers Foundation
					</h3>
					<p className="mx-auto mt-4 max-w-4xl text-lg leading-relaxed text-base-content/65">
						The Foundation is the operational heart of Anthers's mission, funded by the Anthers
						Foundation fee—50% of the bandwidth each stream or download uses, plus 50% of creator
						storage. Around 90% of that fee is charitable: it funds free access for everyone, plus
						infrastructure equity, education, creation grants, and emergency assistance.
					</p>
					<div className="mx-auto mt-10 grid max-w-4xl gap-6 text-left md:grid-cols-2">
						{FOUNDATION_PILLARS.map((pillar) => (
							<Card key={pillar.title} className="flex flex-row gap-4">
								<div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-secondary/10 text-secondary">
									<pillar.icon className="h-6 w-6" />
								</div>
								<div>
									<h3 style={serif} className="mb-1 text-lg font-medium">
										{pillar.title}
									</h3>
									<p className="text-sm leading-relaxed text-base-content/65">
										{pillar.description}
									</p>
								</div>
							</Card>
						))}
					</div>
					<div className="mt-10">
						<Link to="/subscribe" className="btn btn-primary rounded-full px-7">
							See Where Your Subscription Goes
						</Link>
					</div>
				</div>
			</Section>

			{/* ───────────── 3. How We Do It ───────────── */}
			<Section>
				<Eyebrow>By design</Eyebrow>
				<H2>How We Do It</H2>
				<Lede>
					These aren't aspirations. They are structural properties of how Anthers is built,
					incorporated, and governed.
				</Lede>

				{/* Numbered principles — vertical timeline layout */}
				<div className="relative mx-auto mt-14 max-w-2xl text-left">
					{/* Vertical line */}
					<div className="absolute left-6 top-0 bottom-0 hidden w-px bg-primary/15 md:block" />

					<div className="space-y-10">
						{[
							{
								num: "01",
								title: "Creators Own Everything",
								text: "Identity, content, and audience relationships are portable and sovereign. Built on federation and open protocols, a creator's presence on the network cannot be revoked by any single entity. If they disagree with how any node operates, they can move—and their audience comes with them.",
							},
							{
								num: "02",
								title: "Audiences Choose What They See",
								text: "The default feed is chronological and subscriber-driven. Algorithmic discovery is available as an opt-in mode, never the primary experience. Anthers has no ads and nothing to gain from capturing your attention—creators are funded by the time you choose to spend with their work, not by an algorithm built to keep you scrolling.",
							},
							{
								num: "03",
								title: "Funding Flows Directly",
								text: "Money enters through Usage, Boost, and direct purchases. Every dollar is bandwidth at cost, money to creators, or the Anthers Foundation fee—Anthers keeps no margin of its own. The fee itself is mostly charitable, funding free access and the Foundation's programs.",
							},
							{
								num: "04",
								title: "The Profit Motive Is Structurally Eliminated",
								text: "Not voluntarily set aside—legally removed. A 501(c)(3) cannot distribute profits, cannot be acquired, cannot take corrupting investment. If Anthers dissolves, its assets go to another exempt organization.",
							},
							{
								num: "05",
								title: "No Single Entity Can Rug-Pull the Network",
								text: "Federation makes the network resilient to external pressure. Non-profit incorporation makes the organization resilient to internal corruption. Both are necessary. Neither is sufficient alone.",
							},
						].map((item) => (
							<div key={item.num} className="relative flex items-start gap-6">
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
						))}
					</div>
				</div>
			</Section>

			{/* ───────────── 4. Who We Are ───────────── */}
			<Section tint>
				<Eyebrow>The team</Eyebrow>
				<H2>Who We Are</H2>
				<Lede>
					Anthers is in its founding phase. The team is small, building in public, and actively
					seeking board members who believe the creative internet deserves better.
				</Lede>

				<div className="mx-auto mt-14 grid max-w-5xl grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
					{TEAM_MEMBERS.map((member) => (
						<FlipCard key={member.name} {...member} />
					))}
				</div>

				<p className="mx-auto mt-10 max-w-lg text-xs leading-relaxed text-base-content/45">
					Board seats carry three-year staggered terms with regular rotation. The Executive Director
					serves ex officio and is recused from votes on their own compensation.
				</p>
			</Section>

			{/* ───────────── 5. The Anthers Foundation ───────────── */}
			<Section>
				<Eyebrow>Non-profit by design</Eyebrow>
				<H2>The Anthers Foundation</H2>
				<Lede>
					Anthers is a non-profit because the only way to guarantee that our platform always serves
					creators is to make it legally impossible for it to act otherwise. Anthers cannot
					distribute profits to insiders, cannot be acquired, and cannot have its mission diluted by
					investors. If it ever ceases to operate, its assets go to another exempt organization, not
					to founders or shareholders.
				</Lede>

				{/* Governance — icon row */}
				<div className="mx-auto mt-14 grid max-w-4xl grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
					{[
						{
							icon: LockClosedIcon,
							title: "Asset Lock",
							text: "Dissolution sends assets to another exempt org—never to insiders.",
						},
						{
							icon: ScaleIcon,
							title: "No Private Inurement",
							text: "Compensation is reasonable, board-approved, and IRS-enforced.",
						},
						{
							icon: EyeIcon,
							title: "Public Accountability",
							text: "Form 990 filings, financials, and governance are public record.",
						},
						{
							icon: UserGroupIcon,
							title: "Independent Board",
							text: "Real oversight with the authority to override operational decisions.",
						},
					].map((item) => (
						<div key={item.title} className="text-center">
							<div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
								<item.icon className="h-7 w-7" />
							</div>
							<h3 style={serif} className="mb-1 text-base font-medium">
								{item.title}
							</h3>
							<p className="text-xs leading-relaxed text-base-content/55">{item.text}</p>
						</div>
					))}
				</div>

				{/* Reports & Compliance */}
				<Card className="mx-auto mt-14 max-w-3xl text-left">
					<div className="mb-6 flex items-center gap-2">
						<DocumentTextIcon className="h-6 w-6 text-primary" />
						<h3 style={serif} className="text-xl font-medium">
							Reports & Compliance
						</h3>
					</div>
					<div className="divide-y divide-base-content/10">
						{[
							{
								title: "Form 990",
								description:
									"Annual IRS filing disclosing finances, compensation, activities, and governance. Searchable on Candid / GuideStar.",
								cadence: "Annual",
							},
							{
								title: "Foundation Impact Report",
								description:
									"Foundation allocations, program outcomes, and grant activity across all four pillars.",
								cadence: "Annual",
							},
							{
								title: "Independent Audit",
								description:
									"Financial statements reviewed by an independent auditor to ensure accuracy and accountability.",
								cadence: "Annual",
							},
						].map((doc) => (
							<div
								key={doc.title}
								className="flex flex-col gap-2 py-4 md:flex-row md:items-center md:gap-6"
							>
								<div className="shrink-0 md:w-40">
									<h4 className="text-sm font-semibold">{doc.title}</h4>
								</div>
								<p className="flex-1 text-sm text-base-content/60">{doc.description}</p>
								<span className="shrink-0 text-xs uppercase tracking-wider text-base-content/40">
									{doc.cadence}
								</span>
							</div>
						))}
					</div>
				</Card>
			</Section>

			{/* ───────────── Closing CTA ───────────── */}
			<section className="bg-base-200/70">
				<div className="mx-auto max-w-6xl px-6 py-28 text-center">
					<Sprig className="mx-auto mb-6 h-14 w-14 text-primary/70" />
					<h2 style={serif} className="text-balance text-4xl font-light leading-tight sm:text-5xl">
						Built to serve creators. Structurally incapable of doing otherwise.
					</h2>
					<p className="mx-auto mt-5 max-w-4xl text-lg leading-relaxed text-base-content/70">
						Whether you create games, videos, music, writing, or interactive experiences—Anthers is
						designed so that every dollar flows to the people who make the platform valuable.
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
				</div>
			</section>
		</div>
	);
}
