// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import { Link, NavLink, Outlet, useNavigate } from "@anthers/web-shared/router";
import Logo from "@anthers/web-shared/ui/Logo";
import ThemeToggle from "@anthers/web-shared/ui/ThemeToggle";
import {
	Bars3Icon,
	ChartBarSquareIcon,
	MagnifyingGlassIcon,
	RectangleStackIcon,
	RssIcon,
	Squares2X2Icon,
	UserCircleIcon,
} from "@heroicons/react/24/outline";
import { useMediaPlayer } from "../../lib/media-player";
import { studioUrl } from "../../lib/studio";
import PlayerBar from "../media/PlayerBar";
import RouteSuspense from "./RouteSuspense";
import SearchBar from "./SearchBar";
import { SidebarProvider, useSidebar } from "./SidebarContext";
import VerificationBanner from "./VerificationBanner";

/** Primary nav links that appear in the sidebar for all logged-in pages */
const NAV_LINKS = [
	{ to: "/feed", label: "Feed", icon: RssIcon },
	{ to: "/library", label: "Library", icon: RectangleStackIcon },
	{ to: "/discover", label: "Discover", icon: MagnifyingGlassIcon },
] as const;

function LoggedInLayoutInner() {
	const { user, signOut } = useAuth();
	const { currentTrack } = useMediaPlayer();
	const { sidebarOpen, toggleSidebar, pageContent } = useSidebar();
	const navigate = useNavigate();

	const handleLogout = async () => {
		await signOut();
		navigate("/");
	};

	const navLinkClass = ({ isActive }: { isActive: boolean }) =>
		`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
			isActive
				? "bg-primary/10 text-primary font-medium"
				: "text-base-content/70 hover:bg-base-300/50 hover:text-base-content"
		}`;

	return (
		<div className="h-screen flex flex-col overflow-hidden">
			{/* Top bar — simplified: brand + hamburger on left, avatar on right */}
			<header className="navbar nav-edge bg-base-200/50 backdrop-blur-md px-4 sticky top-0 z-40 h-14 min-h-0">
				<div className="navbar-start gap-1">
					<button
						type="button"
						className="btn btn-ghost btn-sm btn-square"
						onClick={toggleSidebar}
						aria-label="Toggle sidebar"
					>
						<Bars3Icon className="w-5 h-5" />
					</button>
					<Link to="/feed" className="btn btn-ghost px-2">
						<Logo variant="oneline" className="h-9" />
					</Link>
				</div>

				<div className="navbar-center flex-1 px-4 hidden sm:flex">
					<SearchBar />
				</div>

				<div className="navbar-end gap-1">
					<ThemeToggle />
					<div className="dropdown dropdown-end">
						{/* daisyUI's dropdown is CSS-only: `.dropdown-content` stays `display:none`
						    until the enclosing `.dropdown` matches `:focus-within`, so the trigger
						    has to be focusable or the menu can never open at all. This was a bare
						    `<label>` with no `tabIndex` and no control to label, which is focusable
						    by nothing — clicking the avatar did nothing from the day it shipped.
						    `tabIndex` carries a second job beyond making the button focusable:
						    daisyUI suppresses pointer events on `[tabindex]:first-child` while the
						    menu is open, and that literal attribute selector is what lets a second
						    click land on the page and dismiss it. A `<button>` would focus without
						    it and then never close. */}
						<button
							type="button"
							tabIndex={0}
							className="btn btn-ghost btn-circle"
							aria-label="Your account"
						>
							{user?.avatar ? (
								/* The button names itself above, so the image is decorative — an alt
								   here would be a second name for the same control. */
								<img src={user.avatar} alt="" className="w-8 h-8 rounded-full object-cover" />
							) : (
								<UserCircleIcon className="w-8 h-8" />
							)}
						</button>
						{/* No `tabIndex` here, deliberately. The older dropdowns in this app carry one
						    on the `<ul>`, which biome flags as `noNoninteractiveTabindex` — a list is
						    not a control and putting it in the tab order just adds a stop that does
						    nothing. It is unnecessary as well as unwanted: every item below is a link
						    or a button, so tabbing off the trigger lands on one of them and the
						    `.dropdown` keeps matching `:focus-within` on its own. */}
						<ul className="menu menu-sm dropdown-content mt-3 z-50 p-2 shadow bg-base-200 rounded-box w-52">
							<li className="menu-title px-4 py-1">
								{/* An account that hasn't finished onboarding has no handle to print and
								    no profile to link to, so the menu offers the way to get one instead
								    of a dead `@` and a link to `/null`. In practice `RequireOnboarding`
								    redirects before this renders — this is what it degrades to if that
								    guard is ever removed. */}
								<span className="text-xs text-base-content/50">
									{user?.username ? `@${user.username}` : "Finish setting up"}
								</span>
							</li>
							<div className="divider my-0 px-2" />
							<li>
								<Link to="/subscription">Subscription</Link>
							</li>
							<li>
								<Link to="/purchases">Purchases</Link>
							</li>
							<li>
								{user?.username ? (
									<Link to={`/${user.username}`}>Profile</Link>
								) : (
									<Link to="/welcome">Pick your username</Link>
								)}
							</li>
							<li>
								<Link to="/settings">Settings</Link>
							</li>
							<div className="divider my-0 px-2" />
							<li>
								<button type="button" onClick={handleLogout}>
									Log out
								</button>
							</li>
						</ul>
					</div>
				</div>
			</header>

			<VerificationBanner />

			{/* Body: sidebar + main content */}
			<div className="flex flex-1 overflow-hidden">
				{/* Persistent sidebar */}
				<aside
					className={`${sidebarOpen ? "w-64" : "w-0"} shrink-0 transition-all duration-200 overflow-hidden border-r border-base-300/50 bg-base-100`}
				>
					<div className="w-64 h-full flex flex-col overflow-y-auto">
						{/* Persistent nav section */}
						<nav className="p-3 flex flex-col gap-0.5">
							{NAV_LINKS.map((link) => (
								<NavLink key={link.to} to={link.to} className={navLinkClass}>
									<link.icon className="w-5 h-5 shrink-0" />
									{link.label}
								</NavLink>
							))}

							{/* Creator section — the Studio is the all-in-one creator management surface.
								It lived on a separate origin until 2026-08-11 and this linked out with an
								`<a>`; it is `/studio` on this origin now, so it is an ordinary NavLink and
								no longer costs a full page load. */}
							{user?.isCreator && (
								<>
									<div className="divider my-1 px-1 text-xs text-base-content/30">Creator</div>
									<NavLink to={studioUrl("/")} className={navLinkClass}>
										<Squares2X2Icon className="w-5 h-5 shrink-0" />
										Studio
									</NavLink>
								</>
							)}

							{/* Admin section — platform operators only (the ops console). */}
							{user?.isAdmin && (
								<>
									<div className="divider my-1 px-1 text-xs text-base-content/30">Admin</div>
									<NavLink to="/admin" className={navLinkClass}>
										<ChartBarSquareIcon className="w-5 h-5 shrink-0" />
										Operations
									</NavLink>
								</>
							)}
						</nav>

						{/* Page-specific sidebar content */}
						{pageContent && (
							<>
								<div className="divider my-0 mx-3" />
								<div className="flex-1 p-3 overflow-y-auto">{pageContent}</div>
							</>
						)}
					</div>
				</aside>

				{/* Main content area — reserve the scrollbar gutter so short and tall pages
					keep the same width (no content shift when the scrollbar appears).
					`min-w-0` also lets flex-column children shrink below their min-content
					size, so wide inner grids/tables can't blow the page wider than the
					viewport on mobile — the same guard LoggedOutLayout's <main> carries. */}
				<main
					className={`flex-1 min-w-0 overflow-y-auto [scrollbar-gutter:stable] ${currentTrack ? "pb-16" : ""}`}
				>
					<RouteSuspense>
						<Outlet />
					</RouteSuspense>

					{/* Footer */}
					<footer
						className={`bg-base-300/30 backdrop-blur-md text-base-content text-xs p-10 ${currentTrack ? "mb-16" : ""}`}
					>
						<div className="max-w-7xl mx-auto">
							<div className="join join-horizontal w-full">
								<nav className="join-item flex-1 flex flex-col items-center gap-1.5">
									<h6 className="footer-title text-xs">Discover</h6>
									<Link to="/discover" className="link link-hover">
										Browse Projects
									</Link>
								</nav>
								<nav className="join-item flex-1 flex flex-col items-center gap-1.5">
									<h6 className="footer-title text-xs">Your Stuff</h6>
									<Link to="/feed" className="link link-hover">
										Feed
									</Link>
									<Link to="/library" className="link link-hover">
										Library
									</Link>
									<Link to="/subscription" className="link link-hover">
										Subscription
									</Link>
								</nav>
								<nav className="join-item flex-1 flex flex-col items-center gap-1.5">
									<h6 className="footer-title text-xs">About</h6>
									<Link to="/about" className="link link-hover">
										About Us
									</Link>
									<Link to="/faq" className="link link-hover">
										FAQ
									</Link>
									<Link to="/roadmap" className="link link-hover">
										Roadmap
									</Link>
									<Link to="/resources" className="link link-hover">
										Resources
									</Link>
								</nav>
								<nav className="join-item flex-1 flex flex-col items-center gap-1.5">
									<h6 className="footer-title text-xs">Legal</h6>
									<Link to="/privacy" className="link link-hover">
										Privacy
									</Link>
									<Link to="/terms" className="link link-hover">
										Terms
									</Link>
									<Link to="/copyright" className="link link-hover">
										Copyright
									</Link>
									<Link to="/parents" className="link link-hover">
										For Parents
									</Link>
								</nav>
							</div>
						</div>
					</footer>
				</main>
			</div>

			<PlayerBar />
		</div>
	);
}

export default function LoggedInLayout() {
	return (
		<SidebarProvider>
			<LoggedInLayoutInner />
		</SidebarProvider>
	);
}
