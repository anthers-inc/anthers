import { Link, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { useMediaPlayer } from "../../lib/media-player";
import MiniPlayer from "../media/MiniPlayer";
import {
  Bars3Icon,
  UserCircleIcon,
} from "@heroicons/react/24/outline";

export default function LoggedInLayout() {
  const { user, signOut } = useAuth();
  const { currentTrack } = useMediaPlayer();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut();
    navigate("/");
  };

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
              <li><Link to="/home">Home</Link></li>
              <li><Link to="/discover">Discover</Link></li>
              <li><Link to="/jams">Jams</Link></li>
              <li><Link to="/library">Library</Link></li>
              {user?.isCreator && (
                <>
                  <div className="divider my-0 px-2" />
                  <li><Link to="/dashboard">Dashboard</Link></li>
                  <li><Link to="/dashboard/analytics">Analytics</Link></li>
                </>
              )}
            </ul>
          </div>
          <Link to="/home" className="btn btn-ghost text-xl">
            Anthers
          </Link>
        </div>

        {/* Desktop nav */}
        <div className="navbar-center hidden lg:flex">
          <ul className="menu menu-horizontal px-1 gap-1">
            <li><Link to="/discover">Discover</Link></li>
            <li><Link to="/jams">Jams</Link></li>
            <li><Link to="/library">Library</Link></li>
            {user?.isCreator && (
              <li>
                <details>
                  <summary>Creator</summary>
                  <ul className="bg-base-200 z-50">
                    <li><Link to="/dashboard">Dashboard</Link></li>
                    <li><Link to="/dashboard/analytics">Analytics</Link></li>
                  </ul>
                </details>
              </li>
            )}
          </ul>
        </div>

        <div className="navbar-end">
          <div className="dropdown dropdown-end">
            <label tabIndex={0} className="btn btn-ghost btn-circle">
              {user?.avatar ? (
                <img
                  src={user.avatar}
                  alt={user?.displayName || user?.username}
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
              <div className="divider my-0 px-2" />
              <li><Link to="/subscription">Subscription</Link></li>
              <li><Link to={`/${user?.username}`}>Profile</Link></li>
              <li><Link to="/settings">Settings</Link></li>
              <div className="divider my-0 px-2" />
              <li>
                <button onClick={handleLogout}>Log out</button>
              </li>
            </ul>
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
              <h6 className="footer-title text-xs">Your Stuff</h6>
              <Link to="/home" className="link link-hover">Home Feed</Link>
              <Link to="/library" className="link link-hover">Library</Link>
              <Link to="/subscription" className="link link-hover">Subscription</Link>
            </nav>
            <nav className="join-item flex-1 flex flex-col items-center gap-1.5">
              <h6 className="footer-title text-xs">About</h6>
              <Link to="/about" className="link link-hover">About Us</Link>
              <Link to="/faq" className="link link-hover">FAQ</Link>
              <Link to="/wiki" className="link link-hover">Wiki</Link>
            </nav>
          </div>
        </div>
      </footer>
    </div>
  );
}
