// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
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
import { Link } from "react-router-dom";

export default function CompareGhostPage() {
	const { isAuthenticated } = useAuth();

	return (
		<div>
			{/* ───────────── Hero ───────────── */}
			<section className="hero min-h-[60vh]">
				<div className="hero-content text-center py-20">
					<div className="max-w-3xl">
						<p className="text-sm font-medium text-primary mb-3 tracking-wide uppercase">
							Anthers vs Ghost
						</p>
						<h1 className="text-5xl font-bold tracking-tight">
							Different missions, different strengths
						</h1>
						<p className="py-6 text-xl text-base-content/70 leading-relaxed max-w-2xl mx-auto">
							Ghost is a beautifully crafted publishing platform for writers and newsletter
							creators. Anthers is a creator economy platform for games, video, audio, and writing.
							Here's how they compare and where each one shines.
						</p>
						<div className="flex gap-4 justify-center flex-wrap">
							<Link
								to={isAuthenticated ? "/dashboard" : "/signup"}
								className="btn btn-primary btn-lg"
							>
								Try Anthers Free
							</Link>
							<Link to="/discover" className="btn btn-outline btn-lg">
								Explore Projects
							</Link>
						</div>
					</div>
				</div>
			</section>

			{/* ───────────── Positioning ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">Two platforms, two philosophies</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Ghost and Anthers share some values—independence, creator ownership, transparent
						economics—but they're built for different creative workflows.
					</p>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-8">
						<div className="card bg-base-100">
							<div className="card-body">
								<h3 className="font-bold text-lg mb-2 flex items-center gap-2">
									<NewspaperIcon className="w-5 h-5 text-base-content/50" />
									Ghost
								</h3>
								<p className="text-sm text-base-content/60 leading-relaxed mb-4">
									A professional publishing platform built for writers, journalists, and newsletter
									creators. Ghost excels at long-form content, email newsletters, paid memberships,
									and SEO-optimized websites.
								</p>
								<ul className="text-sm text-base-content/60 flex flex-col gap-2">
									<li className="flex gap-2">
										<span className="text-success flex-shrink-0">✓</span>
										Beautiful blog and newsletter publishing
									</li>
									<li className="flex gap-2">
										<span className="text-success flex-shrink-0">✓</span>
										Powerful theming and custom websites
									</li>
									<li className="flex gap-2">
										<span className="text-success flex-shrink-0">✓</span>
										Built-in SEO and email delivery
									</li>
									<li className="flex gap-2">
										<span className="text-success flex-shrink-0">✓</span>
										Non-profit, open-source foundation
									</li>
									<li className="flex gap-2">
										<span className="text-success flex-shrink-0">✓</span>
										Self-hostable with full source code access
									</li>
								</ul>
							</div>
						</div>

						<div className="card bg-base-100 ring-2 ring-primary/30">
							<div className="card-body">
								<h3 className="font-bold text-lg mb-2 flex items-center gap-2">
									<PlayIcon className="w-5 h-5 text-primary" />
									Anthers
								</h3>
								<p className="text-sm text-base-content/60 leading-relaxed mb-4">
									A creator economy platform built for multi-media indie creators. Anthers is
									designed for people who make games, videos, music, and written content—and want
									one home for all of it.
								</p>
								<ul className="text-sm text-base-content/60 flex flex-col gap-2">
									<li className="flex gap-2">
										<span className="text-success flex-shrink-0">✓</span>
										Games, video, audio, and writing in one place
									</li>
									<li className="flex gap-2">
										<span className="text-success flex-shrink-0">✓</span>
										100% to creators—no platform revenue share
									</li>
									<li className="flex gap-2">
										<span className="text-success flex-shrink-0">✓</span>
										Game jams, ratings, and community features
									</li>
									<li className="flex gap-2">
										<span className="text-success flex-shrink-0">✓</span>
										AT Protocol for data portability
									</li>
									<li className="flex gap-2">
										<span className="text-success flex-shrink-0">✓</span>
										Subscription pool with attention-based distribution
									</li>
								</ul>
							</div>
						</div>
					</div>
				</div>
			</section>

			{/* ───────────── Media Support ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">Content types at a glance</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Ghost is laser-focused on written publishing and newsletters. Anthers covers a wider
						range of creative media—ideal for indie creators who work across multiple formats.
					</p>

					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
						<ContentCard
							icon={<PuzzlePieceIcon className="w-7 h-7" />}
							title="Games"
							color="badge-secondary"
							anthers
						/>
						<ContentCard
							icon={<FilmIcon className="w-7 h-7" />}
							title="Video"
							color="badge-error"
							anthers
						/>
						<ContentCard
							icon={<MusicalNoteIcon className="w-7 h-7" />}
							title="Audio"
							color="badge-success"
							anthers
						/>
						<ContentCard
							icon={<DocumentTextIcon className="w-7 h-7" />}
							title="Writing"
							color="badge-info"
							anthers
							ghost
						/>
					</div>
				</div>
			</section>

			{/* ───────────── Key Differences ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-12">Where they differ</h2>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-10">
						<DiffCard
							icon={<CurrencyDollarIcon className="w-6 h-6" />}
							title="Revenue model"
							description="Ghost charges a monthly hosting fee ($9-$199+/mo for Ghost Pro) and takes 0% of membership revenue. Anthers is free to use and takes 0% of sales—real costs are passed through as transparent line items to the buyer. Both platforms let creators keep what they earn."
						/>
						<DiffCard
							icon={<EyeIcon className="w-6 h-6" />}
							title="Publishing approach"
							description="Ghost gives you a full website with custom themes, SEO tools, and email newsletter delivery—it's a CMS. Anthers gives you a creator profile with project pages, devlogs, and a built-in audience—it's a marketplace and community platform."
						/>
						<DiffCard
							icon={<UserGroupIcon className="w-6 h-6" />}
							title="Audience model"
							description="Ghost's audience model is email-first: visitors become newsletter subscribers, then paid members. Anthers's model is follow-first: users follow creators and see their work in a personalized feed, with subscription pools distributing revenue by attention time."
						/>
						<DiffCard
							icon={<CodeBracketIcon className="w-6 h-6" />}
							title="Open-source approach"
							description="Ghost is fully open-source (MIT license) and self-hostable. Their non-profit foundation has been building in the open since 2013. Anthers is built on the AT Protocol for data portability and federation, with a focus on open identity rather than open infrastructure."
						/>
						<DiffCard
							icon={<TrophyIcon className="w-6 h-6" />}
							title="Community features"
							description="Ghost focuses on the creator-to-reader relationship: write, publish, deliver via email. Anthers adds community mechanics like game jams, project ratings, comments, and follow/feed—built for the kind of interactive, collaborative community that forms around indie games and creative projects."
						/>
						<DiffCard
							icon={<GlobeAltIcon className="w-6 h-6" />}
							title="Customization"
							description="Ghost offers deep website customization with hundreds of themes, custom code injection, and a full theme development framework. Anthers focuses on creator profiles and project pages with consistent structure—less custom design, more consistent discovery experience."
						/>
					</div>
				</div>
			</section>

			{/* ───────────── Feature Comparison Table ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-12">Feature by feature</h2>

					<div className="overflow-x-auto">
						<table className="table max-w-3xl mx-auto">
							<thead>
								<tr>
									<th>Feature</th>
									<th className="text-center">Anthers</th>
									<th className="text-center">Ghost</th>
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
					</div>
				</div>
			</section>

			{/* ───────────── When to Use Which ───────────── */}
			<section className="bg-base-200/50 py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-12">Which one is right for you?</h2>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-8">
						<div className="card bg-base-100">
							<div className="card-body">
								<h3 className="font-bold text-lg mb-3">Choose Ghost if you...</h3>
								<ul className="text-sm text-base-content/60 flex flex-col gap-3">
									<li className="flex gap-2">
										<span className="text-primary flex-shrink-0">→</span>
										Are primarily a writer, journalist, or newsletter creator
									</li>
									<li className="flex gap-2">
										<span className="text-primary flex-shrink-0">→</span>
										Want a custom-designed website with your own domain
									</li>
									<li className="flex gap-2">
										<span className="text-primary flex-shrink-0">→</span>
										Need powerful email newsletter delivery and segmentation
									</li>
									<li className="flex gap-2">
										<span className="text-primary flex-shrink-0">→</span>
										Want to self-host and own your entire infrastructure
									</li>
									<li className="flex gap-2">
										<span className="text-primary flex-shrink-0">→</span>
										Need advanced SEO tools for content marketing
									</li>
								</ul>
							</div>
						</div>

						<div className="card bg-base-100 ring-2 ring-primary/30">
							<div className="card-body">
								<h3 className="font-bold text-lg mb-3">Choose Anthers if you...</h3>
								<ul className="text-sm text-base-content/60 flex flex-col gap-3">
									<li className="flex gap-2">
										<span className="text-primary flex-shrink-0">→</span>
										Make games, videos, music, or multimedia creative work
									</li>
									<li className="flex gap-2">
										<span className="text-primary flex-shrink-0">→</span>
										Want one platform for all your creative output
									</li>
									<li className="flex gap-2">
										<span className="text-primary flex-shrink-0">→</span>
										Want to participate in game jams and community events
									</li>
									<li className="flex gap-2">
										<span className="text-primary flex-shrink-0">→</span>
										Care about data portability and owning your identity
									</li>
									<li className="flex gap-2">
										<span className="text-primary flex-shrink-0">→</span>
										Want 100% of your sale price with zero platform fees
									</li>
								</ul>
							</div>
						</div>
					</div>
				</div>
			</section>

			{/* ───────────── Data Portability ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 max-w-7xl">
					<h2 className="text-3xl font-bold text-center mb-4">Both believe in creator ownership</h2>
					<p className="text-center text-base-content/60 max-w-2xl mx-auto mb-12">
						Ghost and Anthers share a core belief: creators should own their work, their audience,
						and their data. They just approach it differently.
					</p>

					<div className="grid grid-cols-1 md:grid-cols-3 gap-8">
						<div className="text-center">
							<div className="w-12 h-12 rounded-full bg-info/15 flex items-center justify-center mx-auto mb-3">
								<LockOpenIcon className="w-6 h-6 text-info" />
							</div>
							<h3 className="font-semibold mb-1">Ghost: open source</h3>
							<p className="text-sm text-base-content/60">
								Ghost publishes its entire codebase under the MIT license. You can self-host,
								modify, and run your own instance. Your data lives on your server.
							</p>
						</div>
						<div className="text-center">
							<div className="w-12 h-12 rounded-full bg-info/15 flex items-center justify-center mx-auto mb-3">
								<ArrowPathIcon className="w-6 h-6 text-info" />
							</div>
							<h3 className="font-semibold mb-1">Anthers: open protocol</h3>
							<p className="text-sm text-base-content/60">
								Anthers builds on the AT Protocol. Your identity is a portable DID. Your content is
								interoperable. Federation means no single point of control.
							</p>
						</div>
						<div className="text-center">
							<div className="w-12 h-12 rounded-full bg-info/15 flex items-center justify-center mx-auto mb-3">
								<GlobeAltIcon className="w-6 h-6 text-info" />
							</div>
							<h3 className="font-semibold mb-1">Same goal</h3>
							<p className="text-sm text-base-content/60">
								Both reject the model where platforms own your audience and take a cut of your
								revenue. Different architectures, same creator-first mission.
							</p>
						</div>
					</div>
				</div>
			</section>

			{/* ───────────── CTA ───────────── */}
			<section className="py-20">
				<div className="container mx-auto px-4 text-center max-w-2xl">
					<h2 className="text-3xl font-bold mb-4">Ready to publish your creative work?</h2>
					<p className="text-base-content/60 mb-8 leading-relaxed">
						If you're a writer or journalist, Ghost is an excellent choice. If you make games,
						videos, music, or multimedia creative work — Anthers was built for you. Free to use,
						100% to creators.
					</p>
					<div className="flex gap-4 justify-center flex-wrap">
						<Link
							to={isAuthenticated ? "/dashboard" : "/signup"}
							className="btn btn-primary btn-lg"
						>
							Create Your Account
						</Link>
						<Link to="/for-creators" className="btn btn-outline btn-lg">
							Learn More
						</Link>
					</div>
				</div>
			</section>
		</div>
	);
}

// ─── Sub-components ───

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
			<div className="flex-shrink-0 w-10 h-10 rounded-lg bg-base-100 flex items-center justify-center text-primary">
				{icon}
			</div>
			<div>
				<h3 className="font-semibold mb-1">{title}</h3>
				<p className="text-sm text-base-content/60 leading-relaxed">{description}</p>
			</div>
		</div>
	);
}

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
		<div className="card bg-base-200">
			<div className="card-body p-5 text-center">
				<div className="text-base-content/40 mx-auto mb-2">{icon}</div>
				<span className={`badge badge-sm ${color} mx-auto mb-2`}>{title}</span>
				<div className="text-xs text-base-content/50 flex flex-col gap-1">
					{anthers && (
						<span>
							<span className="text-success">✓</span> Anthers
						</span>
					)}
					{ghost && (
						<span>
							<span className="text-success">✓</span> Ghost
						</span>
					)}
					{!ghost && (
						<span>
							<span className="text-base-content/20">—</span> Ghost
						</span>
					)}
				</div>
			</div>
		</div>
	);
}

function CompRow({
	feature,
	anthers,
	ghost,
}: {
	feature: string;
	anthers?: boolean;
	ghost?: boolean;
}) {
	const check = <span className="text-success font-bold">✓</span>;
	const dash = <span className="text-base-content/20">—</span>;
	return (
		<tr>
			<td>{feature}</td>
			<td className="text-center">{anthers ? check : dash}</td>
			<td className="text-center">{ghost ? check : dash}</td>
		</tr>
	);
}
