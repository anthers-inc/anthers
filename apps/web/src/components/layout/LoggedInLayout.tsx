// SPDX-License-Identifier: Apache-2.0

import { APP_VERSION } from "@anthers/shared/version";
import { useAuth } from "@anthers/web-shared/auth";
import { MeadowBackdrop } from "@anthers/web-shared/decor/MeadowBackdrop";
import { displayHandle, profileUrl } from "@anthers/web-shared/profile";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "@anthers/web-shared/router";
import { SidebarProvider, useSidebar } from "@anthers/web-shared/sidebar";
import Logo from "@anthers/web-shared/ui/Logo";
import ThemeSelect from "@anthers/web-shared/ui/ThemeSelect";
import { ChevronLeftIcon, ShoppingBagIcon, UserCircleIcon } from "@heroicons/react/24/outline";
import { useBasket } from "../../lib/basket";
import { useMediaPlayer } from "../../lib/media-player";
import { studioUrl } from "../../lib/studio";
import { USER_TABS, userTabPath } from "../../lib/user-tabs";
import { isStudioNavActive, STUDIO_NAV } from "../../studio/studio-nav";
import PlayerBar from "../media/PlayerBar";
import { type AppMode, useAppMode } from "./app-mode";
import IdentityServerBanner from "./IdentityServerBanner";
import NotificationBell from "./NotificationBell";
import PublishingPermissionBanner from "./PublishingPermissionBanner";
import RouteSuspense from "./RouteSuspense";
import SearchBar from "./SearchBar";
import { ViewFilterProvider } from "./search/filter-context";

/**
 * Where the signed-in site-map footer renders: the account pages only. Every other
 * signed-in page ends at its own content, since the sidebar and the header's account
 * menu already carry the reader's navigation. Studio mode omits the footer separately.
 */
const SITE_FOOTER_PATHS = new Set(["/purchases", "/settings"]);

/** Treat `/purchases/` and `/purchases` as the same destination. */
const showsSiteFooter = (pathname: string) =>
	SITE_FOOTER_PATHS.has(pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname);

const navItemClass = (active: boolean, rail: boolean) =>
	`flex items-center ${rail ? "justify-center px-2" : "gap-3 px-3"} py-2 rounded-lg text-sm transition-colors ${
		active
			? "bg-primary/10 text-primary font-medium"
			: "text-base-content/70 hover:bg-base-300/50 hover:text-base-content"
	}`;

/**
 * The switch between the two modes, at the top of the sidebar, shown only to an account with
 * creator mode on (Parker, 2026-09-17). The sides name the person rather than the product —
 * User|Creator (Parker, 2026-10-16) — and each side goes to its mode's home, since the mode of
 * the page on screen is decided by where it is (`app-mode.ts`). The user home is the account's
 * starting tab, the same rule `RootRedirect` follows.
 */
function ModeSwitch({ mode, userHome }: { mode: AppMode; userHome: string }) {
	const sides = [
		{ to: userHome, label: "User", on: mode === "user" },
		{ to: studioUrl("/"), label: "Creator", on: mode === "studio" },
	];
	return (
		<nav className="join w-full" aria-label="User or Creator">
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
	const { user, signOut } = useAuth();
	const { currentTrack } = useMediaPlayer();
	const { sidebarOpen, toggleSidebar, closeSidebar, pageContent, sharedContent } = useSidebar();
	const navigate = useNavigate();
	const { pathname } = useLocation();
	const { count: basketCount } = useBasket();
	const isCreator = Boolean(user?.isCreator);
	const mode = useAppMode(isCreator);
	const studio = mode === "studio";

	/**
	 * Where user mode begins: the account's starting tab, which is Network unless somebody
	 * chose another in Settings. The three tabs render in one fixed order, so this is the
	 * only thing that decides where a session lands.
	 */
	const userHome = userTabPath(user?.homeDefaultTab);

	// An account that has not finished onboarding owns nothing the sidebar points at:
	// Network, Library and Discovery are all behind ProtectedRoute, which bounces a
	// terms-owing account straight back to /welcome — so every link it offers is a dead
	// end wearing a nav item. The sidebar stays out of the way until the account has
	// finished, and the toggle button is part of its chrome and goes with it. (This
	// keyed on the username until the handle retired the column; the terms are what
	// onboarding still owes.)
	const onboarding = user ? user.termsAcceptedAt === null : false;
	const chromeHidden = !user || onboarding;

	/**
	 * Collapsed reads as a RAIL rather than a closed drawer (Parker, 2026-10-19): on a desktop
	 * the aside keeps 4rem of itself and shows the nav's icons, so the places stay one click
	 * away. Below `md` the same state is still width 0 — the aside is a drawer laid over the
	 * page there, and a rail would squeeze what it is supposed to stay out of — which is why
	 * only the desktop width is restored by the `md:` class rather than the base one.
	 */
	const rail = !sidebarOpen;

	const handleLogout = async () => {
		await signOut();
		navigate("/");
	};

	const navLinkClass = ({ isActive }: { isActive: boolean }) => navItemClass(isActive, rail);

	return (
		<ViewFilterProvider>
			<div className="h-screen flex flex-col overflow-hidden">
				{/* Top bar: brand on the left, account on the right. It is the one header in both modes;
		    studio mode leaves out search and the basket, which belong to user mode. The sidebar's
		    own toggle used to live here too and moved onto the sidebar's edge (2026-10-16). */}
				<header className="navbar nav-edge bg-base-200/50 backdrop-blur-md px-4 sticky top-0 z-40 h-14 min-h-0">
					<div className="navbar-start gap-1">
						{/* A plain flex link rather than a `btn`, for the same reason as the brand link in
					    LoggedOutLayout: the ghost button's hover background draws a rectangle the trimmed
					    logo artwork doesn't fill. */}
						<Link to={studio ? studioUrl("/") : userHome} className="flex items-center gap-2 px-2">
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
						<ThemeSelect />
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
									<Link to="/purchases">Badges &amp; Purchases</Link>
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
					{/* The sidebar's own toggle, riding its right edge level with the mode pair
				    (Parker, 2026-10-16): chevron-left over the edge collapses the sidebar, and
				    when it is closed the button sits on the page's left edge as chevron-right.
				    ONE button in ONE DOM position across the whole life of the layout — kept
				    MOUNTED through the auth load as invisible rather than removed from the
				    tree, because a button that appears after auth resolves remounts the
				    drawer-closed state over the one the provider already opened. Its old
				    header home had this same treatment; `sidebar-phone.authed.e2e.ts` is the
				    guard — it measures the sidebar's width, and the remount's signature there
				    is a closed sidebar on a desktop that should have started open. */}
					<button
						type="button"
						onClick={toggleSidebar}
						aria-label="Toggle sidebar"
						aria-hidden={chromeHidden || undefined}
						tabIndex={chromeHidden ? -1 : undefined}
						className={`btn btn-xs btn-circle border-base-300/60 bg-base-100 shadow-md absolute top-4 z-40 transition-all duration-base ease-in-out ${
							sidebarOpen
								? "left-64 -translate-x-1/2"
								: "left-0 md:left-16 translate-x-0 md:-translate-x-1/2"
						} ${chromeHidden ? "invisible pointer-events-none" : ""}`}
					>
						<ChevronLeftIcon
							className={`w-3.5 h-3.5 transition-transform duration-base ${sidebarOpen ? "" : "rotate-180"}`}
						/>
					</button>
					{/* Persistent sidebar. From `md` up it sits beside the page; below that it is
				    lifted out of the flex row and laid over the page, so opening it on a phone
				    never squeezes what it covers. The breakpoint is `SIDEBAR_BESIDE_QUERY`'s, which
				    is also what decides that a phone starts with it closed. */}
					<aside
						className={`${!chromeHidden && sidebarOpen ? "w-64 border-r" : chromeHidden ? "w-0" : "w-0 md:w-16 md:border-r"} absolute inset-y-0 left-0 z-30 md:static md:z-auto shrink-0 transition-all duration-base overflow-hidden border-base-300/50 bg-base-200/60`}
					>
						<div className={`${rail ? "w-16" : "w-64"} h-full flex flex-col overflow-y-auto`}>
							{isCreator && !rail && (
								<div className="px-3 pt-3">
									<ModeSwitch mode={mode} userHome={userHome} />
								</div>
							)}

							{/* Each mode's own nav, and never both: the Studio's places used to be tabs
						    under a second header inside this layout, beside a sidebar still offering
						    Network, Library and Discovery. Each nav is named, so a user (and a spec) can
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
												title={rail ? item.label : undefined}
												className={navItemClass(active, rail)}
											>
												<item.icon className="w-5 h-5 shrink-0" />
												{rail ? <span className="sr-only">{item.label}</span> : item.label}
											</Link>
										);
									})}
								</nav>
							) : (
								<nav aria-label="Anthers" className="p-3 flex flex-col gap-0.5">
									{/* One fixed order — Library, Network, Discovery — because the account's
								    starting tab is a setting rather than a consequence of this list's
								    arrangement. Nothing here is draggable; see `lib/user-tabs.ts`. */}
									{USER_TABS.map((link) => (
										<NavLink
											key={link.id}
											to={link.to}
											title={rail ? link.label : undefined}
											className={navLinkClass}
										>
											<link.icon className="w-5 h-5 shrink-0" />
											{rail ? <span className="sr-only">{link.label}</span> : link.label}
										</NavLink>
									))}

									{/* Basket — the sidebar entry mirrors the header icon, for the mobile
								    case where the header is tight. Same conditional: only when non-empty. */}
									{basketCount > 0 && (
										<NavLink
											to="/basket"
											className={navLinkClass}
											title={
												rail
													? `Basket (${basketCount} item${basketCount > 1 ? "s" : ""})`
													: undefined
											}
										>
											<ShoppingBagIcon className="w-5 h-5 shrink-0" />
											{rail ? <span className="sr-only">Basket</span> : "Basket"}
											<span
												className={`badge badge-primary badge-sm ${rail ? "sr-only" : "ml-auto"}`}
											>
												{basketCount}
											</span>
										</NavLink>
									)}
								</nav>
							)}

							{!studio && !rail && (
								<>
									{/* The divider below the nav is PERSISTENT (Parker, 2026-10-11): it
								    stands whether or not anything is registered below it, so the
								    sidebar's shape — tabs above, sections below — never depends on
								    the page. Studio mode is out of this structure's scope. */}
									<div className="divider my-0 mx-3" />
									{/* The lower region: the page's middle section, then the tab-shared
								    filters behind one more divider (rendered only when both exist —
								    a trailing divider would promise content that isn't there). One
								    scroll region for both, so a long middle section scrolls on into
								    the filters rather than stopping at a seam. */}
									<div className="flex-1 min-h-0 overflow-y-auto">
										{pageContent && <div className="p-3 pb-1">{pageContent}</div>}
										{pageContent && sharedContent && <div className="divider my-0 mx-3" />}
										{sharedContent && <div className="p-3 pt-1">{sharedContent}</div>}
									</div>
								</>
							)}
							{/* Studio keeps the old shape — divider only when a page registers
						    content; none does today. This is the seam if that ever changes. */}
							{studio && !rail && pageContent && (
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

					{/* Meadow backdrop behind the whole page area. `relative isolate` scopes the
				    layer's own stacking: the backdrop carries the negative z-index itself, so
				    everything on the page paints above it by construction and no decoration
				    ever rides across a creator's work or a post. The vines are hidden below
				    `xl`, where the shell is too dense for them. The wrapper stays mounted in
				    every shell state (onboarding included) — one tree, rebuilt on nothing. */}
					<div className="relative isolate flex flex-1 min-w-0 flex-col">
						<MeadowBackdrop />
						<main
							className={`flex flex-1 min-h-0 flex-col overflow-y-auto [scrollbar-gutter:stable] transition-[padding-bottom] duration-base ease-settle ${currentTrack ? "pb-16" : ""}`}
						>
							<RouteSuspense>
								<Outlet />
							</RouteSuspense>

							{/* Footer, on the account pages only: Badges & Purchases and Settings are where
					    a person is managing their own account, and the site map's reference and legal
					    columns belong there. Every other signed-in page ends at its own content.
					    Studio mode leaves it out entirely; a working tool has no use for a site map. */}
							{!studio && showsSiteFooter(pathname) && (
								<footer
									data-site-footer
									// `mt-auto` pins the footer to the bottom of `<main>`'s scroll area:
									// this flex column is taller than the viewport whenever a page's
									// content runs short, and without the push the footer hugs the content
									// and leaves the height below it empty (Settings, in the extreme).
									// With content taller than the viewport there is no free space and
									// the margin is zero, leaving the footer directly under the content.
									className={`mt-auto bg-base-300/30 backdrop-blur-md text-base-content text-xs p-10 transition-[margin-bottom] duration-base ease-settle ${currentTrack ? "mb-16" : ""}`}
								>
									<div className="max-w-7xl mx-auto">
										<div className="join join-horizontal w-full">
											<nav className="join-item flex-1 flex flex-col items-center gap-1.5">
												<h6 className="footer-title text-xs">Discovery</h6>
												<Link to="/discovery" className="link link-hover">
													Find something new
												</Link>
											</nav>
											<nav className="join-item flex-1 flex flex-col items-center gap-1.5">
												<h6 className="footer-title text-xs">Your Stuff</h6>
												<Link to="/network" className="link link-hover">
													Network
												</Link>
												<Link to="/library" className="link link-hover">
													Library
												</Link>
												<Link to="/purchases" className="link link-hover">
													Badges &amp; Purchases
												</Link>
											</nav>
											{/* Release Notes in its own column, matching the logged-out footer's
									    Development column (Parker, 2026-10-03). The Roadmap link came out
									    of both footers on 2026-10-20 — the canonical roadmap is the
									    wiki's, and a footer is not where a reader is sent off-site. */}
											<nav className="join-item flex-1 flex flex-col items-center gap-1.5">
												<h6 className="footer-title text-xs">Development</h6>
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
				</div>

				<PlayerBar />
			</div>
		</ViewFilterProvider>
	);
}

export default function LoggedInLayout() {
	return (
		<SidebarProvider>
			<LoggedInLayoutInner />
		</SidebarProvider>
	);
}
