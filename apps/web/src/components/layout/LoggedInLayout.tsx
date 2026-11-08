// SPDX-License-Identifier: Apache-2.0

import { matchesChord, resolveKeyboardShortcuts } from "@anthers/shared/keybindings";
import { useAuth } from "@anthers/web-shared/auth";
import { MeadowBackdrop } from "@anthers/web-shared/decor/MeadowBackdrop";
import { displayHandle, profileUrl } from "@anthers/web-shared/profile";
import { Link, NavLink, Outlet, useLocation } from "@anthers/web-shared/router";
import { SidebarProvider, useSidebar } from "@anthers/web-shared/sidebar";
import Logo from "@anthers/web-shared/ui/Logo";
import { ChevronLeftIcon, Cog6ToothIcon, ShoppingCartIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo } from "react";
import { useCart } from "../../lib/cart";
import { useMediaPlayer } from "../../lib/media-player";
import { isApplePlatform } from "../../lib/platform";
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
 * A sidebar row. `dense` is for the one row that carries two lines — the creator's profile,
 * whose name and handle share a single tab's height — so its padding is the two-line one
 * rather than a class appended over `py-2`, which Tailwind's cascade would decide arbitrarily.
 */
const navItemClass = (active: boolean, rail: boolean, dense = false) =>
	`flex items-center ${rail ? "justify-center px-2" : "gap-3 px-3"} ${
		dense && !rail ? "py-1.5" : "py-2"
	} rounded-lg text-sm transition-colors ${
		active
			? "bg-primary/10 text-primary font-medium"
			: "text-base-content/70 hover:bg-base-300/50 hover:text-base-content"
	}`;

/**
 * The switch between the two modes, in the header beside the logo, shown only to an account
 * with creator mode on (Parker, 2026-09-17; moved here 2026-10-23). The sides name the person
 * rather than the product — User|Creator (Parker, 2026-10-16) — and each side goes to its
 * mode's home, since the mode of the page on screen is decided by where it is (`app-mode.ts`).
 * The user home is the account's starting tab, the same rule `RootRedirect` follows, and the
 * creator home is the Studio's root, which forwards to the Dashboard tab on the creator's own
 * profile — the place that replaced the Studio's old Dashboard tab.
 *
 * ⚠️ **The toggle is bounded, because an unbounded one is unreadable.** Its inactive side used
 * to be `bg-base-200`, the sidebar's own color, so the pair had no visible edge and the
 * toggle read as one button that changed color at some arbitrary point. The join carries a
 * hairline border and a soft shadow, and the inactive side sits on `base-100` — the surface
 * the page uses — so both halves read as controls against either the header or the sidebar.
 *
 * ⭐ **From either settings page, each side lands on the OTHER settings page** (Parker,
 * 2026-10-26). The switch names which half of the app the person is in, so somebody already
 * managing their account expects the same job in the other half rather than that half's
 * home; the old behavior sent a flip to User from Creator Settings to Discovery, and a flip
 * to Creator from User Settings to the Studio's root. Every other page still sends each
 * side to its mode's home.
 */
function ModeSwitch({
	mode,
	userHome,
	creatorHome,
	pathname,
}: {
	mode: AppMode;
	userHome: string;
	creatorHome: string;
	pathname: string;
}) {
	const here = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	const onUserSettings = here === "/settings";
	const onCreatorSettings = here === "/studio/settings";

	const sides = [
		{ to: onCreatorSettings ? "/settings" : userHome, label: "User", on: mode === "user" },
		{
			to: onUserSettings ? studioUrl("/settings") : creatorHome,
			label: "Creator",
			on: mode === "studio",
		},
	];
	return (
		<nav
			className="join rounded-lg border border-base-300 bg-base-100 shadow-sm"
			aria-label="User or Creator"
		>
			{sides.map(({ to, label, on }) => (
				<Link
					key={label}
					to={to}
					aria-current={on ? "true" : undefined}
					className={`btn btn-sm join-item h-8 min-h-0 border-0 px-3 font-medium ${
						on
							? "btn-primary"
							: "bg-base-100 text-base-content/70 hover:bg-base-200 hover:text-base-content"
					}`}
				>
					{label}
				</Link>
			))}
		</nav>
	);
}

/**
 * The creator's own profile as a sidebar row: their thumbnail where every other tab draws an
 * icon, their display name where it draws a label, and their handle as the subtext beneath it
 * (Parker, 2026-10-23). It replaces the Studio's Dashboard tab, which moved to a tab on this
 * same profile.
 *
 * ⚠️ **The thumbnail survives the rail**, because it IS this row's icon — a rail that dropped
 * it would leave the creator's home as the one tab with nothing drawn in the column.
 */
function ProfileRow({ rail, active }: { rail: boolean; active: boolean }) {
	const { user } = useAuth();
	if (!user) return null;
	const name = user.displayName || user.handle;
	return (
		<Link
			to={profileUrl(user.handle)}
			aria-current={active ? "page" : undefined}
			title={rail ? name : undefined}
			className={navItemClass(active, rail, true)}
		>
			{user.avatar ? (
				<img src={user.avatar} alt="" className="w-6 h-6 shrink-0 rounded-full object-cover" />
			) : (
				<span
					aria-hidden="true"
					className="w-6 h-6 shrink-0 rounded-full bg-base-300 text-[11px] font-semibold flex items-center justify-center text-base-content/60"
				>
					{name.charAt(0).toUpperCase()}
				</span>
			)}
			{rail ? (
				<span className="sr-only">{name}</span>
			) : (
				<span className="flex min-w-0 flex-col leading-tight">
					<span className="truncate">{name}</span>
					<span className="truncate text-xs text-base-content/50">
						{displayHandle(user.handle)}
					</span>
				</span>
			)}
		</Link>
	);
}

/**
 * The signed-in app's phone navigation: Library, Discovery and Settings at thumb height.
 *
 * 🚨 **This is a third shape for the phone, not a breakpoint on the desktop bar.** The
 * desktop's sidebar is a drawer below `md`, so every destination there costs two taps — open
 * the drawer, then tap — on the surface a reader navigates from most. The bar puts the two
 * content tabs and the account door one tap away, and leaves the drawer for its real phone
 * job: the filters and page sections the sidebar carries. The Studio keeps that drawer and
 * has no bar, because its seven places are a tool's nav rather than a reader's.
 *
 * The bar is hidden while the drawer is open so the backdrop and the bar never compete for
 * the same tap, and while the chrome is hidden by its shortcut. It carries the bottom inset
 * itself; `main` reserves `.phone-tabs-space` above it (see globals.css).
 */
function PhoneTabs({ hidden }: { hidden: boolean }) {
	const { pathname, search } = useLocation();
	/**
	 * The lens rides across the two content tabs on a phone as it does on the desktop nav
	 * (Parker, 2026-11-06). Settings is left plain — a lens means nothing there.
	 */
	const lens = new URLSearchParams(search).get("lens") ?? "";
	const tabTo = (to: string) => (lens ? `${to}?lens=${encodeURIComponent(lens)}` : to);
	const items = [
		...USER_TABS.map(({ to, label, icon: Icon }) => ({
			to: tabTo(to),
			path: to,
			label,
			Icon,
		})),
		{ to: "/settings", path: "/settings", label: "Settings", Icon: Cog6ToothIcon },
	];
	return (
		<nav
			aria-label="Anthers tabs"
			data-phone-tabs
			className={`md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-base-300 bg-base-200/95 backdrop-blur safe-bottom safe-sides ${
				hidden ? "hidden" : ""
			}`}
		>
			<div className="flex h-16 items-stretch">
				{items.map(({ to, path, label, Icon }) => {
					const active = pathname === path || pathname.startsWith(`${path}/`);
					return (
						<NavLink
							key={to}
							to={to}
							aria-current={active ? "page" : undefined}
							className={`flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors ${
								active ? "text-primary" : "text-base-content/60 hover:text-base-content"
							}`}
						>
							<Icon className="w-5 h-5" />
							<span>{label}</span>
						</NavLink>
					);
				})}
			</div>
		</nav>
	);
}

function LoggedInLayoutInner() {
	const { user } = useAuth();
	const { currentTrack } = useMediaPlayer();
	const { sidebarOpen, toggleSidebar, closeSidebar, pageContent, sharedContent, topBarContent } =
		useSidebar();
	const { pathname, search } = useLocation();
	const { count: cartCount } = useCart();
	const creatorMode = Boolean(user?.creatorMode);
	const mode = useAppMode(creatorMode);
	const studio = mode === "studio";

	/**
	 * Where user mode begins: the account's starting tab, which is Discovery unless
	 * somebody chose Library in Settings. The tabs render in one fixed order, so this is
	 * the only thing that decides where a session lands.
	 */
	const userHome = userTabPath(user?.homeDefaultTab);

	/**
	 * The lens survives a switch between the two content tabs (Parker, 2026-11-06).
	 *
	 * ⭐ **Every Library/Discovery link carries the lens the reader is under**, so moving
	 * from "my Library under the Music Player" to Discovery lands on "the stream under the
	 * Music Player" rather than resetting to No Lens. The lens remains the page's URL
	 * parameter — this only carries it across the nav, which is what makes it feel like a
	 * view of both corpora rather than a setting of one page.
	 */
	const lens = new URLSearchParams(search).get("lens") ?? "";
	const tabTo = (to: string) => (lens ? `${to}?lens=${encodeURIComponent(lens)}` : to);

	/**
	 * Where creator mode begins: `/studio`, which forwards to the creator's own profile with
	 * the Dashboard tab open. Keeping the switch pointed at the Studio root rather than at the
	 * profile itself matters — a profile belongs to neither mode, so a link straight to it
	 * would leave the sidebar on whichever side the person arrived from.
	 */
	const creatorHome = studioUrl("/");

	// An account that has not finished onboarding owns nothing the sidebar points at:
	// Library and Discovery are both behind ProtectedRoute, which bounces a
	// terms-owing account straight back to /welcome — so every link it offers is a dead
	// end wearing a nav item. The sidebar stays out of the way until the account has
	// finished, and the toggle button is part of its chrome and goes with it. (This
	// keyed on the username until the handle retired the column; the terms are what
	// onboarding still owes.)
	const onboarding = user ? user.termsAcceptedAt === null : false;
	const chromeHidden = !user || onboarding;
	/**
	 * The phone tab bar's presence. Studio keeps the drawer because its seven places are a
	 * tool's nav, and onboarding has nothing the drawer or the bar can point at — both would
	 * be dead ends behind ProtectedRoute.
	 */
	const phoneTabbed = !studio && !chromeHidden;

	/**
	 * Collapsed reads as a RAIL rather than a closed drawer (Parker, 2026-10-19): on a desktop
	 * the aside keeps 4rem of itself and shows the nav's icons, so the places stay one click
	 * away. Below `md` the same state is still width 0 — the aside is a drawer laid over the
	 * page there, and a rail would squeeze what it is supposed to stay out of — which is why
	 * only the desktop width is restored by the `md:` class rather than the base one.
	 */
	const rail = !sidebarOpen;

	const navLinkClass = ({ isActive }: { isActive: boolean }) => navItemClass(isActive, rail);

	/**
	 * The sidebar's own key, bound from the same account map the Settings card edits
	 * (`Ctrl+/` by default). It is the keyboard twin of the chevron on the sidebar's edge
	 * rather than a second way of moving the drawer.
	 *
	 * ⚠️ **It fires with a text field focused, and that is deliberate.** The search bar skips
	 * `Ctrl+K` over an editor because that chord is an editing command in a composer;
	 * `Ctrl+/` is not, so a reader halfway through a comment can put the sidebar away without
	 * clicking out first. Safety while typing comes from the grammar's modifier requirement,
	 * which every page shortcut carries, rather than from a target check here.
	 *
	 * It is unbound while the chrome is hidden — an account that still owes onboarding has no
	 * sidebar to toggle, and the chevron is invisible for the same reason.
	 */
	const shortcuts = useMemo(
		() => resolveKeyboardShortcuts(user?.keyboardShortcuts),
		[user?.keyboardShortcuts],
	);
	const apple = isApplePlatform();

	useEffect(() => {
		if (chromeHidden) return;
		const handler = (event: globalThis.KeyboardEvent) => {
			if (!matchesChord(event, shortcuts.sidebar, apple)) return;
			event.preventDefault();
			toggleSidebar();
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [chromeHidden, shortcuts.sidebar, apple, toggleSidebar]);

	return (
		<ViewFilterProvider>
			<div
				className={`h-dvh flex flex-col overflow-hidden safe-bottom safe-sides ${
					phoneTabbed ? "phone-tabbed" : ""
				}`}
			>
				{/* Top bar: brand and the mode switch on the left, search in the middle, the
		    reader's notifications on the right. It is the one header in both modes; studio
		    mode leaves out search and the cart, which belong to user mode. The sidebar's
		    own toggle used to live here too and moved onto the sidebar's edge (2026-10-16),
		    and the account menu left on 2026-10-26 — the sidebar is the door to Settings and
		    Badges and Purchases live in the account pages' sidebar rows.

		    ⚠️ **The safe-area strip is INSIDE the header, not padding on it.** The bar is a
		    fixed `h-14` and the page's background sits behind it, so padding on the header
		    would eat into the bar's own height; a strip above the navbar grows the header by
		    the inset and paints the same backdrop under the status bar and camera cutout. */}
				<header className="nav-edge bg-base-200/50 backdrop-blur-md sticky top-0 z-40">
					<div className="safe-top" aria-hidden="true" />
					<div className="navbar px-4 h-14 min-h-0">
						<div className="navbar-start gap-3">
							{/* A plain flex link rather than a `btn`, for the same reason as the brand link in
					    LoggedOutLayout: the ghost button's hover background draws a rectangle the trimmed
					    logo artwork doesn't fill. */}
							<Link
								to={studio ? creatorHome : userHome}
								className="flex items-center gap-2 pl-2 pr-1"
							>
								<Logo variant="oneline" className="h-9" />
							</Link>
							{/* The mode switch sits beside the logo rather than at the top of the sidebar: it names
						    the two halves of the whole app, so it belongs to the one header both halves share,
						    and the sidebar's first row is free for where the creator actually is. */}
							{creatorMode && !chromeHidden && (
								<ModeSwitch
									mode={mode}
									userHome={userHome}
									creatorHome={creatorHome}
									pathname={pathname}
								/>
							)}
						</div>

						<div className="navbar-center flex-1 px-4 hidden sm:flex justify-center">
							{/* The page's own header content — today the owner's View As control —
							    takes the search bar's place, so the same control lands in the same
							    spot on every subject page that registers one. Studio mode has no
							    search to displace, so the slot simply fills the center there. */}
							{topBarContent ?? (!studio ? <SearchBar /> : null)}
						</div>

						<div className="navbar-end gap-1">
							{/* Cart — only rendered when it has items, so an empty cart costs no
					    header space. The header is tight on mobile and a permanent "0" badge
					    would be noise; a control that appears when it has content is strictly
					    better than one that is always there. The count is a `badge` so a
					    buyer who navigates away from the Work page can always get back to
					    the one surface where money changes hands. */}
							{!studio && cartCount > 0 && (
								<Link
									to="/cart"
									className="btn btn-ghost btn-sm btn-circle relative"
									aria-label={`Cart (${cartCount} item${cartCount > 1 ? "s" : ""})`}
								>
									<ShoppingCartIcon className="w-5 h-5" />
									<span className="badge badge-primary badge-xs absolute -top-1 -right-1">
										{cartCount}
									</span>
								</Link>
							)}
							{/* The bell — the same appear-when-there's-content rule as the cart, with the
					    count riding the shared store so one poll serves every surface. Studio mode
					    leaves it out with search and the cart: creator chrome, not reader chrome. */}
							{!studio && <NotificationBell />}
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
				    is also what decides that a phone starts with it closed.

				    ⚠️ **The drawer is OPAQUE below `md` and translucent above it.** The 60% tint
				    is a surface *beside* the page on a desktop — the meadow backdrop showing
				    faintly through it — but a drawer laid *over* the page with that tint lets
				    page content read straight through its labels and rows, which is the
				    illegibility this rule exists to prevent. The rail and the desktop column
				    keep the tint; the phone gets the solid `base-200` panel. */}
					<aside
						className={`${!chromeHidden && sidebarOpen ? "w-64 border-r" : chromeHidden ? "w-0" : "w-0 md:w-16 md:border-r"} absolute inset-y-0 left-0 z-30 md:static md:z-auto shrink-0 transition-all duration-base overflow-hidden border-base-300/50 bg-base-200 md:bg-base-200/60`}
					>
						<div className={`${rail ? "w-16" : "w-64"} h-full flex flex-col overflow-y-auto`}>
							{/* Each mode's own nav, and never both: the Studio's places used to be tabs
						    under a second header inside this layout, beside a sidebar still offering
						    Library and Discovery. Each nav is named, so a user (and a spec) can
						    tell which one is on screen. */}
							{studio ? (
								<nav aria-label="Studio" className="p-3 flex flex-col gap-0.5">
									{/* The creator's own profile, where the Dashboard lives now. It leads the nav
									    because it is the creator's home, and it carries their face rather than an
									    icon — the one row here that names a person instead of a place in the app. */}
									<ProfileRow rail={rail} active={pathname === profileUrl(user?.handle ?? "")} />
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
									{/* One fixed order — Library, Discovery — because the account's starting
								    tab is a setting rather than a consequence of this list's arrangement.
								    Nothing here is draggable; see `lib/user-tabs.ts`. */}
									{USER_TABS.map((link) => (
										<NavLink
											key={link.id}
											to={tabTo(link.to)}
											title={rail ? link.label : undefined}
											className={navLinkClass}
										>
											<link.icon className="w-5 h-5 shrink-0" />
											{rail ? <span className="sr-only">{link.label}</span> : link.label}
										</NavLink>
									))}

									{/* Settings — the account's own door, below the three tabs (Parker, 2026-10-23).
									    It is a row rather than a fourth entry in `USER_TABS`, deliberately: those
									    three are the tabs a session can start on, and Settings is where a person
									    manages the account rather than somewhere the site lands them. */}
									<NavLink
										to="/settings"
										title={rail ? "Settings" : undefined}
										className={navLinkClass}
									>
										<Cog6ToothIcon className="w-5 h-5 shrink-0" />
										{rail ? <span className="sr-only">Settings</span> : "Settings"}
									</NavLink>
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
							className={`flex flex-1 min-h-0 flex-col overflow-y-auto [scrollbar-gutter:stable] transition-[padding-bottom] duration-base ease-settle ${
								phoneTabbed ? "phone-tabs-space" : ""
							} ${currentTrack ? `pb-16 ${phoneTabbed ? "phone-tabs-space-player" : ""}` : ""}`}
						>
							<RouteSuspense>
								<Outlet />
							</RouteSuspense>
						</main>
					</div>
				</div>

				<PlayerBar />
				{phoneTabbed && <PhoneTabs hidden={sidebarOpen} />}
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
