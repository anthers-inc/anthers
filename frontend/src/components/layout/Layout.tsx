import { Link, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { useMediaPlayer } from "../../lib/media-player";
import MiniPlayer from "../media/MiniPlayer";
import {
  Bars3Icon,
  UserCircleIcon,
} from "@heroicons/react/24/outline";

export default function Layout() {
  const { user, isAuthenticated, logout } = useAuth();
  const { currentTrack } = useMediaPlayer();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate("/");
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="navbar bg-base-200 px-4">
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
              <li><Link to="/explore">Explore</Link></li>
              <li><Link to="/creators">Creators</Link></li>
              <li><Link to="/posts">Posts</Link></li>
              <li><Link to="/jams">Jams</Link></li>
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
              {isAuthenticated && <li><Link to="/feed">Feed</Link></li>}
              {isAuthenticated && <li><Link to="/library">Library</Link></li>}
            </ul>
          </div>
          <Link to="/" className="btn btn-ghost text-xl">
            Bluebell
          </Link>
        </div>

        {/* Desktop nav */}
        <div className="navbar-center hidden lg:flex">
          <ul className="menu menu-horizontal px-1 gap-1">
            <li><Link to="/explore">Explore</Link></li>
            <li><Link to="/creators">Creators</Link></li>
            <li><Link to="/posts">Posts</Link></li>
            <li><Link to="/jams">Jams</Link></li>
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
            {isAuthenticated && <li><Link to="/feed">Feed</Link></li>}
            {isAuthenticated && <li><Link to="/library">Library</Link></li>}
          </ul>
        </div>

        <div className="navbar-end">
          {isAuthenticated ? (
            <div className="dropdown dropdown-end">
              <label tabIndex={0} className="btn btn-ghost btn-circle">
                {user?.avatar ? (
                  <img
                    src={user.avatar}
                    alt={user.display_name || user.username}
                    className="w-8 h-8 rounded-full object-cover"
                  />
                ) : (
                  <UserCircleIcon className="w-8 h-8" />
                )}
              </label>
              <ul
                tabIndex={0}
                className="menu menu-sm dropdown-content mt-3 z-50 p-2 shadow bg-base-200 rounded-box w-52"
              >
                <li className="menu-title px-4 py-1">
                  <span className="text-xs text-base-content/50">
                    @{user?.username}
                  </span>
                </li>
                <li><Link to="/dashboard">Dashboard</Link></li>
                <li><Link to="/subscription">Subscription</Link></li>
                <li><Link to={`/${user?.username}`}>My Profile</Link></li>
                <li><Link to="/settings">Settings</Link></li>
                <li>
                  <button onClick={handleLogout}>Log out</button>
                </li>
              </ul>
            </div>
          ) : (
            <div className="flex gap-2">
              <Link to="/login" className="btn btn-ghost btn-sm">
                Log in
              </Link>
              <Link to="/register" className="btn btn-primary btn-sm">
                Sign up
              </Link>
            </div>
          )}
        </div>
      </header>

      <main className={`flex-1 ${currentTrack ? "pb-16" : ""}`}>
        <Outlet />
      </main>

      <MiniPlayer />

      <footer className={`bg-base-200 text-base-content p-10 ${currentTrack ? "mb-16" : ""}`}>
        <div className="max-w-4xl mx-auto">
          <div className="join join-horizontal w-full">
            <nav className="join-item flex-1 flex flex-col items-center gap-2">
              <h6 className="footer-title">Platform</h6>
              <Link to="/for-creators" className="link link-hover">For Creators</Link>
              <Link to="/creator-demo" className="link link-hover">Creator Hubs</Link>
              <Link to="/for-users" className="link link-hover">For Users</Link>
              <Link to="/subscribe" className="link link-hover">Subscribe</Link>
              <Link to="/explore" className="link link-hover">Explore</Link>
            </nav>
            <nav className="join-item flex-1 flex flex-col items-center gap-2">
              <h6 className="footer-title">Compare</h6>
              <Link to="/compare/itch-io" className="link link-hover">Bluebell vs itch.io</Link>
              <Link to="/compare/ghost" className="link link-hover">Bluebell vs Ghost</Link>
            </nav>
            <nav className="join-item flex-1 flex flex-col items-center gap-2">
              <h6 className="footer-title">Community</h6>
              <Link to="/creators" className="link link-hover">Creators</Link>
              <Link to="/jams" className="link link-hover">Game Jams</Link>
              <Link to="/posts" className="link link-hover">Posts</Link>
            </nav>
          </div>
          <div className="mt-8 text-center">
            <h6 className="footer-title justify-center">About</h6>
            <p className="text-sm text-base-content/50">
              Bluebell — Creator-first, transparent, federated.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
