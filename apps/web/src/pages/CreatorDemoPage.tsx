// SPDX-License-Identifier: AGPL-3.0-or-later
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Lede } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { LinkIcon, MapPinIcon, MusicalNoteIcon, StarIcon } from "@heroicons/react/24/outline";
import { PlayIcon as PlaySolid, StarIcon as StarSolid } from "@heroicons/react/24/solid";
import { useState } from "react";
import { Link } from "react-router-dom";

const serif = { fontFamily: FONTS.fraunces };

// ---------------------------------------------------------------------------
// Types for fake data
// ---------------------------------------------------------------------------

interface DemoProject {
	title: string;
	cover?: string;
	emoji: string;
	description: string;
	price: string;
	rating: number;
	ratingCount: number;
}

interface DemoPost {
	title: string;
	type: "video" | "audio" | "text";
	duration?: string;
	date: string;
	premium?: boolean;
	readMin?: number;
}

interface DemoCreator {
	id: string;
	label: string;
	tagline: string;
	displayName: string;
	username: string;
	avatar: string;
	bio: string;
	followers: number;
	website: string;
	location: string;
	projects: DemoProject[];
	posts: DemoPost[];
	style: CreatorStyle;
}

interface CreatorStyle {
	/** CSS gradient for the banner */
	banner: string;
	/** Accent color class (tailwind) */
	accent: string;
	/** Card bg override */
	cardBg: string;
	/** Badge variant */
	badgeClass: string;
	/** Layout: "grid" | "list" | "masonry" */
	layout: "grid" | "list" | "magazine";
	/** Whether to show a featured/pinned hero section */
	heroProject?: boolean;
	/** Custom font feel via tailwind */
	headingClass: string;
}

// ---------------------------------------------------------------------------
// Demo data—three very different creators
// ---------------------------------------------------------------------------

const DEMO_CREATORS: DemoCreator[] = [
	{
		id: "nova",
		label: "Indie Game Dev",
		tagline: "Colorful grid layout with bold headings",
		displayName: "Nova Pixel",
		username: "novapixel",
		avatar: "NP",
		bio: "Solo indie dev crafting pixel-art worlds and lo-fi soundtracks. Currently building Moonvale—a farming sim meets dungeon crawler. I release devlogs every Friday and all my OSTs are free to stream.",
		followers: 2_841,
		website: "novapixel.dev",
		location: "Portland, OR",
		projects: [
			{
				title: "Moonvale",
				emoji: "🌙",
				description: "Farm by day, explore dungeons by night.",
				price: "$12.99",
				rating: 4.7,
				ratingCount: 312,
			},
			{
				title: "Chroma Dash",
				emoji: "🎨",
				description: "Speed-run platformer with color-shifting mechanics.",
				price: "Free",
				rating: 4.3,
				ratingCount: 1_045,
			},
			{
				title: "Bit Dungeon OST",
				emoji: "🎵",
				description: "24-track lo-fi chiptune album.",
				price: "Pay what you want",
				rating: 4.9,
				ratingCount: 89,
			},
			{
				title: "Starlit Caves",
				emoji: "⭐",
				description: "A short puzzle game about bioluminescent ecosystems.",
				price: "Free",
				rating: 4.1,
				ratingCount: 204,
			},
		],
		posts: [
			{
				title: "Moonvale Devlog #47—The Fishing Update",
				type: "video",
				duration: "14:32",
				date: "Feb 21, 2026",
			},
			{
				title: 'OST Preview: "Lantern Fields"',
				type: "audio",
				duration: "3:44",
				date: "Feb 18, 2026",
			},
			{ title: "How I Design Pixel Art Tilesets", type: "text", date: "Feb 14, 2026", readMin: 8 },
			{
				title: "Moonvale Devlog #46—NPC Dialogue Trees",
				type: "video",
				duration: "11:07",
				date: "Feb 7, 2026",
			},
		],
		style: {
			banner: "linear-gradient(135deg, #2e1065 0%, #6d28d9 50%, #8b5cf6 100%)",
			accent: "text-violet-400",
			cardBg: "bg-base-200",
			badgeClass: "badge-primary",
			layout: "grid",
			heroProject: true,
			headingClass: "font-bold tracking-tight",
		},
	},
	{
		id: "sage",
		label: "Essayist & Podcaster",
		tagline: "Magazine-style layout with muted tones",
		displayName: "Sage Moreno",
		username: "sagemoreno",
		avatar: "SM",
		bio: 'Writer, podcaster, occasional troublemaker. I write long-form essays on technology, culture, and the spaces between. My podcast "Undercurrents" explores stories that don\'t fit neatly into headlines. Paid subscribers get early access and bonus episodes.',
		followers: 11_203,
		website: "sage.ink",
		location: "Brooklyn, NY",
		projects: [
			{
				title: "Undercurrents (Podcast)",
				emoji: "🎙️",
				description: "Long-form interviews and investigations.",
				price: "Free + Premium",
				rating: 4.8,
				ratingCount: 734,
			},
		],
		posts: [
			{
				title: "The Myth of the Neutral Platform",
				type: "text",
				date: "Feb 24, 2026",
				readMin: 14,
			},
			{
				title: 'Undercurrents Ep. 89—"Who Owns Your Feed?"',
				type: "audio",
				duration: "52:18",
				date: "Feb 20, 2026",
				premium: true,
			},
			{
				title: "Why I Left Substack (And What Comes Next)",
				type: "text",
				date: "Feb 16, 2026",
				readMin: 11,
			},
			{
				title: 'Undercurrents Ep. 88—"Digital Homesteading"',
				type: "audio",
				duration: "47:03",
				date: "Feb 13, 2026",
			},
			{
				title: "Five Books That Changed How I Think About the Internet",
				type: "text",
				date: "Feb 9, 2026",
				readMin: 9,
			},
			{
				title: "Video Essay: The Architecture of Trust",
				type: "video",
				duration: "23:41",
				date: "Feb 5, 2026",
				premium: true,
			},
		],
		style: {
			banner: "linear-gradient(160deg, #1c1917 0%, #292524 40%, #44403c 100%)",
			accent: "text-amber-400",
			cardBg: "bg-stone-800/50",
			badgeClass: "badge-warning",
			layout: "magazine",
			headingClass: "font-serif font-semibold tracking-normal",
		},
	},
	{
		id: "flux",
		label: "Music Producer & VJ",
		tagline: "List-style feed with neon accents",
		displayName: "FLUX",
		username: "fluxbeats",
		avatar: "FX",
		bio: "Electronic music producer, visual artist, live VJ. Releasing tracks, visuals, and the occasional interactive audio toy. Everything here is available under Creative Commons unless noted otherwise.",
		followers: 6_580,
		website: "fluxbeats.live",
		location: "Berlin, DE",
		projects: [
			{
				title: "Synthwave Toolkit",
				emoji: "🎹",
				description: "Browser-based synth with presets and recording.",
				price: "Free",
				rating: 4.5,
				ratingCount: 421,
			},
			{
				title: "Visualizer Pack Vol. 3",
				emoji: "🌈",
				description: "Reactive WebGL visuals for live sets.",
				price: "$4.99",
				rating: 4.6,
				ratingCount: 158,
			},
		],
		posts: [
			{ title: 'New Track: "Cascade"', type: "audio", duration: "4:22", date: "Feb 23, 2026" },
			{
				title: "Live Set @ Tresor Berlin (Full Recording)",
				type: "video",
				duration: "1:42:07",
				date: "Feb 19, 2026",
			},
			{ title: 'New Track: "Phase Drift"', type: "audio", duration: "5:01", date: "Feb 15, 2026" },
			{
				title: "How I Build Reactive Visuals with Three.js",
				type: "text",
				date: "Feb 11, 2026",
				readMin: 12,
			},
			{
				title: 'Remix Contest: Submit Your Take on "Neon Rain"',
				type: "text",
				date: "Feb 8, 2026",
				readMin: 3,
			},
		],
		style: {
			banner: "linear-gradient(135deg, #042f2e 0%, #0f766e 40%, #14b8a6 100%)",
			accent: "text-teal-400",
			cardBg: "bg-teal-950/40",
			badgeClass: "badge-secondary",
			layout: "list",
			headingClass: "font-mono font-bold uppercase tracking-widest",
		},
	},
];

// ---------------------------------------------------------------------------
// Sub-components for the demo profile renderings
// ---------------------------------------------------------------------------

function DemoStarRating({ rating, count }: { rating: number; count: number }) {
	return (
		<span className="flex items-center gap-1 text-xs text-base-content/50">
			{[1, 2, 3, 4, 5].map((i) => (
				<span key={i}>
					{i <= Math.round(rating) ? (
						<StarSolid className="w-3 h-3 text-warning" />
					) : (
						<StarIcon className="w-3 h-3" />
					)}
				</span>
			))}
			<span className="ml-0.5">({count})</span>
		</span>
	);
}

function ProjectTile({ project, style }: { project: DemoProject; style: CreatorStyle }) {
	return (
		<div className={`card ${style.cardBg} shadow-sm cursor-default`}>
			<div className="h-36 bg-base-300/50 flex items-center justify-center text-4xl">
				{project.emoji}
			</div>
			<div className="card-body p-4 gap-2">
				<h3 className="card-title text-base line-clamp-1">{project.title}</h3>
				<p className="text-sm text-base-content/70 line-clamp-2">{project.description}</p>
				<div className="flex items-center justify-between mt-auto pt-2">
					<span className={`badge badge-sm ${style.badgeClass}`}>{project.price}</span>
					<DemoStarRating rating={project.rating} count={project.ratingCount} />
				</div>
			</div>
		</div>
	);
}

function PostRow({ post, style }: { post: DemoPost; style: CreatorStyle }) {
	return (
		<div className={`flex items-center gap-4 p-3 rounded-lg ${style.cardBg} cursor-default`}>
			{/* Icon */}
			<div className="flex-shrink-0 w-10 h-10 rounded-lg bg-base-300/50 flex items-center justify-center">
				{post.type === "video" && <PlaySolid className="w-5 h-5 text-base-content/40" />}
				{post.type === "audio" && <MusicalNoteIcon className="w-5 h-5 text-base-content/40" />}
				{post.type === "text" && <span className="text-sm text-base-content/40">Aa</span>}
			</div>
			{/* Info */}
			<div className="flex-1 min-w-0">
				<p className="text-sm font-medium line-clamp-1">{post.title}</p>
				<p className="text-xs text-base-content/50">{post.date}</p>
			</div>
			{/* Meta */}
			<div className="flex items-center gap-2 flex-shrink-0">
				{post.premium && <span className="badge badge-xs badge-secondary">Premium</span>}
				{post.duration && <span className="text-xs text-base-content/40">{post.duration}</span>}
				{post.readMin && <span className="text-xs text-base-content/40">{post.readMin} min</span>}
			</div>
		</div>
	);
}

function PostCard({ post, style }: { post: DemoPost; style: CreatorStyle }) {
	return (
		<div className={`card ${style.cardBg} shadow-sm cursor-default overflow-hidden`}>
			{post.type === "video" && (
				<div className="relative aspect-video bg-base-300/50">
					<div className="absolute inset-0 flex items-center justify-center">
						<div className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center">
							<PlaySolid className="w-6 h-6 text-base-content/40 ml-0.5" />
						</div>
					</div>
					{post.duration && (
						<span className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded">
							{post.duration}
						</span>
					)}
				</div>
			)}
			{post.type === "audio" && (
				<div className="relative h-20 bg-gradient-to-br from-secondary/20 to-primary/20">
					<div className="absolute inset-0 flex items-center justify-center">
						<MusicalNoteIcon className="w-8 h-8 text-base-content/20" />
					</div>
					{post.duration && (
						<span className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded">
							{post.duration}
						</span>
					)}
				</div>
			)}
			<div className="card-body p-4 gap-2">
				<h4 className="font-semibold text-sm line-clamp-2">{post.title}</h4>
				<div className="flex items-center gap-2 mt-auto">
					<span className="text-xs text-base-content/50">{post.date}</span>
					{post.premium && <span className="badge badge-xs badge-secondary">Premium</span>}
					{post.readMin && (
						<span className="text-xs text-base-content/40">{post.readMin} min read</span>
					)}
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Magazine layout—featured article + sidebar
// ---------------------------------------------------------------------------

function MagazineLayout({ creator }: { creator: DemoCreator }) {
	const { style, posts, projects } = creator;
	const featured = posts[0];
	const rest = posts.slice(1);

	return (
		<div className="space-y-6">
			{/* Featured piece */}
			{featured && (
				<div className={`rounded-xl ${style.cardBg} p-6 cursor-default`}>
					<span className={`badge badge-sm ${style.badgeClass} mb-3`}>Featured</span>
					<h3 className={`text-xl ${style.headingClass} mb-2`}>{featured.title}</h3>
					<p className="text-sm text-base-content/60">
						{featured.date}
						{featured.readMin && ` · ${featured.readMin} min read`}
						{featured.duration && ` · ${featured.duration}`}
					</p>
					<p className="mt-3 text-sm text-base-content/70 leading-relaxed">
						A preview excerpt would appear here, drawing the reader in with the opening lines of the
						piece...
					</p>
				</div>
			)}

			<div className="grid grid-cols-1 md:grid-cols-3 gap-6">
				{/* Post stream */}
				<div className="md:col-span-2 space-y-3">
					<h4 className={`text-sm uppercase tracking-wider text-base-content/40 mb-2`}>Recent</h4>
					{rest.map((post, i) => (
						<PostRow key={i} post={post} style={style} />
					))}
				</div>

				{/* Sidebar—projects */}
				<div>
					<h4 className="text-sm uppercase tracking-wider text-base-content/40 mb-2">Projects</h4>
					<div className="space-y-3">
						{projects.map((proj, i) => (
							<div key={i} className={`rounded-lg ${style.cardBg} p-3 cursor-default`}>
								<div className="flex items-center gap-2">
									<span className="text-lg">{proj.emoji}</span>
									<div>
										<p className="text-sm font-medium">{proj.title}</p>
										<p className="text-xs text-base-content/50">{proj.price}</p>
									</div>
								</div>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Grid layout—projects hero + post cards
// ---------------------------------------------------------------------------

function GridLayout({ creator }: { creator: DemoCreator }) {
	const { style, projects, posts } = creator;
	const heroProj = style.heroProject ? projects[0] : null;
	const otherProjects = style.heroProject ? projects.slice(1) : projects;

	return (
		<div className="space-y-6">
			{/* Hero project */}
			{heroProj && (
				<div className={`rounded-xl ${style.cardBg} overflow-hidden cursor-default`}>
					<div className="flex flex-col sm:flex-row">
						<div className="sm:w-1/2 h-48 sm:h-auto bg-base-300/50 flex items-center justify-center text-6xl">
							{heroProj.emoji}
						</div>
						<div className="p-6 flex flex-col justify-center">
							<span className={`badge badge-sm ${style.badgeClass} w-fit mb-2`}>Featured</span>
							<h3 className={`text-2xl ${style.headingClass} mb-1`}>{heroProj.title}</h3>
							<p className="text-sm text-base-content/70 mb-3">{heroProj.description}</p>
							<div className="flex items-center gap-3">
								<span className="btn btn-primary btn-sm pointer-events-none">{heroProj.price}</span>
								<DemoStarRating rating={heroProj.rating} count={heroProj.ratingCount} />
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Other projects */}
			{otherProjects.length > 0 && (
				<>
					<h4 className={`text-sm uppercase tracking-wider text-base-content/40`}>Projects</h4>
					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
						{otherProjects.map((proj, i) => (
							<ProjectTile key={i} project={proj} style={style} />
						))}
					</div>
				</>
			)}

			{/* Posts grid */}
			<h4 className={`text-sm uppercase tracking-wider text-base-content/40`}>Posts</h4>
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
				{posts.map((post, i) => (
					<PostCard key={i} post={post} style={style} />
				))}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// List layout—everything as a clean feed
// ---------------------------------------------------------------------------

function ListLayout({ creator }: { creator: DemoCreator }) {
	const { style, projects, posts } = creator;

	return (
		<div className="max-w-2xl mx-auto space-y-6">
			{/* Projects */}
			<h4 className={`text-sm uppercase tracking-wider text-base-content/40`}>Projects</h4>
			<div className="space-y-3">
				{projects.map((proj, i) => (
					<div
						key={i}
						className={`flex items-center gap-4 p-4 rounded-lg ${style.cardBg} cursor-default`}
					>
						<span className="text-3xl">{proj.emoji}</span>
						<div className="flex-1 min-w-0">
							<p className={`font-medium ${style.headingClass} text-base`}>{proj.title}</p>
							<p className="text-sm text-base-content/60 line-clamp-1">{proj.description}</p>
						</div>
						<div className="text-right flex-shrink-0">
							<span className={`badge badge-sm ${style.badgeClass}`}>{proj.price}</span>
							<div className="mt-1">
								<DemoStarRating rating={proj.rating} count={proj.ratingCount} />
							</div>
						</div>
					</div>
				))}
			</div>

			{/* Posts */}
			<h4 className={`text-sm uppercase tracking-wider text-base-content/40`}>Feed</h4>
			<div className="space-y-2">
				{posts.map((post, i) => (
					<PostRow key={i} post={post} style={style} />
				))}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Profile header (reused across all demos)
// ---------------------------------------------------------------------------

function DemoProfileHeader({ creator }: { creator: DemoCreator }) {
	const { style } = creator;

	return (
		<>
			{/* Banner */}
			<div className="w-full h-40 md:h-52" style={{ background: style.banner }} />
			{/* Profile info */}
			<div className="px-4 sm:px-6">
				<div className="flex flex-col sm:flex-row items-start gap-4 -mt-10 mb-6">
					<div
						className={`w-20 h-20 rounded-full border-4 border-base-100 flex items-center justify-center text-2xl font-bold ${style.accent} bg-base-300`}
					>
						{creator.avatar}
					</div>
					<div className="flex-1 pt-2">
						<h2 className={`text-xl ${style.headingClass}`}>{creator.displayName}</h2>
						<p className="text-base-content/60 text-sm">
							@{creator.username} · {creator.followers.toLocaleString()} followers
						</p>
						<p className="mt-1 text-sm text-base-content/80 max-w-xl">{creator.bio}</p>
						<div className="flex items-center gap-4 mt-2 text-xs text-base-content/50">
							<span className="flex items-center gap-1">
								<LinkIcon className="w-3.5 h-3.5" />
								{creator.website}
							</span>
							<span className="flex items-center gap-1">
								<MapPinIcon className="w-3.5 h-3.5" />
								{creator.location}
							</span>
						</div>
					</div>
					<button type="button" className="btn btn-primary btn-sm mt-2 sm:mt-8 pointer-events-none">
						Follow
					</button>
				</div>
			</div>
		</>
	);
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function CreatorDemoPage() {
	const [activeId, setActiveId] = useState(DEMO_CREATORS[0].id);
	const active = DEMO_CREATORS.find((c) => c.id === activeId)!;

	return (
		<div className="pb-16">
			{/* Hero intro */}
			<header className="bg-base-200/70">
				<div className="mx-auto max-w-4xl px-6 pt-20 pb-16 text-center">
					<Sprig className="mx-auto mb-5 h-11 w-11 text-primary/60" />
					<p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
						Creator Hubs
					</p>
					<h1
						style={serif}
						className="text-balance text-5xl font-light leading-[1.05] tracking-tight sm:text-7xl"
					>
						Your page.
						<br />
						<em className="font-medium text-primary not-italic">Your style.</em>
					</h1>
					<Lede>
						Every creator on Anthers gets a customizable anther—not a cookie-cutter profile. Choose
						your layout, colors, and typography. Pin featured work. Organize your content your way.
						Below are three examples of what's possible.
					</Lede>
					<BrandGlyph name="divider-botanical" className="mt-10 h-14 w-52 text-primary/45" />
				</div>
			</header>

			{/* Demo frame */}
			<div className="max-w-7xl mx-auto px-4">
				{/* Tab bar */}
				<div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-4">
					{DEMO_CREATORS.map((c) => (
						<button
							type="button"
							key={c.id}
							onClick={() => setActiveId(c.id)}
							className={`
								flex-1 text-left px-4 py-3 rounded-lg border transition-all
								${
									activeId === c.id
										? "border-primary bg-primary/10 shadow-sm"
										: "border-base-300 bg-base-200/50 hover:border-base-content/20"
								}
							`}
						>
							<p className={`text-sm font-semibold ${activeId === c.id ? "text-primary" : ""}`}>
								{c.displayName}
							</p>
							<p className="text-xs text-base-content/50">
								{c.label}—{c.tagline}
							</p>
						</button>
					))}
				</div>

				{/* Browser chrome frame */}
				<div className="rounded-xl border border-base-300 overflow-hidden bg-base-100 shadow-lg">
					{/* Fake address bar */}
					<div className="flex items-center gap-2 px-4 py-2 bg-base-200 border-b border-base-300">
						<div className="flex gap-1.5">
							<span className="w-3 h-3 rounded-full bg-error/60" />
							<span className="w-3 h-3 rounded-full bg-warning/60" />
							<span className="w-3 h-3 rounded-full bg-success/60" />
						</div>
						<div className="flex-1 mx-3">
							<div className="bg-base-300 rounded-md px-3 py-1 text-xs text-base-content/40 font-mono">
								anthers.org/{active.username}
							</div>
						</div>
					</div>

					{/* Page content */}
					<div className="min-h-[600px]">
						<DemoProfileHeader creator={active} />

						<div className="px-4 sm:px-6 pb-8">
							{active.style.layout === "grid" && <GridLayout creator={active} />}
							{active.style.layout === "magazine" && <MagazineLayout creator={active} />}
							{active.style.layout === "list" && <ListLayout creator={active} />}
						</div>
					</div>
				</div>

				{/* Customization callout */}
				<div className="mt-8 text-center">
					<p className="text-base-content/50 text-sm mb-4">
						Layouts, color palettes, typography, pinned content, and more—all customizable by the
						creator.
					</p>
					<Link to="/for-creators" className="btn btn-primary rounded-full px-7">
						Learn more about Creator Hubs
					</Link>
				</div>
			</div>
		</div>
	);
}
