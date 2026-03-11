import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { client } from "../lib/rpc";
import type { Project, PostListItem, PublicUser } from "../lib/types";
import ProjectCard from "../components/cards/ProjectCard";
import ContentCard from "../components/cards/ContentCard";
import CreatorCard from "../components/cards/CreatorCard";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import EmptyState from "../components/ui/EmptyState";
import {
  Bars3Icon,
  RssIcon,
  RocketLaunchIcon,
  UserGroupIcon,
  BookmarkIcon,
  BellIcon,
  InformationCircleIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";

// Placeholder feed selector tabs — will be dynamic when custom feeds ship
const FEED_TABS = [
  { id: "default", label: "For You" },
  { id: "following", label: "Following" },
  { id: "network", label: "Network" },
] as const;

export default function AuthenticatedHomePage() {
  const { user } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [feedTab, setFeedTab] = useState<string>("default");
  const [feedPosts, setFeedPosts] = useState<PostListItem[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [creators, setCreators] = useState<PublicUser[]>([]);
  const [feedLoading, setFeedLoading] = useState(true);
  const [showFeedInfo, setShowFeedInfo] = useState(false);

  useEffect(() => {
    // Fetch the user's feed
    client.api.accounts.me.feed
      .$get()
      .then((res) => res.json())
      .then((data) =>
        setFeedPosts((data as { posts: PostListItem[] }).posts),
      )
      .catch(() => {})
      .finally(() => setFeedLoading(false));

    // Fetch featured projects for discovery section
    client.api.content.projects
      .$get()
      .then((res) => res.json())
      .then((data) => setProjects(data.projects.slice(0, 8)))
      .catch(() => {});

    // Fetch creators for discovery section
    client.api.accounts.creators
      .$get()
      .then((res) => res.json())
      .then((data) => setCreators(data.creators.slice(0, 4)))
      .catch(() => {});
  }, []);

  return (
    <div className="flex min-h-[calc(100vh-4rem)]">
      {/* Sidebar */}
      <aside
        className={`${sidebarOpen ? "w-64" : "w-0"} shrink-0 transition-all duration-200 overflow-hidden border-r border-base-300/50`}
      >
        <div className="w-64 p-4 flex flex-col gap-6 h-full overflow-y-auto">
          {/* Bookmarks / Favorites */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5">
              <BookmarkIcon className="w-3.5 h-3.5" />
              Bookmarks
            </h3>
            <ul className="menu menu-sm p-0 gap-0.5">
              <li>
                <span className="text-base-content/40 text-xs italic">
                  No bookmarks yet
                </span>
              </li>
            </ul>
            <p className="text-xs text-base-content/30 mt-1">
              Bookmark posts, projects, and creators to find them here.
            </p>
          </section>

          {/* Following / Subscriptions */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5">
              <UserGroupIcon className="w-3.5 h-3.5" />
              Following
            </h3>
            <ul className="menu menu-sm p-0 gap-0.5">
              <li>
                <span className="text-base-content/40 text-xs italic">
                  Not following anyone yet
                </span>
              </li>
            </ul>
            <Link
              to="/discover"
              className="text-xs link link-primary mt-1 block"
            >
              Discover creators
            </Link>
          </section>

          {/* New Releases */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5">
              <BellIcon className="w-3.5 h-3.5" />
              New Releases
            </h3>
            <ul className="menu menu-sm p-0 gap-0.5">
              <li>
                <span className="text-base-content/40 text-xs italic">
                  Nothing new right now
                </span>
              </li>
            </ul>
            <p className="text-xs text-base-content/30 mt-1">
              New content from creators you follow shows up here.
            </p>
          </section>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 min-w-0">
        {/* Feed header */}
        <div className="sticky top-16 z-30 bg-base-100/80 backdrop-blur-md border-b border-base-300/50">
          <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-square"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              aria-label="Toggle sidebar"
            >
              <Bars3Icon className="w-5 h-5" />
            </button>

            <div className="flex-1 flex items-center gap-2">
              <h1 className="text-lg font-bold">Home</h1>
              <button
                type="button"
                className="btn btn-ghost btn-xs btn-circle"
                onClick={() => setShowFeedInfo(!showFeedInfo)}
                aria-label="How does the feed work?"
              >
                <InformationCircleIcon className="w-4 h-4 text-base-content/40" />
              </button>
            </div>

            {/* Feed selector tabs */}
            <div className="tabs tabs-boxed tabs-sm bg-base-200/50">
              {FEED_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`tab tab-sm ${feedTab === tab.id ? "tab-active" : ""}`}
                  onClick={() => setFeedTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
              <button
                type="button"
                className="tab tab-sm text-base-content/40"
                title="Custom feeds coming soon"
                disabled
              >
                +
              </button>
            </div>
          </div>

          {/* Feed info panel */}
          {showFeedInfo && (
            <div className="max-w-4xl mx-auto px-4 pb-3">
              <div className="bg-base-200 rounded-lg p-4 text-sm relative">
                <button
                  type="button"
                  className="btn btn-ghost btn-xs btn-circle absolute top-2 right-2"
                  onClick={() => setShowFeedInfo(false)}
                >
                  <XMarkIcon className="w-4 h-4" />
                </button>
                <p className="font-semibold mb-2">How does your feed work?</p>
                <p className="text-base-content/70 mb-2">
                  Your feed shows content in three layers, blended by recency:
                </p>
                <ul className="text-base-content/60 space-y-1 text-xs">
                  <li>
                    <strong className="text-base-content/80">Primary:</strong>{" "}
                    Posts from creators you follow and support
                  </li>
                  <li>
                    <strong className="text-base-content/80">Network:</strong>{" "}
                    Things your follows have liked, shared, or purchased
                  </li>
                  <li>
                    <strong className="text-base-content/80">Ambient:</strong>{" "}
                    Content matching your interests (tags, jams) -- never paid promotion
                  </li>
                </ul>
                <p className="text-base-content/40 text-xs mt-2">
                  Anthers does not use engagement-optimizing algorithms.{" "}
                  <Link to="/faq" className="link link-primary">
                    Learn more
                  </Link>
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Feed content */}
        <div className="max-w-4xl mx-auto px-4 py-6">
          <p className="text-base-content/50 text-sm mb-6">
            The latest and greatest from your network.
          </p>

          {feedLoading ? (
            <div className="flex justify-center py-16">
              <LoadingSpinner size="lg" />
            </div>
          ) : feedPosts.length > 0 ? (
            <div className="flex flex-col gap-4">
              {feedPosts.map((post) => (
                <ContentCard key={post.id} post={post} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<RssIcon className="w-12 h-12" />}
              title="Your feed is empty"
              description="Follow creators to see their latest posts here. Content from your network -- things your follows like, share, and purchase -- will also appear."
              action={
                <Link to="/discover" className="btn btn-primary btn-sm">
                  Discover creators
                </Link>
              }
            />
          )}
        </div>

        {/* Discovery sections (below the feed) */}
        {projects.length > 0 && (
          <section className="py-8 px-4 bg-base-200/30 border-t border-base-300/30">
            <div className="max-w-4xl mx-auto">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <RocketLaunchIcon className="w-5 h-5 text-primary" />
                  Discover Projects
                </h2>
                <Link to="/discover" className="btn btn-ghost btn-sm">
                  View all
                </Link>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {projects.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </div>
            </div>
          </section>
        )}

        {creators.length > 0 && (
          <section className="py-8 px-4">
            <div className="max-w-4xl mx-auto">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <UserGroupIcon className="w-5 h-5 text-secondary" />
                  Creators to Follow
                </h2>
                <Link to="/discover" className="btn btn-ghost btn-sm">
                  View all
                </Link>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {creators.map((c) => (
                  <CreatorCard key={c.id} creator={c} />
                ))}
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
