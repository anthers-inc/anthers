// SPDX-License-Identifier: AGPL-3.0-or-later
import { MeadowFloor } from "@anthers/web-shared/decor/MeadowFloor";
import { MeadowVines } from "@anthers/web-shared/decor/MeadowVines";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link, Outlet } from "@anthers/web-shared/router";
import ThemeToggle from "@anthers/web-shared/ui/ThemeToggle";
import { Bars3Icon, GlobeAltIcon } from "@heroicons/react/24/outline";
import { useEffect } from "react";
import { useMediaPlayer } from "../../lib/media-player";
import MiniPlayer from "../media/MiniPlayer";

const serif = { fontFamily: FONTS.fraunces };

// The Meadow footer nav — mirrors the header, plus a Support column. label → href.
const FOOTER_NAV: { title: string; links: [string, string][] }[] = [
	{
		title: "Explore",
		links: [["Jams", "/jams"]],
	},
	{
		title: "Creators",
		links: [
			["For Creators", "/for-creators"],
			["Creator Hubs", "/demo-creator-page"],
			["Creator Economics", "/demo-creator-breakdown"],
		],
	},
	{
		title: "Users",
		links: [["Subscribe", "/subscribe"]],
	},
	{
		title: "Compare",
		links: [
			["Anthers vs itch.io", "/compare/itch-io"],
			["Anthers vs Ghost", "/compare/ghost"],
		],
	},
	{
		title: "Support",
		links: [
			["FAQ", "/faq"],
			["Resources", "/resources"],
			["Wiki", "/wiki"],
		],
	},
	{
		title: "About",
		links: [
			["About Us", "/about"],
			["Roadmap", "/roadmap"],
		],
	},
];

export default function LoggedOutLayout() {
	const { currentTrack } = useMediaPlayer();

	// The marketing surface scrolls the document, so reserve the scrollbar gutter
	// while this shell is mounted — pages that scroll and pages that don't then stay
	// the same width (no left/right shift on navigation). Scoped to this shell so the
	// inner-scrolling app shell / Studio don't get an empty gutter strip. See theme.css.
	useEffect(() => {
		const root = document.documentElement;
		root.classList.add("gutter-stable");
		return () => root.classList.remove("gutter-stable");
	}, []);

	return (
		// `relative isolate` scopes the decor z-order: content + footer (z-10) sit
		// below the side vines (z-20), which sit below the grassy floor (z-30). The
		// sticky nav stays on top (z-40).
		<div className="relative isolate min-h-screen flex flex-col">
			<header className="nav-edge bg-base-200/50 backdrop-blur-md sticky top-0 z-40">
				{/* Theme + language utilities, floated into the page's top-right corner —
					deliberately outside the centered nav. Desktop only; on mobile the theme
					toggle drops into the hamburger menu below. */}
				<div className="absolute inset-y-0 right-0 z-10 hidden items-center gap-1 pr-6 lg:flex">
					{/* Language picker — localization is a TODO; the menu is inert for now. */}
					<div className="dropdown dropdown-end">
						<label
							tabIndex={0}
							className="btn btn-ghost btn-sm btn-circle"
							aria-label="Select language"
							title="Select language"
						>
							<GlobeAltIcon className="w-5 h-5" />
						</label>
						<ul
							tabIndex={0}
							className="menu menu-sm dropdown-content mt-3 z-50 w-36 p-2 shadow bg-base-200 rounded-box"
						>
							<li>
								<button type="button">English</button>
							</li>
							<li>
								<button type="button">Español</button>
							</li>
						</ul>
					</div>
					<ThemeToggle />
				</div>

				{/* Main nav — brand on the left, page links centered, a single CTA on the
					right. The mirrored flex-1 side clusters keep the links dead-center. */}
				<div className="navbar mx-auto w-full max-w-5xl px-4">
					{/* Left: brand (+ mobile menu) */}
					<div className="flex flex-1 items-center gap-1">
						{/* Mobile menu */}
						<div className="dropdown lg:hidden">
							<label tabIndex={0} className="btn btn-ghost">
								<Bars3Icon className="w-5 h-5" />
							</label>
							<ul
								tabIndex={0}
								className="menu menu-sm dropdown-content mt-3 z-50 p-2 shadow bg-base-200 rounded-box w-52"
							>
								<li>
									<Link to="/">For Users</Link>
								</li>
								<li>
									<Link to="/for-creators">For Creators</Link>
								</li>
								<li>
									<Link to="/subscribe">Subscribe</Link>
								</li>
								<li>
									<Link to="/resources">Resources</Link>
								</li>
								<li>
									<Link to="/about">About Us</Link>
								</li>
								{/* Theme toggle for mobile (the corner utilities are desktop-only) */}
								<li className="mt-1 border-t border-base-content/10 pt-1">
									<div className="flex items-center justify-between">
										<span className="text-base-content/70">Theme</span>
										<ThemeToggle />
									</div>
								</li>
							</ul>
						</div>

						{/* Brand — links to the homepage (the For Users link does too, intentionally) */}
						<Link to="/" className="btn btn-ghost text-lg font-bold px-2">
							Anthers
						</Link>
					</div>

					{/* Center: page links */}
					<ul className="menu menu-horizontal hidden gap-1 px-1 lg:flex">
						<li>
							<Link to="/">For Users</Link>
						</li>
						<li>
							<Link to="/for-creators">For Creators</Link>
						</li>
						<li>
							<Link to="/subscribe">Subscribe</Link>
						</li>
						<li>
							<Link to="/resources">Resources</Link>
						</li>
						<li>
							<Link to="/about">About Us</Link>
						</li>
					</ul>

					{/* Right: single CTA — opens the combined auth page on its signup card
						(/signup deep-links into signup mode). A soft primary-green glow makes it
						stand out; text-sm matches the nav links so it isn't overshadowed. flex-1
						+ justify-end mirror the brand side so the center links stay centered. */}
					<div className="flex flex-1 items-center justify-end">
						<Link
							to="/signup"
							className="btn btn-primary btn-sm text-sm shadow-[0_0_10px_color-mix(in_oklch,var(--color-primary)_50%,transparent)] transition-shadow hover:shadow-[0_0_16px_color-mix(in_oklch,var(--color-primary)_65%,transparent)]"
						>
							Start Exploring
						</Link>
					</div>
				</div>
			</header>

			{/* flex-col so a page can opt into filling the content area (e.g. AuthPage
				grows a flex-1 child to vertically center its card between header and
				footer). Ordinary pages render a single non-growing child, so it stacks
				from the top exactly as a block child would. */}
			<main className={`relative z-10 flex flex-1 flex-col ${currentTrack ? "pb-16" : ""}`}>
				<Outlet />
			</main>

			<MiniPlayer />

			{/* Meadow footer — transparent (no bg overlay), compact, sitting right atop
				the grassy floor below it. z-10 keeps it behind the side vines (z-20). */}
			<footer
				className={`relative z-10 border-t border-base-content/10 px-6 pt-9 pb-2 text-sm ${currentTrack ? "mb-16" : ""}`}
			>
				<div className="mx-auto max-w-6xl">
					<div className="mb-8 flex flex-col items-center text-center">
						<p style={serif} className="text-2xl font-medium text-primary">
							Anthers
						</p>
						<p className="mt-1.5 max-w-md text-xs leading-relaxed text-base-content/55">
							A non-profit home for creative work, planted by the people who use it.
						</p>
					</div>
					<div className="grid grid-cols-2 gap-x-8 gap-y-7 sm:grid-cols-3 md:grid-cols-6">
						{FOOTER_NAV.map((col) => (
							<nav key={col.title} className="flex flex-col items-start gap-2">
								<h6
									style={serif}
									className="text-xs font-semibold uppercase tracking-wider text-base-content/50"
								>
									{col.title}
								</h6>
								{col.links.map(([label, href]) => (
									<Link
										key={label}
										to={href}
										className="text-base-content/70 transition-colors hover:text-primary"
									>
										{label}
									</Link>
								))}
							</nav>
						))}
					</div>
					<p className="mt-9 text-center text-xs text-base-content/45">
						© Anthers Foundation · Free to browse, always.
					</p>
				</div>
			</footer>

			{/* Climbing side vines spanning the whole page — in front of the content and
				footer (z-20), behind the grassy floor below (z-30). Wide screens only. */}
			<MeadowVines />

			{/* The grassy meadow every logged-out page ends on. */}
			<MeadowFloor />
		</div>
	);
}
