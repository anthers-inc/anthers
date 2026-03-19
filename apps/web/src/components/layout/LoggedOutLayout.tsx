import { Link, Outlet } from "react-router-dom";
import { useMediaPlayer } from "../../lib/media-player";
import MiniPlayer from "../media/MiniPlayer";
import { Bars3Icon } from "@heroicons/react/24/outline";

export default function LoggedOutLayout() {
	const { currentTrack } = useMediaPlayer();

	return (
		<div className="min-h-screen flex flex-col">
			<header className="navbar bg-base-200/50 backdrop-blur-md px-4 sticky top-0 z-40">
				<div className="navbar-start">
					{/* Mobile menu */}
					<div className="dropdown lg:hidden">
						<label tabIndex={0} className="btn btn-ghost">
							<Bars3Icon className="w-5 h-5" />
						</label>
						<ul
							tabIndex={0}
							className="menu menu-sm dropdown-content mt-3 z-50 p-2 shadow bg-base-200 rounded-box w-52"
						>
							<li><Link to="/discover">Discover</Link></li>
							<li><Link to="/for-creators">For Creators</Link></li>
							<li><Link to="/for-users">For Users</Link></li>
							<li><Link to="/subscribe">Subscribe</Link></li>
							<li>
								<details>
									<summary>Compare</summary>
									<ul className="bg-base-200 z-50">
										<li><Link to="/compare/itch-io">vs itch.io</Link></li>
										<li><Link to="/compare/ghost">vs Ghost</Link></li>
									</ul>
								</details>
							</li>
							<li><Link to="/about">About</Link></li>
							<li><Link to="/roadmap">Roadmap</Link></li>
						</ul>
					</div>
				</div>

				{/* Desktop nav */}
				<div className="navbar-center hidden lg:flex">
					<ul className="menu menu-horizontal px-1 gap-1">
						<li><Link to="/discover">Discover</Link></li>
						<li><Link to="/for-creators">For Creators</Link></li>
						<li><Link to="/for-users">For Users</Link></li>
						<li><Link to="/subscribe">Subscribe</Link></li>
						<li>
							<details>
								<summary>Compare</summary>
								<ul className="bg-base-200 z-50">
									<li><Link to="/compare/itch-io">vs itch.io</Link></li>
									<li><Link to="/compare/ghost">vs Ghost</Link></li>
								</ul>
							</details>
						</li>
						<li><Link to="/about">About</Link></li>
						<li><Link to="/roadmap">Roadmap</Link></li>
					</ul>
				</div>

				<div className="navbar-end">
					<div className="flex gap-2">
						<Link to="/login" className="btn btn-ghost btn-sm">
							Log in
						</Link>
						<Link to="/register" className="btn btn-primary btn-sm">
							Sign up
						</Link>
					</div>
				</div>
			</header>

			<main className={`flex-1 ${currentTrack ? "pb-16" : ""}`}>
				<Outlet />
			</main>

			<MiniPlayer />

			<footer className={`bg-base-300/30 backdrop-blur-md text-base-content text-xs p-10 ${currentTrack ? "mb-16" : ""}`}>
				<div className="max-w-7xl mx-auto">
					<div className="join join-horizontal w-full">
						<nav className="join-item flex-1 flex flex-col items-center gap-1.5">
							<h6 className="footer-title text-xs">Discover</h6>
							<Link to="/discover" className="link link-hover">Browse Projects</Link>
							<Link to="/jams" className="link link-hover">Jams</Link>
						</nav>
						<nav className="join-item flex-1 flex flex-col items-center gap-1.5">
							<h6 className="footer-title text-xs">Creators</h6>
							<Link to="/for-creators" className="link link-hover">For Creators</Link>
							<Link to="/demo-creator-page" className="link link-hover">Creator Hubs</Link>
							<Link to="/demo-creator-breakdown" className="link link-hover">Creator Economics</Link>
						</nav>
						<nav className="join-item flex-1 flex flex-col items-center gap-1.5">
							<h6 className="footer-title text-xs">Users</h6>
							<Link to="/for-users" className="link link-hover">For Users</Link>
							<Link to="/subscribe" className="link link-hover">Subscribe</Link>
						</nav>
						<nav className="join-item flex-1 flex flex-col items-center gap-1.5">
							<h6 className="footer-title text-xs">Compare</h6>
							<Link to="/compare/itch-io" className="link link-hover">Anthers vs itch.io</Link>
							<Link to="/compare/ghost" className="link link-hover">Anthers vs Ghost</Link>
						</nav>
						<nav className="join-item flex-1 flex flex-col items-center gap-1.5">
							<h6 className="footer-title text-xs">About</h6>
							<Link to="/about" className="link link-hover">About Us</Link>
							<Link to="/faq" className="link link-hover">FAQ</Link>
							<Link to="/roadmap" className="link link-hover">Roadmap</Link>
							<Link to="/wiki" className="link link-hover">Wiki</Link>
						</nav>
					</div>
				</div>
			</footer>
		</div>
	);
}
