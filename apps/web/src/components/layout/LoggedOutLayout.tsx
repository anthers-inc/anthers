// SPDX-License-Identifier: AGPL-3.0-or-later
import { MeadowFloor } from "@anthers/web-shared/decor/MeadowFloor";
import { MeadowVines } from "@anthers/web-shared/decor/MeadowVines";
import { FONTS } from "@anthers/web-shared/fonts";
import { Link, Outlet } from "@anthers/web-shared/router";
import Logo from "@anthers/web-shared/ui/Logo";
import ThemeToggle from "@anthers/web-shared/ui/ThemeToggle";
import { Bars3Icon, GlobeAltIcon } from "@heroicons/react/24/outline";
import { useEffect } from "react";
import { useMediaPlayer } from "../../lib/media-player";
import PlayerBar from "../media/PlayerBar";
import RouteSuspense from "./RouteSuspense";

const serif = { fontFamily: FONTS.fraunces };

// Localization isn't implemented yet, so the header's language picker is hidden for now.
// Flip this to true (and wire up the picker's buttons) once localization actually ships.
const LOCALIZATION_ENABLED = false;

// The Meadow footer nav — mirrors the header, plus a Support column. label → href.
const FOOTER_NAV: { title: string; links: [string, string][] }[] = [
	{
		title: "Creators",
		links: [
			["For Creators", "/for-creators"],
			["Creator Hubs", "/demo-creator-page"],
			["Creator Economics", "/demo-creator-breakdown"],
		],
	},
	{
		// Named for the two acts, matching the header. The single link here read
		// "Subscribe" until 2026-08-17, which named the URL rather than the thing.
		title: "Users",
		links: [
			["Sign Up Free", "/subscribe"],
			["Log In", "/login"],
		],
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
		],
	},
	{
		title: "About",
		links: [
			["About Us", "/about"],
			["Roadmap", "/roadmap"],
		],
	},
	{
		title: "Legal",
		links: [
			["Privacy", "/privacy"],
			["Terms", "/terms"],
			["Copyright", "/copyright"],
			["Safety", "/safety"],
			["For Parents", "/parents"],
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
			<header className="py-1 nav-edge bg-base-200/50 backdrop-blur-md sticky top-0 z-40">
				{/* Theme + language utilities, floated into the page's top-right corner —
					deliberately outside the centered nav. Desktop only; on mobile the theme
					toggle drops into the hamburger menu below. */}
				<div className="absolute inset-y-0 right-0 z-10 hidden items-center gap-1 pr-8 lg:flex">
					{/* Language picker — hidden until localization is actually implemented
						(the menu is inert). Gated by LOCALIZATION_ENABLED, not deleted, so it
						can be restored by flipping the flag once localization ships. */}
					{LOCALIZATION_ENABLED && (
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
					)}
					<ThemeToggle />
				</div>

				{/* Main nav — brand on the left, page links centered, a single CTA on the
					right. The mirrored flex-1 side clusters keep the links dead-center. */}
				<div className="navbar mx-auto w-full max-w-6xl px-4">
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
									<Link to="/resources">Resources</Link>
								</li>
								<li>
									<Link to="/about">About Us</Link>
								</li>
								{/* Log In lives here as well as in the corner, because the corner button is
								    hidden below `sm` — two buttons plus the hamburger and the wordmark do
								    not fit a 390px navbar. Sign Up Free keeps the corner at every width. */}
								<li className="sm:hidden">
									<Link to="/login">Log In</Link>
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
						<Link to="/" className="btn btn-ghost px-2">
							<Logo variant="oneline" className="h-8 sm:h-10 lg:h-15" />
						</Link>
					</div>

					{/* Center: page links.
					    "Subscribe" (→ /subscribe) sat between For Creators and Resources until
					    2026-08-17 and came out with this change, not on its own merits: the
					    corner CTA now points at the same page under a clearer name, and a nav
					    link and a button side by side going to one destination under two labels
					    is a question for the reader with no useful answer. */}
					<ul className="translate-y-0.5 scale-105 menu menu-horizontal hidden gap-8 lg:flex">
						<li>
							<Link to="/">For Users</Link>
						</li>
						<li>
							<Link to="/for-creators">For Creators</Link>
						</li>
						<li>
							<Link to="/resources">Resources</Link>
						</li>
						<li>
							<Link to="/about">About Us</Link>
						</li>
					</ul>

					{/* Right: the two doors, named for what they are. Log In is quiet (ghost) and
						Sign Up Free carries the primary glow, so the pair reads as one CTA with an
						escape hatch beside it rather than as two competing buttons. flex-1 +
						justify-end mirror the brand side so the center links stay centered.

						⚠️ This was ONE button reading "Start Exploring", pointing at /signup — the
						four-field Create Account card — until 2026-08-17. Two things changed
						together: that card is gone (signing up is /subscribe now, one door), and a
						returning user had no visible way in from the marketing site at all, since
						"Start Exploring" said nothing about logging in and the only /login links
						lived inside gated-content modals. Naming the two acts is what makes the
						contrast legible; "Start Exploring" named neither.

						🚨 **"Sign Up Free", and the word is doing real work** (2026-08-22). The
						button leads to `/subscribe`, a page that also asks about supporting a
						creator and supporting Anthers — so a bare "Sign Up" invites the reader to
						assume the door has a price on it. It does not: an email address is the
						whole of it. The claim is safe to make outright because the free tier is
						free forever by charter rather than by pricing decision (63.01), and the
						page it lands on states the monthly Public Access limit in the same breath.

						⚠️ Sign Up Free now sits FIRST, with Log In to its right. Reading order and
						visual weight agree this way — the primary act comes first — where before
						the eye met the quiet button on its way to the loud one. */}
					<div className="flex flex-1 items-center justify-end gap-1 sm:gap-2">
						<Link
							to="/subscribe"
							className="scale-95 btn btn-primary rounded-lg px-7 shadow-[0_0_10px_color-mix(in_oklch,var(--color-primary)_50%,transparent)] transition-shadow hover:shadow-[0_0_16px_color-mix(in_oklch,var(--color-primary)_65%,transparent)]"
						>
							Sign Up Free
						</Link>
						{/* Hidden below `sm` — it is in the mobile menu instead, because two buttons
						    beside the hamburger and the wordmark overflow a 390px navbar. */}
						<Link
							to="/login"
							className="scale-95 btn btn-ghost hidden rounded-lg px-4 sm:inline-flex"
						>
							Log In
						</Link>
					</div>
				</div>
			</header>

			{/* flex-col so a page can opt into filling the content area (e.g. AuthPage
				grows a flex-1 child to vertically center its card between header and
				footer). Ordinary pages render a single non-growing child, so it stacks
				from the top exactly as a block child would. `min-w-0` lets those
				flex-column children shrink below their min-content size, so wide inner
				grids/tables (calculators, roadmaps) can't blow the page wider than the
				viewport on mobile — without it, a flex item's default min-width:auto
				keeps it at its content's min-content width. */}
			<main className={`relative z-10 flex min-w-0 flex-1 flex-col ${currentTrack ? "pb-16" : ""}`}>
				<RouteSuspense>
					<Outlet />
				</RouteSuspense>
			</main>

			<PlayerBar />

			{/* Meadow footer — transparent (no bg overlay), compact, sitting right atop
				the grassy floor below it. z-10 keeps it behind the side vines (z-20). */}
			<footer
				className={`relative z-10 border-t border-base-content/10 px-6 pt-9 pb-2 text-sm ${currentTrack ? "mb-16" : ""}`}
			>
				<div className="mx-auto max-w-6xl">
					<div className="mb-8 flex flex-col items-center text-center">
						<Logo className="h-24 -translate-x-4" />
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
						© 2026 Anthers, Inc. · growing a creative garden for free, forever
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
