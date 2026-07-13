// SPDX-License-Identifier: AGPL-3.0-or-later
import { MeadowFloor } from "@anthers/web-shared/decor/MeadowFloor";
import { FONTS } from "@anthers/web-shared/fonts";
import { Bars3Icon } from "@heroicons/react/24/outline";
import { Link, Outlet } from "react-router-dom";
import { useMediaPlayer } from "../../lib/media-player";
import MiniPlayer from "../media/MiniPlayer";
import ThemeToggle from "../ui/ThemeToggle";

const serif = { fontFamily: FONTS.fraunces };

// The Meadow footer nav — mirrors the header, plus a Support column. label → href.
const FOOTER_NAV: { title: string; links: [string, string][] }[] = [
	{
		title: "Discover",
		links: [
			["Browse Projects", "/discover"],
			["Jams", "/jams"],
		],
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

	return (
		<div className="min-h-screen flex flex-col">
			<header className="navbar bg-base-200/50 backdrop-blur-md px-4 sticky top-0 z-40">
				<div className="navbar-start gap-1">
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
								<Link to="/discover">Discover</Link>
							</li>
							<li>
								<Link to="/for-creators">For Creators</Link>
							</li>
							<li>
								<Link to="/subscribe">Subscribe</Link>
							</li>
							<li>
								<details>
									<summary>Compare</summary>
									<ul className="bg-base-200 z-50">
										<li>
											<Link to="/compare/itch-io">vs itch.io</Link>
										</li>
										<li>
											<Link to="/compare/ghost">vs Ghost</Link>
										</li>
									</ul>
								</details>
							</li>
							<li>
								<Link to="/about">About</Link>
							</li>
							<li>
								<Link to="/roadmap">Roadmap</Link>
							</li>
							<li>
								<Link to="/resources">Resources</Link>
							</li>
						</ul>
					</div>

					{/* Brand — links to the homepage */}
					<Link to="/" className="btn btn-ghost text-lg font-bold px-2">
						Anthers
					</Link>
				</div>

				{/* Desktop nav */}
				<div className="navbar-center hidden lg:flex">
					<ul className="menu menu-horizontal px-1 gap-1">
						<li>
							<Link to="/discover">Discover</Link>
						</li>
						<li>
							<Link to="/for-creators">For Creators</Link>
						</li>
						<li>
							<Link to="/subscribe">Subscribe</Link>
						</li>
						<li>
							<details>
								<summary>Compare</summary>
								<ul className="bg-base-200 z-50">
									<li>
										<Link to="/compare/itch-io">vs itch.io</Link>
									</li>
									<li>
										<Link to="/compare/ghost">vs Ghost</Link>
									</li>
								</ul>
							</details>
						</li>
						<li>
							<Link to="/about">About</Link>
						</li>
						<li>
							<Link to="/roadmap">Roadmap</Link>
						</li>
						<li>
							<Link to="/resources">Resources</Link>
						</li>
					</ul>
				</div>

				<div className="navbar-end">
					<div className="flex items-center gap-2">
						<ThemeToggle />
						<Link to="/login" className="btn btn-ghost btn-sm">
							Log in
						</Link>
						<Link to="/signup" className="btn btn-primary btn-sm">
							Sign up
						</Link>
					</div>
				</div>
			</header>

			<main className={`flex-1 ${currentTrack ? "pb-16" : ""}`}>
				<Outlet />
			</main>

			<MiniPlayer />

			{/* Meadow footer — transparent (no bg overlay), compact, sitting right atop
				the grassy floor below it. */}
			<footer
				className={`relative border-t border-base-content/10 px-6 pt-9 pb-2 text-sm ${currentTrack ? "mb-16" : ""}`}
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

			{/* The grassy meadow every logged-out page ends on. */}
			<MeadowFloor />
		</div>
	);
}
