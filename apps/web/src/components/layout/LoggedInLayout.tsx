// SPDX-License-Identifier: Apache-2.0

import { APP_VERSION } from "@anthers/shared/version";
import { useAuth } from "@anthers/web-shared/auth";
import { displayHandle, profileUrl } from "@anthers/web-shared/profile";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import Logo from "@anthers/web-shared/ui/Logo";
import ThemeToggle from "@anthers/web-shared/ui/ThemeToggle";
import {
	Bars3Icon,
	MagnifyingGlassIcon,
	RectangleStackIcon,
	RssIcon,
	ShoppingBagIcon,
	UserCircleIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { useBasket } from "../../lib/basket";
import { useMediaPlayer } from "../../lib/media-player";
import { studioUrl } from "../../lib/studio";
import { isStudioNavActive, STUDIO_NAV } from "../../studio/studio-nav";
import PlayerBar from "../media/PlayerBar";
import { type AppMode, useAppMode } from "./app-mode";
import IdentityServerBanner from "./IdentityServerBanner";
import NotificationBell from "./NotificationBell";
import PublishingPermissionBanner from "./PublishingPermissionBanner";
import RouteSuspense from "./RouteSuspense";
import SearchBar from "./SearchBar";
import { SidebarProvider, useSidebar } from "./SidebarContext";

/** The sidebar's nav in user mode. Studio mode has `STUDIO_NAV` in its place. */
const NAV_LINKS = [
	{ to: "/feed", id: "feed", label: "Feed", icon: RssIcon },
	{ to: "/library", id: "library", label: "Library", icon: RectangleStackIcon },
	{ to: "/discover", id: "discover", label: "Discover", icon: MagnifyingGlassIcon },
] as const;

const navItemClass = (active: boolean) =>
	`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
		active
			? "bg-primary/10 text-primary font-medium"
			: "text-base-content/70 hover:bg-base-300/50 hover:text-base-content"
	}`;

/**
 * Put the nav in the account's saved order: the saved ids first (the account's own
 * arrangement), the ids it has never named after them in the default order — so a
 * saved order can never drop an item, whatever a newer build's vocabulary holds.
 */
type NavLinkItem = (typeof NAV_LINKS)[number];

function orderedNavLinks(saved: string[] | null | undefined): readonly NavLinkItem[] {
	if (!saved || saved.length === 0) return NAV_LINKS;
	// An id the payload never named sorts last, so a saved order can never drop an
	// item however a newer build's ids changed.
	const pos = (id: NavLinkItem["id"]) => {
		const at = saved.indexOf(id);
		return at === -1 ? saved.length : at;
	};
	return [...NAV_LINKS].sort((a, b) => pos(a.id) - pos(b.id));
}

/**
 * The switch between the two modes, at the top of the sidebar, shown only to an account with
 * creator mode on (Parker, 2026-09-17). Each side goes to its mode's home, since the mode of
 * the page on screen is decided by where it is (`app-mode.ts`).
 */
function ModeSwitch({ mode }: { mode: AppMode }) {
	const sides = [
		{ to: "/feed", label: "Anthers", on: mode === "user" },
		{ to: studioUrl("/"), label: "Studio", on: mode === "studio" },
	];
	return (
		<nav className="join w-full" aria-label="Anthers or the Studio">
			{sides.map(({ to, label, on }) => (
				<Link
					key={label}
					to={to}
					aria-current={on ? "true" : undefined}
					className={`btn btn-sm join-item flex-1 ${on ? "btn-primary" : "btn-ghost bg-base-200"}`}
				>
					{label}
				</Link>
			))}
		</nav>
	);
}

function LoggedInLayoutInner() {
	const { user, signOut, refreshUser } = useAuth();
	const { currentTrack } = useMediaPlayer();
	const { sidebarOpen, toggleSidebar, closeSidebar, pageContent } = useSidebar();
	const navigate = useNavigate();
	const { pathname } = useLocation();
	const { count: basketCount } = useBasket();
	const isCreator = Boolean(user?.isCreator);
	const mode = useAppMode(isCreator);
	const studio = mode === "studio";

	// ── The nav's order ──────────────────────────────────────────────────────
	// Local first, account second: a drop reorders this sidebar immediately and
	// persists to the account; the saved payload stays what the shell boots with.
	const [navOrder, setNavOrder] = useState<string[] | null>(user?.homeNavOrder ?? null);
	const navDragFrom = useRef<number | null>(null);
	useEffect(() => {
		setNavOrder(user?.homeNavOrder ?? null);
	}, [user?.homeNavOrder]);

	const reorderNav = (from: number, to: number) => {
		setNavOrder((prev) => {
			const ids = orderedNavLinks(prev ?? user?.homeNavOrder ?? null).map((l) => l.id);
			const [moved] = ids.splice(from, 1);
			ids.splice(to, 0, moved);
			client.api.accounts.me
				.$patch({ json: { homeNavOrder: ids } })
				.then(() => refreshUser())
				.catch(() => {});
			return ids;
		});
	};

	// An account that has not finished onboarding owns nothing the sidebar points at:
	// Feed, Library and Discover are all behind ProtectedRoute, which bounces a
	// terms-owing account straight back to /welcome — so every link it offers is a dead
	// end wearing a nav item. The sidebar stays out of the way until the account has
	// finished, and the toggle button is part of its chrome and goes with it. (This
	// keyed on the username until the handle retired the column; the terms are what
	// onboarding still owes.)
	const onboarding = user ? user.termsAcceptedAt === null : false;
	const chromeHidden = !user || onboarding;

	const handleLogout = async () => {
		await signOut();
		navigate("/");
	};

	const navLinkClass = ({ isActive }: { isActive: boolean }) => navItemClass(isActive);

	return (
		<div className="h-screen flex flex-col overflow-hidden">
			{/* Top bar: hamburger and brand on the left, account on the right. It is the one header
			    in both modes; studio mode names itself beside the logo and leaves out search and
			    the basket, which belong to user mode. */}
			<header className="navbar nav-edge bg-base-200/50 backdrop-blur-md px-4 sticky top-0 z-40 h-14 min-h-0">
				<div className="navbar-start gap-1">
					{/* Kept MOUNTED through the auth load as invisible rather than removed from
					    the tree: a button that appears after auth resolves remounts navbar-start's
					    children, and that remounts the drawer-closed state over the one the
					    provider already opened. `sidebar-phone.authed.e2e.ts` is the guard —
					    it measures the sidebar's width, and the remount's signature there is a
					    closed sidebar on a desktop that should have started open. */}
					<button
						type="button"
						className={`btn btn-ghost btn-sm btn-square ${chromeHidden ? "invisible pointer-events-none" : ""}`}
						onClick={toggleSidebar}
						aria-label="Toggle sidebar"
						aria-hidden={chromeHidden || undefined}
						tabIndex={chromeHidden ? -1 : undefined}
					>
						<Bars3Icon className="w-5 h-5" />
					</button>
					{/* A plain flex link rather than a `btn`, for the same reason as the brand link in
					    LoggedOutLayout: the ghost button's hover background draws a rectangle the trimmed
					    logo artwork doesn't fill. */}
					<Link to={studio ? studioUrl("/") : "/feed"} className="flex items-center gap-2 px-2">
						<Logo variant="oneline" className="h-9" />
						{studio && <span className="text-lg font-bold text-primary">Studio</span>}
					</Link>
				</div>

				<div className="navbar-center flex-1 px-4 hidden sm:flex">{!studio && <SearchBar />}</div>

				<div className="navbar-end gap-1">
					{/* Basket — only rendered when it has items, so an empty basket costs no
					    header space. The header is tight on mobile and a permanent "0" badge
					    would be noise; a control that appears when it has content is strictly
					    better than one that is always there. The count is a `badge` so a
					    buyer who navigates away from the Work page can always get back to
					    the one surface where money changes hands. */}
					{!studio && basketCount > 0 && (
						<Link
							to="/basket"
							className="btn btn-ghost btn-sm btn-circle relative"
							aria-label={`Basket (${basketCount} item${basketCount > 1 ? "s" : ""})`}
						>
							<ShoppingBagIcon className="w-5 h-5" />
							<span className="badge badge-primary badge-xs absolute -top-1 -right-1">
								{basketCount}
							</span>
						</Link>
					)}
					{/* The bell — the same appear-when-there's-content rule as the basket, with the
					    count riding the shared store so one poll serves every surface. Studio mode
					    leaves it out with search and the basket: creator chrome, not reader chrome. */}
					{!studio && <NotificationBell />}
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
								<span className="text-xs text-base-content/50">
									{user ? displayHandle(user.handle) : ""}
								</span>
							</li>
							<div className="divider my-0 px-2" />
							<li>
								<Link to="/subscription">Subscription</Link>
							</li>
							<li>
								<Link to="/purchases">Purchases</Link>
							</li>
							<li>{user && <Link to={profileUrl(user.handle)}>Profile</Link>}</li>
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

			<PublishingPermissionBanner />
			<IdentityServerBanner />

			{/* Body: sidebar + main content */}
			<div className="relative flex flex-1 overflow-hidden">
				{/* Persistent sidebar. From `md` up it sits beside the page; below that it is
				    lifted out of the flex row and laid over the page, so opening it on a phone
				    never squeezes what it covers. The breakpoint is `SIDEBAR_BESIDE_QUERY`'s, which
				    is also what decides that a phone starts with it closed. */}
				<aside
					className={`${!chromeHidden && sidebarOpen ? "w-64 border-r" : "w-0"} absolute inset-y-0 left-0 z-30 md:static md:z-auto shrink-0 transition-all duration-200 overflow-hidden border-base-300/50 bg-base-200/60`}
				>
					<div className="w-64 h-full flex flex-col overflow-y-auto">
						{isCreator && (
							<div className="px-3 pt-3">
								<ModeSwitch mode={mode} />
							</div>
						)}

						{/* Each mode's own nav, and never both: the Studio's places used to be tabs
						    under a second header inside this layout, beside a sidebar still offering
						    Feed, Library and Discover. Each nav is named, so a user (and a spec) can
						    tell which one is on screen. */}
						{studio ? (
							<nav aria-label="Studio" className="p-3 flex flex-col gap-0.5">
								{STUDIO_NAV.map((item) => {
									const active = isStudioNavActive(item, pathname);
									return (
										<Link
											key={item.to}
											to={item.to}
											aria-current={active ? "page" : undefined}
											className={navItemClass(active)}
										>
											<item.icon className="w-5 h-5 shrink-0" />
											{item.label}
										</Link>
									);
								})}
							</nav>
						) : (
							<nav aria-label="Anthers" className="p-3 flex flex-col gap-0.5">
								{orderedNavLinks(navOrder).map((link, index) => (
									<div key={link.id} className="flex items-center">
										<NavLink to={link.to} className={`${navLinkClass} flex-1 min-w-0`}>
											<link.icon className="w-5 h-5 shrink-0" />
											{link.label}
										</NavLink>
										{/* The drag handle, at the item's own right edge: the grip is what
										    carries the drag (draggable on the span), and a drop on another
										    row reorders there. Reordering persists to the account, and
										    the top of the order is where a signed-in visit lands (see
										    `RootRedirect`). Keyboard reorder is not built; the gap is
										    named in the task. */}
										{/* biome-ignore lint/a11y/noStaticElementInteractions: the span is the drag source a native
											 HTML5 drag needs; there is no clickable or focusable behavior on it (the drag itself is
											 the interaction), and a static span is honest about that. */}
										<span
											title="Drag to reorder"
											onDragStart={(e) => {
												e.dataTransfer.effectAllowed = "move";
												// A drag with no payload can be refused before it starts;
												// the id rides for anything listening.
												e.dataTransfer.setData("text/plain", link.id);
												navDragFrom.current = index;
											}}
											onDragOver={(e) => e.preventDefault()}
											onDrop={(e) => {
												e.preventDefault();
												const from = navDragFrom.current;
												navDragFrom.current = null;
												if (from !== null && from !== index) reorderNav(from, index);
											}}
											className="cursor-grab px-1.5 text-base-content/25 hover:text-base-content/50 transition-colors self-stretch flex items-center active:cursor-grabbing"
										>
											<Bars3Icon className="w-3.5 h-3.5 rotate-90 pointer-events-none" />
										</span>
									</div>
								))}

								{/* Basket — the sidebar entry mirrors the header icon, for the mobile
								    case where the header is tight. Same conditional: only when non-empty. */}
								{basketCount > 0 && (
									<NavLink to="/basket" className={navLinkClass}>
										<ShoppingBagIcon className="w-5 h-5 shrink-0" />
										Basket
										<span className="badge badge-primary badge-sm ml-auto">{basketCount}</span>
									</NavLink>
								)}
							</nav>
						)}

						{/* Page-specific sidebar content */}
						{pageContent && (
							<>
								<div className="divider my-0 mx-3" />
								<div className="flex-1 p-3 overflow-y-auto">{pageContent}</div>
							</>
						)}
					</div>
				</aside>

				{/* The drawer's backdrop on a phone: a tap on the covered page closes it. */}
				{user && sidebarOpen && (
					<button
						type="button"
						aria-label="Close sidebar"
						className="absolute inset-0 z-20 bg-base-content/20 md:hidden"
						onClick={closeSidebar}
					/>
				)}

				{/* Main content area — reserve the scrollbar gutter so short and tall pages
					keep the same width (no content shift when the scrollbar appears).
					`min-w-0` also lets flex-column children shrink below their min-content
					size, so wide inner grids/tables can't blow the page wider than the
					viewport on mobile — the same guard LoggedOutLayout's <main> carries. */}
				<main
					className={`flex flex-1 min-w-0 flex-col overflow-y-auto [scrollbar-gutter:stable] ${currentTrack ? "pb-16" : ""}`}
				>
					<RouteSuspense>
						<Outlet />
					</RouteSuspense>

					{/* Footer, in user mode only: most of it is Feed, Library and Subscription, which
					    studio mode leaves out, and a working tool has no use for a site map. */}
					{!studio && (
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
									{/* Roadmap and Release Notes in their own column, matching the logged-out
									    footer's Development column (Parker, 2026-10-03). */}
									<nav className="join-item flex-1 flex flex-col items-center gap-1.5">
										<h6 className="footer-title text-xs">Development</h6>
										<Link to="/roadmap" className="link link-hover">
											Roadmap
										</Link>
										<Link to="/release-notes" className="link link-hover">
											Release Notes
										</Link>
										<Link to="/status" className="link link-hover">
											Status
										</Link>
										<Link to="/issues" className="link link-hover">
											Report an Issue
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
										<Link to="/supporters" className="link link-hover">
											Supporters
										</Link>
										<Link to="/resources" className="link link-hover">
											Resources
										</Link>
										{/* Under Support rather than Legal — see the note in LoggedOutLayout. */}
										<Link to="/parents" className="link link-hover">
											For Parents
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
										{/* Matches the URL and the mailbox — see the note in
										    LoggedOutLayout. */}
										<Link to="/abuse" className="link link-hover">
											Abuse
										</Link>
									</nav>
								</div>

								{/* The running version, quiet at the bottom of the page. A support
								    question or a bug report names the build it saw, and the footer is
								    where a person looks for it. Logged-in view only (Parker, 2026-10-01):
								    a logged-out visitor is being pitched to, not debugging. The value
								    is a committed calver constant — `@anthers/shared/version`'s docblock
								    carries why it is not computed from git at build time. */}
								<p className="mt-8 text-center text-[10px] opacity-40 select-none">
									Anthers {APP_VERSION}
								</p>
							</div>
						</footer>
					)}
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
