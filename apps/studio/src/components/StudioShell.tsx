// SPDX-License-Identifier: AGPL-3.0-or-later
import { useAuth } from "@anthers/web-shared/auth";
import ThemeToggle from "@anthers/web-shared/ui/ThemeToggle";
import {
	ArrowTopRightOnSquareIcon,
	ArrowUpTrayIcon,
	ChartBarIcon,
	Cog6ToothIcon,
	PencilSquareIcon,
	RectangleStackIcon,
	Squares2X2Icon,
} from "@heroicons/react/24/outline";
import type { ComponentType, ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { consumerOrigin } from "../lib/consumer";

const NAV: { to: string; label: string; icon: ComponentType<{ className?: string }> }[] = [
	{ to: "/", label: "Dashboard", icon: Squares2X2Icon },
	{ to: "/library", label: "Library", icon: RectangleStackIcon },
	{ to: "/posts/new", label: "New Post", icon: PencilSquareIcon },
	{ to: "/analytics", label: "Analytics", icon: ChartBarIcon },
	{ to: "/import", label: "Import", icon: ArrowUpTrayIcon },
	{ to: "/settings", label: "Settings", icon: Cog6ToothIcon },
];

/** Is `path` the active nav item? The dashboard ("/") matches only exactly. */
function isActive(current: string, path: string): boolean {
	return path === "/" ? current === "/" : current === path || current.startsWith(`${path}/`);
}

/**
 * Studio chrome — a wordmark that returns to Anthers, the creator-management nav, the
 * signed-in handle, and a back-to-site link. Authoring/management pages manage their own
 * content container, so the shell supplies header + nav and lets children fill the rest.
 */
export default function StudioShell({ children }: { children: ReactNode }) {
	const { user } = useAuth();
	const site = consumerOrigin();
	const { pathname } = useLocation();

	return (
		<div className="min-h-screen">
			<header className="border-b border-base-content/10 bg-base-200/40 backdrop-blur sticky top-0 z-10">
				<div className="max-w-5xl mx-auto px-4">
					<div className="h-14 flex items-center justify-between gap-4">
						<Link to="/" className="flex items-center gap-2 font-bold shrink-0">
							<span className="text-xl">🌻</span>
							<span>
								Anthers <span className="text-primary">Studio</span>
							</span>
						</Link>
						<div className="flex items-center gap-4 text-sm">
							{user?.username && (
								<span className="text-base-content/60 hidden sm:inline">@{user.username}</span>
							)}
							<a href={site} className="link link-hover inline-flex items-center gap-1">
								<span className="hidden sm:inline">Back to Anthers</span>
								<ArrowTopRightOnSquareIcon className="w-4 h-4" />
							</a>
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
