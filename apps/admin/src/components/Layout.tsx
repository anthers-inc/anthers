// SPDX-License-Identifier: Apache-2.0
/**
 * The admin app's frame: the sections down the side, and who is signed in.
 *
 * The sections are Legal, Moderation, Infrastructure and Accounts, grouped so that a later split by
 * capability is one check per section. Accounts is the only one with a check today, because it is
 * super-admin only; the API refuses it too, so hiding the link is courtesy rather than the gate.
 * Books is not here yet — it appears with its first tool.
 */
import { applyTheme, storeTheme, useTheme } from "@anthers/web-shared/theme";
import { MoonIcon, SunIcon } from "@heroicons/react/24/outline";
import { NavLink, Outlet } from "react-router-dom";
import { useSession } from "../lib/session";

interface NavItem {
	to: string;
	label: string;
	end?: boolean;
}

const SECTIONS: { title: string; items: NavItem[]; superAdminOnly?: boolean }[] = [
	{ title: "Overview", items: [{ to: "/", label: "Home", end: true }] },
	{
		title: "Legal",
		items: [
			{ to: "/legal/rights-requests", label: "Rights Requests" },
			{ to: "/legal/quarantine", label: "Quarantine" },
			{ to: "/legal/abuse-reports", label: "Abuse Reports" },
			{ to: "/legal/dmca", label: "DMCA Notices" },
			{ to: "/legal/holds", label: "Legal Holds" },
		],
	},
	{
		title: "Moderation",
		items: [
			{ to: "/moderation", label: "Queue", end: true },
			{ to: "/moderation/appeals", label: "Rating Appeals" },
		],
	},
	{ title: "Infrastructure", items: [{ to: "/infrastructure", label: "Jobs and Services" }] },
	{
		title: "Accounts",
		items: [{ to: "/accounts", label: "Admin Accounts" }],
		superAdminOnly: true,
	},
];

export default function Layout() {
	const { account, signOut } = useSession();
	const theme = useTheme();

	function toggleTheme() {
		const next = theme === "dark" ? "light" : "dark";
		applyTheme(next);
		storeTheme(next);
	}

	return (
		<div className="flex min-h-screen bg-base-200">
			<aside className="w-60 shrink-0 border-r border-base-300 bg-base-100 px-3 py-5">
				<div className="mb-6 px-3">
					<div className="text-lg font-bold">Anthers Admin</div>
				</div>
				<nav className="space-y-5">
					{SECTIONS.filter((s) => !s.superAdminOnly || account?.isSuperAdmin).map((section) => (
						<div key={section.title}>
							<div className="mb-1 px-3 text-xs uppercase tracking-wide text-base-content/50">
								{section.title}
							</div>
							<ul className="menu menu-sm w-full p-0">
								{section.items.map((item) => (
									<li key={item.to}>
										<NavLink
											to={item.to}
											end={item.end}
											className={({ isActive }) => (isActive ? "menu-active" : "")}
										>
											{item.label}
										</NavLink>
									</li>
								))}
							</ul>
						</div>
					))}
				</nav>
			</aside>
			<div className="flex min-w-0 flex-1 flex-col">
				<header className="flex items-center justify-end gap-3 border-b border-base-300 bg-base-100 px-6 py-3 text-sm">
					<span className="text-base-content/70">
						{account?.displayName}
						{account?.isSuperAdmin && (
							<span className="badge badge-sm badge-ghost ml-2">Super-Admin</span>
						)}
					</span>
					<button
						type="button"
						className="btn btn-ghost btn-sm btn-square"
						onClick={toggleTheme}
						aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
					>
						{theme === "dark" ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
					</button>
					<button type="button" className="btn btn-ghost btn-sm" onClick={() => void signOut()}>
						Sign Out
					</button>
				</header>
				<main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
					<Outlet />
				</main>
			</div>
		</div>
	);
}
