// SPDX-License-Identifier: AGPL-3.0-or-later
import { useAuth } from "@anthers/web-shared/auth";
import Logo from "@anthers/web-shared/ui/Logo";
import ThemeToggle from "@anthers/web-shared/ui/ThemeToggle";
import {
	ArrowTopRightOnSquareIcon,
	ChartBarIcon,
	Cog6ToothIcon,
	PencilSquareIcon,
	RectangleStackIcon,
	Squares2X2Icon,
} from "@heroicons/react/24/outline";
import type { ComponentType, ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

/**
 * Studio nav. Every path is `/studio`-prefixed because the Studio is a SECTION of the
 * consumer app now, not a separate origin — so these are ordinary in-app routes and the
 * old cross-origin hops are gone.
 */
const STUDIO = "/studio";
const NAV: { to: string; label: string; icon: ComponentType<{ className?: string }> }[] = [
	{ to: STUDIO, label: "Dashboard", icon: Squares2X2Icon },
	// Catalog, NOT "Library". A creator keeps a Catalog of Works; **Library is the bound
	// term for the USER's own owned content** and is the sidebar item directly above this
	// one in `LoggedInLayout`, so the two were the same word for opposite things.
	// `/studio/library` still resolves — it is kept as an alias for old bookmarks.
	{ to: `${STUDIO}/catalog`, label: "Catalog", icon: RectangleStackIcon },
	{ to: `${STUDIO}/posts/new`, label: "New Post", icon: PencilSquareIcon },
	{ to: `${STUDIO}/analytics`, label: "Analytics", icon: ChartBarIcon },
	// Import nav hidden — the itch.io import endpoints return "not yet implemented".
	// Restore this line (and the route + lazy import in App.tsx) when the lane ships.
	// { to: `${STUDIO}/import`, label: "Import", icon: ArrowUpTrayIcon },
	{ to: `${STUDIO}/settings`, label: "Settings", icon: Cog6ToothIcon },
];

/** Is `path` the active nav item? The dashboard matches only exactly. */
function isActive(current: string, path: string): boolean {
	return path === STUDIO ? current === STUDIO : current === path || current.startsWith(`${path}/`);
}

/**
 * Studio chrome — a wordmark that returns to Anthers, the creator-management nav, the
 * signed-in handle, and a back-to-site link. Authoring/management pages manage their own
 * content container, so the shell supplies header + nav and lets children fill the rest.
 */
export default function StudioShell({ children }: { children: ReactNode }) {
	const { user } = useAuth();
	const { pathname } = useLocation();

	return (
		<div className="min-h-screen">
			<header className="border-b border-base-content/10 bg-base-200/40 backdrop-blur sticky top-0 z-10">
				<div className="max-w-5xl mx-auto px-4">
					<div className="h-14 flex items-center justify-between gap-4">
						<Link to={STUDIO} className="flex items-center gap-2 font-bold shrink-0">
							<Logo variant="oneline" className="h-8" />
							<span className="text-lg text-primary">Studio</span>
						</Link>
						<div className="flex items-center gap-4 text-sm">
							{user?.username && (
								<span className="text-base-content/60 hidden sm:inline">@{user.username}</span>
							)}
							<Link to="/" className="link link-hover inline-flex items-center gap-1">
								<span className="hidden sm:inline">Back to Anthers</span>
								<ArrowTopRightOnSquareIcon className="w-4 h-4" />
							</Link>
							<ThemeToggle />
						</div>
					</div>
					<nav className="flex items-center gap-1 -mb-px overflow-x-auto">
						{NAV.map(({ to, label, icon: Icon }) => (
							<Link
								key={to}
								to={to}
								className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 whitespace-nowrap ${
									isActive(pathname, to)
										? "border-primary text-primary font-medium"
										: "border-transparent text-base-content/70 hover:text-base-content"
								}`}
							>
								<Icon className="w-4 h-4" />
								{label}
							</Link>
						))}
					</nav>
				</div>
			</header>
			<main>{children}</main>
		</div>
	);
}
