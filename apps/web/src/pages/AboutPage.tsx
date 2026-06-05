// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	AcademicCapIcon,
	BuildingLibraryIcon,
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
					className="absolute inset-0 card bg-base-200/80 shadow-xl p-6 flex flex-col items-center justify-center text-center"
					style={{ backfaceVisibility: "hidden" }}
				>
					<div
						className={`w-20 h-20 rounded-full mb-4 flex items-center justify-center ${
							placeholder
								? "bg-base-300 border-2 border-dashed border-base-content/20"
								: "bg-primary/20"
						}`}
					>
						<span
							className={`text-2xl font-bold ${
								placeholder ? "text-base-content/20" : "text-primary"
							}`}
						>
							{initials}
						</span>
					</div>
					<h3 className={`font-semibold text-lg ${placeholder ? "text-base-content/40" : ""}`}>
						{name}
					</h3>
					<p className="text-sm text-base-content/50">{role}</p>
				</div>

				{/* Back */}
				<div
					className="absolute inset-0 card bg-base-200/80 shadow-xl p-6 flex flex-col items-center justify-center text-center [transform:rotateY(180deg)]"
					style={{ backfaceVisibility: "hidden" }}
				>
					<h3 className={`font-semibold mb-3 ${placeholder ? "text-base-content/40" : ""}`}>
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
			<section className="hero min-h-[50vh]">
				<div className="hero-content text-center py-20">
					<div className="max-w-3xl">
						<p className="text-sm font-medium text-primary mb-3 tracking-wide uppercase">
							About Anthers
						</p>
						<h1 className="text-5xl font-bold tracking-tight">
							The creative internet can work differently.
						</h1>
						<p className="py-6 text-xl text-base-content/70 leading-relaxed max-w-2xl mx-auto">
							Anthers is a federated, open content network for video, audio, text, games, and
							interactive experiences—built and operated as a 501(c)(3) non-profit so that it is
							structurally incapable of prioritizing profit over people.
						</p>
					</div>
				</div>
			</section>

			{/* ═══════════════════════════════════════════════════════════ */}
			{/*  1. WHY WE'RE HERE                                        */}
			{/* ═══════════════════════════════════════════════════════════ */}
			<section className="bg-base-200/50 py-20">
				<div className="max-w-7xl mx-auto px-4">
					<h2 className="text-3xl font-bold text-center mb-3">Why We're Here</h2>
					<p className="text-base-content/70 text-center max-w-3xl mx-auto mb-14">
						The creative internet is broken—not by accident, but by design. Commercial platforms are
						structurally incentivized to extract value from creators rather than serve them.
					</p>

					{/* Alternating left/right blocks instead of card grid */}
					<div className="space-y-12 max-w-3xl mx-auto">
						<div className="flex flex-col md:flex-row gap-6 items-start">
							<div className="shrink-0 w-16 h-16 rounded-xl bg-error/15 flex items-center justify-center">
								<span className="text-2xl">%</span>
							</div>
							<div>
								<h3 className="font-semibold text-lg mb-1">Escalating Cuts</h3>
								<p className="text-base-content/60 leading-relaxed">
									Platforms take increasing percentages of creator revenue. They treat the people
									who make the platform valuable as a cost center—and every funding round, every
									IPO, every acquisition shifts incentives further toward extraction.
								</p>
							</div>
						</div>

						<div className="flex flex-col md:flex-row gap-6 items-start">
							<div className="shrink-0 w-16 h-16 rounded-xl bg-warning/15 flex items-center justify-center">
								<span className="text-2xl">~</span>
							</div>
							<div>
								<h3 className="font-semibold text-lg mb-1">Algorithmic Manipulation</h3>
								<p className="text-base-content/60 leading-relaxed">
									What audiences see is optimized for engagement metrics that serve advertisers—not
									for the content people actually asked for. Discovery algorithms systematically
									privilege outrage and lowest-common-denominator content because those things
									generate clicks and ad impressions.
								</p>
							</div>
						</div>

						<div className="flex flex-col md:flex-row gap-6 items-start">
							<div className="shrink-0 w-16 h-16 rounded-xl bg-info/15 flex items-center justify-center">
								<span className="text-2xl">&times;</span>
							</div>
							<div>
								<h3 className="font-semibold text-lg mb-1">Platform Lock-In</h3>
								<p className="text-base-content/60 leading-relaxed">
									Creator identities, audiences, and livelihoods are held hostage behind proprietary
									walls. Leave, and you lose everything you built. No algorithm change should be
									able to bury a creator's work overnight, and no policy shift should demonetize
									them without recourse.
								</p>
							</div>
						</div>
					</div>

					<p className="text-center mt-14 text-base-content/50 max-w-xl mx-auto text-sm italic">
						The only way to guarantee a creator-first platform is to remove the profit motive
						entirely—not as a promise, but as a legal and structural constraint.
					</p>
				</div>
			</section>

			{/* ═══════════════════════════════════════════════════════════ */}
			{/*  2. WHAT WE DO                                            */}
			{/* ═══════════════════════════════════════════════════════════ */}
			<section className="py-20">
				<div className="max-w-7xl mx-auto px-4">
					<h2 className="text-3xl font-bold text-center mb-3">What We Do</h2>
					<p className="text-base-content/70 text-center max-w-3xl mx-auto mb-6">
						Anthers advances equity in creative and educational content spaces by providing platform
						infrastructure that is structurally incapable of prioritizing profit over the people it
						serves.
					</p>

					{/* Mission summary—two-column prose */}
					<div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-5xl mx-auto mb-16">
						<div className="border-l-2 border-primary/30 pl-6">
							<h3 className="text-sm uppercase tracking-wider text-primary mb-3">For Creators</h3>
							<p className="text-base-content/60 leading-relaxed">
								The vast majority of subscription and purchase revenue flows directly to creators.
								Infrastructure costs are transparent and passed through at cost. The organization's
								operating expenses are fixed to reasonable staff and infrastructure, and all surplus
								is directed to the Anthers Foundation's charitable programs.
							</p>
						</div>
						<div className="border-l-2 border-secondary/30 pl-6">
							<h3 className="text-sm uppercase tracking-wider text-secondary mb-3">
								For Audiences
							</h3>
							<p className="text-base-content/60 leading-relaxed">
								Consumers see what they asked to see. Feeds are chronological and subscriber-driven
								by default. There are no ads, no data monetization, and no engagement-maximization
								algorithms. Subscribers know exactly where every dollar goes—and can see it.
							</p>
						</div>
					</div>

					{/* CRF—the heart of the mission */}
					<div className="max-w-7xl mx-auto">
						<h3 className="text-2xl font-bold text-center mb-2">The Anthers Foundation</h3>
						<p className="text-base-content/70 text-center max-w-3xl mx-auto mb-10">
							The Foundation is the operational heart of Anthers's mission, allocating at least 50%
							of the 8% Foundation Fee to charitable programs: infrastructure equity, education,
							creation grants, and emergency assistance.
						</p>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
							{FOUNDATION_PILLARS.map((pillar) => (
								<div
									key={pillar.title}
									className="card bg-base-200/80 shadow-xl p-6 flex flex-row gap-4"
								>
									<div className="shrink-0 mt-1">
										<pillar.icon className="w-8 h-8 text-secondary" />
									</div>
									<div>
										<h3 className="font-semibold text-lg mb-1">{pillar.title}</h3>
										<p className="text-sm text-base-content/60">{pillar.description}</p>
									</div>
								</div>
							))}
						</div>
						<div className="text-center mt-8">
							<Link to="/subscribe" className="btn btn-secondary btn-sm">
								See Where Your Subscription Goes
							</Link>
						</div>
					</div>
				</div>
			</section>

			{/* ═══════════════════════════════════════════════════════════ */}
			{/*  3. HOW WE DO IT                                          */}
			{/* ═══════════════════════════════════════════════════════════ */}
			<section className="bg-base-200/50 py-20">
				<div className="max-w-7xl mx-auto px-4">
					<h2 className="text-3xl font-bold text-center mb-3">How We Do It</h2>
					<p className="text-base-content/70 text-center max-w-2xl mx-auto mb-14">
						These aren't aspirations. They are structural properties of how Anthers is built,
						incorporated, and governed.
					</p>

					{/* Numbered principles—vertical timeline-style layout */}
					<div className="relative max-w-2xl mx-auto">
						{/* Vertical line */}
						<div className="absolute left-6 top-0 bottom-0 w-px bg-primary/20 hidden md:block" />

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
									text: "The default feed is chronological and subscriber-driven. Algorithmic discovery is available as an opt-in mode, never the primary experience. Anthers has no ads and no incentive to manipulate attention.",
								},
								{
									num: "03",
									title: "Funding Flows Directly",
									text: "Revenue enters through subscriptions and direct purchases. The vast majority goes to creators through a transparent pool model. No matter how much money flows through the platform, operating costs are fixed and every dollar of surplus goes to the Foundation's programs.",
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
								<div key={item.num} className="flex gap-6 items-start relative">
									<div className="shrink-0 w-12 h-12 rounded-full bg-primary/15 flex items-center justify-center z-10">
										<span className="text-sm font-bold text-primary">{item.num}</span>
									</div>
									<div className="pt-1">
										<h3 className="font-semibold text-lg mb-1">{item.title}</h3>
										<p className="text-sm text-base-content/60 leading-relaxed">{item.text}</p>
									</div>
								</div>
							))}
						</div>
					</div>
				</div>
			</section>

			{/* ═══════════════════════════════════════════════════════════ */}
			{/*  4. WHO WE ARE                                            */}
			{/* ═══════════════════════════════════════════════════════════ */}
			<section className="py-20">
				<div className="max-w-7xl mx-auto px-4">
					<h2 className="text-3xl font-bold text-center mb-3">Who We Are</h2>
					<p className="text-base-content/70 text-center max-w-2xl mx-auto mb-12">
						Anthers is in its founding phase. The team is small, building in public, and actively
						seeking board members who believe the creative internet deserves better.
					</p>

					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
						{TEAM_MEMBERS.map((member) => (
							<FlipCard key={member.name} {...member} />
						))}
					</div>

					<p className="text-xs text-base-content/40 text-center mt-8 max-w-lg mx-auto">
						Board seats carry three-year staggered terms with regular rotation. The Executive
						Director serves ex officio and is recused from votes on their own compensation.
					</p>
				</div>
			</section>

			{/* ═══════════════════════════════════════════════════════════ */}
			{/*  5. THE ANTHERS FOUNDATION                                */}
			{/* ═══════════════════════════════════════════════════════════ */}
			<section className="bg-base-200/50 py-20">
				<div className="max-w-7xl mx-auto px-4">
					<div className="flex items-center justify-center gap-3 mb-3">
						<BuildingLibraryIcon className="w-8 h-8 text-primary" />
						<h2 className="text-3xl font-bold">The Anthers Foundation</h2>
					</div>
					<p className="text-base-content/70 text-center max-w-3xl mx-auto mb-14">
						Anthers is a non-profit because the only way to guarantee that our platform always
						serves creators is to make it legally impossible for it to act otherwise. Anthers cannot
						distribute profits to insiders, cannot be acquired, and cannot have its mission diluted
						by investors. If it ever ceases to operate, its assets go to another exempt
						organization, not to founders or shareholders.
					</p>

					{/* Governance—horizontal icon row, not cards */}
					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 mb-16">
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
								<div className="w-14 h-14 rounded-full bg-primary/15 flex items-center justify-center mx-auto mb-3">
									<item.icon className="w-7 h-7 text-primary" />
								</div>
								<h3 className="font-semibold text-sm mb-1">{item.title}</h3>
								<p className="text-xs text-base-content/50">{item.text}</p>
							</div>
						))}
					</div>

					{/* Reports & Compliance—compact table-style */}
					<div className="max-w-3xl mx-auto">
						<div className="flex items-center gap-2 mb-6">
							<DocumentTextIcon className="w-6 h-6 text-primary" />
							<h3 className="text-xl font-bold">Reports & Compliance</h3>
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
									className="flex flex-col md:flex-row md:items-center gap-2 md:gap-6 py-4"
								>
									<div className="md:w-40 shrink-0">
										<h4 className="font-semibold text-sm">{doc.title}</h4>
									</div>
									<p className="text-sm text-base-content/60 flex-1">{doc.description}</p>
									<span className="text-xs text-base-content/40 uppercase tracking-wider shrink-0">
										{doc.cadence}
									</span>
								</div>
							))}
						</div>
					</div>
				</div>
			</section>

			{/* ───────────── CTA ───────────── */}
			<section className="py-20">
				<div className="max-w-3xl mx-auto px-4 text-center">
					<h2 className="text-2xl font-bold mb-3">
						Built to serve creators. Structurally incapable of doing otherwise.
					</h2>
					<p className="text-base-content/70 mb-8 max-w-xl mx-auto">
						Whether you create games, videos, music, writing, or interactive experiences—Anthers is
						designed so that every dollar flows to the people who make the platform valuable.
					</p>
					<div className="flex gap-4 justify-center flex-wrap">
						<Link to="/subscribe" className="btn btn-primary">
							Support Creators
						</Link>
						<Link to="/for-creators" className="btn btn-outline">
							Start Creating
						</Link>
					</div>
				</div>
			</section>
		</div>
	);
}
