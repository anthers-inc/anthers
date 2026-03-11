import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { useMediaPlayer } from "../../lib/media-player";
import { SidebarProvider, useSidebar } from "./SidebarContext";
import SearchBar from "./SearchBar";
import MiniPlayer from "../media/MiniPlayer";
import {
  Bars3Icon,
  UserCircleIcon,
  RssIcon,
  RectangleStackIcon,
  MagnifyingGlassIcon,
  TrophyIcon,
  ChartBarIcon,
  Squares2X2Icon,
} from "@heroicons/react/24/outline";

/** Primary nav links that appear in the sidebar for all logged-in pages */
const NAV_LINKS = [
  { to: "/feed", label: "Feed", icon: RssIcon },
  { to: "/library", label: "Library", icon: RectangleStackIcon },
  { to: "/discover", label: "Discover", icon: MagnifyingGlassIcon },
  { to: "/jams", label: "Jams", icon: TrophyIcon },
] as const;

const CREATOR_LINKS = [
  { to: "/dashboard", label: "Dashboard", icon: Squares2X2Icon },
  { to: "/dashboard/analytics", label: "Analytics", icon: ChartBarIcon },
] as const;

function LoggedInLayoutInner() {
  const { user, signOut } = useAuth();
  const { currentTrack } = useMediaPlayer();
  const { sidebarOpen, toggleSidebar, pageContent } = useSidebar();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut();
    navigate("/");
  };

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
      isActive
        ? "bg-primary/10 text-primary font-medium"
        : "text-base-content/70 hover:bg-base-300/50 hover:text-base-content"
    }`;

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Top bar — simplified: brand + hamburger on left, avatar on right */}
      <header className="navbar bg-base-200/50 backdrop-blur-md px-4 sticky top-0 z-40 h-14 min-h-0">
        <div className="navbar-start gap-1">
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-square"
            onClick={toggleSidebar}
            aria-label="Toggle sidebar"
          >
            <Bars3Icon className="w-5 h-5" />
          </button>
          <Link to="/feed" className="btn btn-ghost text-lg font-bold px-2">
            Anthers
          </Link>
        </div>

        <div className="navbar-center flex-1 px-4 hidden sm:flex">
          <SearchBar />
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

      {/* Body: sidebar + main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Persistent sidebar */}
        <aside
          className={`${sidebarOpen ? "w-64" : "w-0"} shrink-0 transition-all duration-200 overflow-hidden border-r border-base-300/50 bg-base-100`}
        >
          <div className="w-64 h-full flex flex-col overflow-y-auto">
            {/* Persistent nav section */}
            <nav className="p-3 flex flex-col gap-0.5">
              {NAV_LINKS.map((link) => (
                <NavLink key={link.to} to={link.to} className={navLinkClass}>
                  <link.icon className="w-5 h-5 shrink-0" />
                  {link.label}
                </NavLink>
              ))}

              {/* Creator section */}
              {user?.isCreator && (
                <>
                  <div className="divider my-1 px-1 text-xs text-base-content/30">Creator</div>
                  {CREATOR_LINKS.map((link) => (
                    <NavLink key={link.to} to={link.to} className={navLinkClass}>
                      <link.icon className="w-5 h-5 shrink-0" />
                      {link.label}
                    </NavLink>
                  ))}
                </>
              )}
            </nav>

            {/* Page-specific sidebar content */}
            {pageContent && (
              <>
                <div className="divider my-0 mx-3" />
                <div className="flex-1 p-3 overflow-y-auto">
                  {pageContent}
                </div>
              </>
            )}
          </div>
        </aside>

        {/* Main content area */}
        <main className={`flex-1 min-w-0 overflow-y-auto ${currentTrack ? "pb-16" : ""}`}>
          <Outlet />

          {/* Footer */}
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
                  <Link to="/feed" className="link link-hover">Feed</Link>
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
        </main>
      </div>

      <MiniPlayer />
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
