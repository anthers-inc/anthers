// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Anthers-vs-Ghost comparison page — restyled into the Meadow design
// (matching /for-creators). Airy editorial forest-green, Fraunces display serif
// over Nunito Sans, alternating tinted section bands, rounded cards, and a
// comparison table nested inside a Card. The page is wrapped in <MeadowDecor> at
// the route level (side vines + pollen + Nunito body), so this file styles only
// the content. Copy is preserved verbatim from the original comparison page.

import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Card, Eyebrow, H2, Lede, Section } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link } from "@anthers/web-shared/router";
import {
	ArrowPathIcon,
	CodeBracketIcon,
	CurrencyDollarIcon,
	DocumentTextIcon,
	EyeIcon,
	FilmIcon,
	GlobeAltIcon,
	LockOpenIcon,
	MusicalNoteIcon,
	NewspaperIcon,
	PlayIcon,
	PuzzlePieceIcon,
	TrophyIcon,
	UserGroupIcon,
} from "@heroicons/react/24/outline";

const serif = { fontFamily: FONTS.fraunces };

export default function CompareGhostPage() {
	const { isAuthenticated } = useAuth();
	const startHref = isAuthenticated ? "/dashboard" : "/signup";

	return (
		<div>
			{/* Hero */}
			<header className="bg-base-200/70">
				<div className="mx-auto max-w-5xl px-6 pt-24 pb-20 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-5 h-11 w-11 text-primary/60" />
						<p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
							Anthers vs Ghost
						</p>
						<h1
							style={serif}
							className="text-balance text-5xl font-light leading-[1.05] tracking-tight sm:text-7xl"
						>
							Different missions,
							<br />
							<em className="font-medium text-primary not-italic">different strengths</em>
						</h1>
					</Reveal>
					<Reveal delay={150}>
						<p className="mx-auto mt-8 max-w-4xl text-lg leading-relaxed text-base-content/75">
							Ghost is a beautifully crafted publishing platform for writers and newsletter
							creators. Anthers is a creator economy platform for games, video, audio, and writing.
							Here's how they compare and where each one shines.
						</p>
					</Reveal>
					<Reveal delay={300}>
						<div className="mt-9 flex flex-wrap justify-center gap-3">
							<Link to={startHref} className="btn btn-primary rounded-full px-8">
								Try Anthers Free
							</Link>
						</div>
						<BrandGlyph
							name="divider-botanical"
							className="-mb-20 -mt-5 h-24 w-52 text-primary/45"
						/>
					</Reveal>
				</div>
			</header>

			{/* Positioning */}
			<Section>
				<Reveal>
					<Eyebrow>Positioning</Eyebrow>
					<H2>Two platforms, two philosophies</H2>
					<Lede>
						Ghost and Anthers share some values—independence, creator ownership, transparent
						economics—but they're built for different creative workflows.
					</Lede>
				</Reveal>
				<div className="mx-auto mt-12 grid max-w-4xl gap-8 text-left md:grid-cols-2">
					<Reveal delay={0} className="h-full">
						<Card className="card-lift h-full">
							<h3 style={serif} className="mb-2 flex items-center gap-2 text-lg font-medium">
								<NewspaperIcon className="h-5 w-5 text-base-content/50" />
								Ghost
							</h3>
							<p className="mb-4 text-sm leading-relaxed text-base-content/65">
								A professional publishing platform built for writers, journalists, and newsletter
								creators. Ghost excels at long-form content, email newsletters, paid memberships,
								and SEO-optimized websites.
							</p>
							<ul className="flex flex-col gap-2 text-sm text-base-content/65">
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">✓</span>
									Beautiful blog and newsletter publishing
								</li>
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">✓</span>
									Powerful theming and custom websites
								</li>
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">✓</span>
									Built-in SEO and email delivery
								</li>
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">✓</span>
									Non-profit, open-source foundation
								</li>
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">✓</span>
									Self-hostable with full source code access
								</li>
							</ul>
						</Card>
					</Reveal>

					<Reveal delay={110} className="h-full">
						<Card className="ring-1 ring-primary/30 card-lift h-full">
							<h3 style={serif} className="mb-2 flex items-center gap-2 text-lg font-medium">
								<PlayIcon className="h-5 w-5 text-primary" />
								Anthers
							</h3>
							<p className="mb-4 text-sm leading-relaxed text-base-content/65">
								A creator economy platform built for multi-media indie creators. Anthers is designed
								for people who make games, videos, music, and written content—and want one home for
								all of it.
							</p>
							<ul className="flex flex-col gap-2 text-sm text-base-content/65">
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">✓</span>
									Games, video, audio, and writing in one place
								</li>
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">✓</span>
									0% platform fee on every Seed and sale—no revenue share, ever
								</li>
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">✓</span>
									Game jams, ratings, and community features
								</li>
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">✓</span>
									AT Protocol for data portability
								</li>
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">✓</span>
									Subscription pool with time-based distribution
								</li>
							</ul>
						</Card>
					</Reveal>
				</div>
			</Section>

			{/* Media Support */}
			<Section tint>
				<Reveal>
					<Eyebrow>Every medium</Eyebrow>
					<H2>Content types at a glance</H2>
					<Lede>
						Ghost is laser-focused on written publishing and newsletters. Anthers covers a wider
						range of creative media—ideal for indie creators who work across multiple formats.
					</Lede>
				</Reveal>
				<div className="mx-auto mt-14 grid max-w-4xl gap-6 sm:grid-cols-2 lg:grid-cols-4">
					<Reveal delay={0} className="h-full">
						<ContentCard
							icon={<PuzzlePieceIcon className="h-7 w-7" />}
							title="Games"
							color="badge-secondary"
							anthers
						/>
					</Reveal>
					<Reveal delay={100} className="h-full">
						<ContentCard
							icon={<FilmIcon className="h-7 w-7" />}
							title="Video"
							color="badge-error"
							anthers
						/>
					</Reveal>
					<Reveal delay={200} className="h-full">
						<ContentCard
							icon={<MusicalNoteIcon className="h-7 w-7" />}
							title="Audio"
							color="badge-success"
							anthers
						/>
					</Reveal>
					<Reveal delay={300} className="h-full">
						<ContentCard
							icon={<DocumentTextIcon className="h-7 w-7" />}
							title="Writing"
							color="badge-info"
							anthers
							ghost
						/>
					</Reveal>
				</div>
			</Section>

			{/* Key Differences */}
			<Section>
				<Reveal>
					<Eyebrow>Head to head</Eyebrow>
					<H2>Where they differ</H2>
				</Reveal>
				<div className="mx-auto mt-14 grid max-w-5xl gap-x-12 gap-y-10 text-left md:grid-cols-2">
					<Reveal delay={0}>
						<DiffCard
							icon={<CurrencyDollarIcon className="h-6 w-6" />}
							title="Revenue model"
							description="Ghost charges a monthly hosting fee ($9-$199+/mo for Ghost Pro) and takes 0% of membership revenue. Anthers is free to use and takes 0% of sales—real costs are passed through as transparent line items to the buyer. Both platforms let creators keep what they earn."
						/>
					</Reveal>
					<Reveal delay={100}>
						<DiffCard
							icon={<EyeIcon className="h-6 w-6" />}
							title="Publishing approach"
							description="Ghost gives you a full website with custom themes, SEO tools, and email newsletter delivery—it's a CMS. Anthers gives you a creator profile with project pages, devlogs, and a built-in audience—it's a marketplace and community platform."
						/>
					</Reveal>
					<Reveal delay={200}>
						<DiffCard
							icon={<UserGroupIcon className="h-6 w-6" />}
							title="Audience model"
							description="Ghost's audience model is email-first: visitors become newsletter subscribers, then paid members. Anthers' model is follow-first: users follow creators and see their work in a personalized feed, with subscription pools distributing revenue by watch-time."
						/>
					</Reveal>
					<Reveal delay={300}>
						<DiffCard
							icon={<CodeBracketIcon className="h-6 w-6" />}
							title="Open-source approach"
							description="Ghost is fully open-source (MIT license) and self-hostable. Their non-profit foundation has been building in the open since 2013. Anthers is built on the AT Protocol for data portability and federation, with a focus on open identity rather than open infrastructure."
						/>
					</Reveal>
					<Reveal delay={400}>
						<DiffCard
							icon={<TrophyIcon className="h-6 w-6" />}
							title="Community features"
							description="Ghost focuses on the creator-to-reader relationship: write, publish, deliver via email. Anthers adds community mechanics like game jams, project ratings, comments, and follow/feed—built for the kind of interactive, collaborative community that forms around indie games and creative projects."
						/>
					</Reveal>
					<Reveal delay={500}>
						<DiffCard
							icon={<GlobeAltIcon className="h-6 w-6" />}
							title="Customization"
							description="Ghost offers deep website customization with hundreds of themes, custom code injection, and a full theme development framework. Anthers focuses on creator profiles and project pages with consistent structure—less custom design, more consistent discovery experience."
						/>
					</Reveal>
				</div>
			</Section>

			{/* Feature Comparison Table */}
			<Section tint>
				<Reveal>
					<Eyebrow>Side by side</Eyebrow>
					<H2>Feature by feature</H2>
				</Reveal>
				<Reveal>
					<Card className="mx-auto mt-12 max-w-3xl overflow-x-auto">
						<table className="table">
							<thead>
								<tr className="border-base-content/10">
									<th style={serif} className="font-medium">
										Feature
									</th>
									<th style={serif} className="bg-primary/5 text-center font-medium">
										Anthers
									</th>
									<th style={serif} className="text-center font-medium">
										Ghost
									</th>
								</tr>
							</thead>
							<tbody>
								<CompRow feature="Blog / long-form writing" anthers ghost />
								<CompRow feature="Email newsletters" ghost />
								<CompRow feature="Paid memberships" ghost />
								<CompRow feature="Custom website & themes" ghost />
								<CompRow feature="Built-in SEO tools" ghost />
								<CompRow feature="Game hosting & downloads" anthers />
								<CompRow feature="HTML5 web games" anthers />
								<CompRow feature="Video hosting" anthers />
								<CompRow feature="Audio / music hosting" anthers />
								<CompRow feature="Game jams" anthers />
								<CompRow feature="Ratings & comments" anthers />
								<CompRow feature="Follow & feed system" anthers />
								<CompRow feature="Creator profiles" anthers />
								<CompRow feature="Subscription pool model" anthers />
								<CompRow feature="Transparent itemized fees" anthers />
								<CompRow feature="0% platform revenue share" anthers ghost />
								<CompRow feature="Self-hostable" ghost />
								<CompRow feature="Open-source codebase" ghost />
								<CompRow feature="AT Protocol / portable identity" anthers />
								<CompRow feature="Headless CMS / API" ghost />
								<CompRow feature="Import from other platforms" anthers ghost />
							</tbody>
						</table>
					</Card>
				</Reveal>
			</Section>

			{/* When to Use Which */}
			<Section>
				<Reveal>
					<Eyebrow>The right fit</Eyebrow>
					<H2>Which one is right for you?</H2>
				</Reveal>
				<div className="mx-auto mt-12 grid max-w-4xl gap-8 text-left md:grid-cols-2">
					<Reveal delay={0} className="h-full">
						<Card className="card-lift h-full">
							<h3 style={serif} className="mb-3 text-lg font-medium">
								Choose Ghost if you...
							</h3>
							<ul className="flex flex-col gap-3 text-sm text-base-content/65">
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">→</span>
									Are primarily a writer, journalist, or newsletter creator
								</li>
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">→</span>
									Want a custom-designed website with your own domain
								</li>
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">→</span>
									Need powerful email newsletter delivery and segmentation
								</li>
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">→</span>
									Want to self-host and own your entire infrastructure
								</li>
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">→</span>
									Need advanced SEO tools for content marketing
								</li>
							</ul>
						</Card>
					</Reveal>

					<Reveal delay={110} className="h-full">
						<Card className="ring-1 ring-primary/30 card-lift h-full">
							<h3 style={serif} className="mb-3 text-lg font-medium">
								Choose Anthers if you...
							</h3>
							<ul className="flex flex-col gap-3 text-sm text-base-content/65">
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">→</span>
									Make games, videos, music, or multimedia creative work
								</li>
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">→</span>
									Want one platform for all your creative output
								</li>
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">→</span>
									Want to participate in game jams and community events
								</li>
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">→</span>
									Care about data portability and owning your identity
								</li>
								<li className="flex gap-2">
									<span className="shrink-0 text-primary">→</span>
									Want a platform that takes no cut of your sales at all
								</li>
							</ul>
						</Card>
					</Reveal>
				</div>
			</Section>

			{/* Data Portability */}
			<Section tint>
				<Reveal>
					<Eyebrow>Ownership</Eyebrow>
					<H2>Both believe in creator ownership</H2>
					<Lede>
						Ghost and Anthers share a core belief: creators should own their work, their audience,
						and their data. They just approach it differently.
					</Lede>
				</Reveal>
				<div className="mx-auto mt-14 grid max-w-4xl gap-8 text-left sm:grid-cols-3">
					<Reveal delay={0}>
						<div>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
								<LockOpenIcon className="h-6 w-6" />
							</div>
							<h3 style={serif} className="mb-2 text-lg font-medium">
								Ghost: open source
							</h3>
							<p className="text-sm leading-relaxed text-base-content/70">
								Ghost publishes its entire codebase under the MIT license. You can self-host,
								modify, and run your own instance. Your data lives on your server.
							</p>
						</div>
					</Reveal>
					<Reveal delay={110}>
						<div>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
								<ArrowPathIcon className="h-6 w-6" />
							</div>
							<h3 style={serif} className="mb-2 text-lg font-medium">
								Anthers: open protocol
							</h3>
							<p className="text-sm leading-relaxed text-base-content/70">
								Anthers builds on the AT Protocol. Your identity is a portable DID. Your content is
								interoperable. Federation means no single point of control.
							</p>
						</div>
					</Reveal>
					<Reveal delay={220}>
						<div>
							<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
								<GlobeAltIcon className="h-6 w-6" />
							</div>
							<h3 style={serif} className="mb-2 text-lg font-medium">
								Same goal
							</h3>
							<p className="text-sm leading-relaxed text-base-content/70">
								Both reject the model where platforms own your audience and take a cut of your
								revenue. Different architectures, same creator-first mission.
							</p>
						</div>
					</Reveal>
				</div>
			</Section>

			{/* Closing */}
			<section className="bg-base-200/70">
				<div className="mx-auto max-w-6xl px-6 py-28 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-6 h-14 w-14 text-primary/70" />
						<h2
							style={serif}
							className="text-balance text-4xl font-light leading-tight sm:text-5xl"
						>
							Ready to publish your creative work?
						</h2>
						<p className="mx-auto mt-5 max-w-4xl text-lg leading-relaxed text-base-content/70">
							If you're a writer or journalist, Ghost is an excellent choice. If you make games,
							videos, music, or multimedia creative work — Anthers was built for you. Free to use,
							and Anthers takes no cut of any Seed or sale — the only deductions are card processing
							and delivery, at cost, itemized in full.
						</p>
						<div className="mt-8 flex flex-wrap justify-center gap-3">
							<Link to={startHref} className="btn btn-primary rounded-full px-7">
								Create Your Account
							</Link>
							<Link
								to="/for-creators"
								className="btn btn-outline rounded-full border-base-content/20 px-7"
							>
								Learn More
							</Link>
						</div>
					</Reveal>
				</div>
			</section>
		</div>
	);
}

// ─── Local building blocks (page-specific; shared editorial primitives —
//     Section/Eyebrow/H2/Lede/Card — come from @anthers/web-shared/decor/sections) ───

/** A titled difference in the "where they differ" grid. */
function DiffCard({
	icon,
	title,
	description,
}: {
	icon: React.ReactNode;
	title: string;
	description: string;
}) {
	return (
		<div className="flex gap-4">
			<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
				{icon}
			</div>
			<div>
				<h3 style={serif} className="mb-1 text-base font-medium">
					{title}
				</h3>
				<p className="text-sm leading-relaxed text-base-content/65">{description}</p>
			</div>
		</div>
	);
}

/** A media-type card in the "content types at a glance" grid. */
function ContentCard({
	icon,
	title,
	color,
	anthers,
	ghost,
}: {
	icon: React.ReactNode;
	title: string;
	color: string;
	anthers?: boolean;
	ghost?: boolean;
}) {
	return (
		<Card className="text-center card-lift h-full">
			<div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
				{icon}
			</div>
			<span className={`badge badge-sm ${color} mx-auto mb-3`}>{title}</span>
			<div className="flex flex-col gap-1 text-xs text-base-content/55">
				{anthers && (
					<span>
						<span className="text-primary">✓</span> Anthers
					</span>
				)}
				{ghost && (
					<span>
						<span className="text-primary">✓</span> Ghost
					</span>
				)}
				{!ghost && (
					<span>
						<span className="text-base-content/20">—</span> Ghost
					</span>
				)}
			</div>
		</Card>
	);
}

/** A ✓/– row in the feature-comparison table (Anthers column highlighted). */
function CompRow({
	feature,
	anthers,
	ghost,
}: {
	feature: string;
	anthers?: boolean;
	ghost?: boolean;
}) {
	const check = <span className="font-bold text-primary">✓</span>;
	const dash = <span className="text-base-content/20">—</span>;
	return (
		<tr className="border-base-content/10">
			<td>{feature}</td>
			<td className="bg-primary/5 text-center">{anthers ? check : dash}</td>
			<td className="text-center">{ghost ? check : dash}</td>
		</tr>
	);
}
