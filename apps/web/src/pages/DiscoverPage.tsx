import { useEffect, useState, useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { client } from "../lib/rpc";
import type { Project, PublicUser } from "../lib/types";
import { useSidebar } from "../components/layout/SidebarContext";
import ProjectCard from "../components/cards/ProjectCard";
import CreatorCard from "../components/cards/CreatorCard";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import EmptyState from "../components/ui/EmptyState";
import {
  MagnifyingGlassIcon,
  InboxIcon,
  GlobeAltIcon,
  BoltIcon,
  MusicalNoteIcon,
  VideoCameraIcon,
  PencilSquareIcon,
  PuzzlePieceIcon,
  CubeTransparentIcon,
  FunnelIcon,
} from "@heroicons/react/24/outline";

// Exploration modes
const EXPLORE_MODES = [
  {
    id: "browse",
    label: "Browse",
    icon: MagnifyingGlassIcon,
    description: "Search and filter all content",
  },
  {
    id: "inbox",
    label: "Inbox",
    icon: InboxIcon,
    description: "Content shared with you by friends and creators",
  },
  {
    id: "network",
    label: "Network",
    icon: GlobeAltIcon,
    description: "Discover creators connected to your network",
  },
  {
    id: "ticker",
    label: "Ticker",
    icon: BoltIcon,
    description: "Real-time live feed of new content",
  },
] as const;

// Content type filters
const CONTENT_TYPES = [
  { id: "", label: "All", icon: CubeTransparentIcon },
  { id: "game", label: "Games", icon: PuzzlePieceIcon },
  { id: "audio", label: "Music", icon: MusicalNoteIcon },
  { id: "video", label: "Video", icon: VideoCameraIcon },
  { id: "text", label: "Writing", icon: PencilSquareIcon },
] as const;

// Sort options
const SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "popular", label: "Popular" },
  { value: "top_rated", label: "Top Rated" },
  { value: "trending", label: "Trending" },
] as const;

// Pricing filters
const PRICING_FILTERS = [
  { id: "", label: "Any price" },
  { id: "free", label: "Free" },
  { id: "paid", label: "Paid" },
  { id: "pay_what_you_want", label: "Pay what you want" },
] as const;

function DiscoverSidebarContent({
  exploreMode,
  contentType,
  pricing,
  onUpdateParams,
}: {
  exploreMode: string;
  contentType: string;
  pricing: string;
  onUpdateParams: (updates: Record<string, string>) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      {/* Exploration mode */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2">
          Explore
        </h3>
        <ul className="menu menu-sm p-0 gap-0.5">
          {EXPLORE_MODES.map((mode) => (
            <li key={mode.id}>
              <button
                type="button"
                className={exploreMode === mode.id ? "active" : ""}
                onClick={() => onUpdateParams({ mode: mode.id === "browse" ? "" : mode.id })}
                title={mode.description}
              >
                <mode.icon className="w-4 h-4" />
                {mode.label}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* Content type */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2">
          Content Type
        </h3>
        <ul className="menu menu-sm p-0 gap-0.5">
          {CONTENT_TYPES.map((type) => (
            <li key={type.id}>
              <button
                type="button"
                className={contentType === type.id ? "active" : ""}
                onClick={() => onUpdateParams({ media_type: type.id })}
              >
                <type.icon className="w-4 h-4" />
                {type.label}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* Filters (shown for browse mode) */}
      {exploreMode === "browse" && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5">
            <FunnelIcon className="w-3.5 h-3.5" />
            Filters
          </h3>

          {/* Pricing */}
          <div className="mb-3">
            <label className="text-xs text-base-content/50 mb-1 block">
              Pricing
            </label>
            <select
              className="select select-bordered select-xs w-full"
              value={pricing}
              onChange={(e) => onUpdateParams({ pricing: e.target.value })}
            >
              {PRICING_FILTERS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>

          {/* Type-specific filters placeholder */}
          {contentType === "game" && (
            <div className="mb-3">
              <label className="text-xs text-base-content/50 mb-1 block">
                Platform
              </label>
              <select className="select select-bordered select-xs w-full">
                <option value="">Any platform</option>
                <option value="web">Browser</option>
                <option value="windows">Windows</option>
                <option value="mac">macOS</option>
                <option value="linux">Linux</option>
              </select>
            </div>
          )}

          {contentType === "audio" && (
            <div className="mb-3">
              <label className="text-xs text-base-content/50 mb-1 block">
                Duration
              </label>
              <select className="select select-bordered select-xs w-full">
                <option value="">Any length</option>
                <option value="short">Under 5 min</option>
                <option value="medium">5-30 min</option>
                <option value="long">Over 30 min</option>
              </select>
            </div>
          )}

          {contentType === "video" && (
            <div className="mb-3">
              <label className="text-xs text-base-content/50 mb-1 block">
                Duration
              </label>
              <select className="select select-bordered select-xs w-full">
                <option value="">Any length</option>
                <option value="short">Under 10 min</option>
                <option value="medium">10-60 min</option>
                <option value="long">Over 1 hour</option>
              </select>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export default function DiscoverPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { setPageContent } = useSidebar();
  const [projects, setProjects] = useState<Project[]>([]);
  const [creators, setCreators] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState(
    searchParams.get("search") ?? "",
  );

  const exploreMode = searchParams.get("mode") ?? "browse";
  const contentType = searchParams.get("media_type") ?? "";
  const search = searchParams.get("search") ?? "";
  const sort = searchParams.get("sort") ?? "newest";
  const pricing = searchParams.get("pricing") ?? "";

  const updateParams = useCallback(
    (updates: Record<string, string>) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(updates)) {
          if (value) {
            next.set(key, value);
          } else {
            next.delete(key);
          }
        }
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  // Register page-specific sidebar content
  useEffect(() => {
    setPageContent(
      <DiscoverSidebarContent
        exploreMode={exploreMode}
        contentType={contentType}
        pricing={pricing}
        onUpdateParams={updateParams}
      />,
    );
    return () => setPageContent(null);
  }, [setPageContent, exploreMode, contentType, pricing, updateParams]);

  useEffect(() => {
    if (exploreMode !== "browse") return;

    setLoading(true);
    const params = new URLSearchParams();
    if (contentType) params.set("media_type", contentType);
    if (search) params.set("search", search);
    if (sort && sort !== "newest") params.set("sort", sort);

    const apiBase =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1"
        ? "http://localhost:8000"
        : "";

    fetch(`${apiBase}/api/content/projects?${params.toString()}`, {
      credentials: "include",
    })
      .then((res) => res.json())
      .then((json) => setProjects(json.projects))
      .catch(() => {})
      .finally(() => setLoading(false));

    // Also fetch creators for the "browse" view
    client.api.accounts.creators
      .$get()
      .then((res) => res.json())
      .then((data) => setCreators(data.creators))
      .catch(() => {});
  }, [exploreMode, contentType, search, sort]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    updateParams({ search: searchInput });
  };

  const renderBrowseContent = () => (
    <>
      {/* Search bar */}
      <form onSubmit={handleSearch} className="flex gap-2 mb-6">
        <input
          type="text"
          placeholder="Search projects, creators, posts..."
          className="input input-bordered flex-1"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <button type="submit" className="btn btn-primary">
          <MagnifyingGlassIcon className="w-5 h-5" />
        </button>
      </form>

      {/* Sort selector (inline) */}
      <div className="flex items-center gap-2 mb-6">
        <span className="text-sm text-base-content/50">Sort by</span>
        <select
          className="select select-bordered select-sm"
          value={sort}
          onChange={(e) => updateParams({ sort: e.target.value })}
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Results */}
      {loading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects found"
          description={
            search
              ? `No results for "${search}". Try a different search term.`
              : "No projects have been published yet."
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>

          {/* Creators section in browse mode */}
          {creators.length > 0 && !search && (
            <section className="border-t border-base-300/30 pt-8">
              <h2 className="text-lg font-semibold mb-4">Creators</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {creators.slice(0, 6).map((creator) => (
                  <CreatorCard key={creator.id} creator={creator} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </>
  );

  const renderInboxContent = () => (
    <div className="py-8">
      <EmptyState
        icon={<InboxIcon className="w-12 h-12" />}
        title="Your inbox is empty"
        description="When friends or creators share content with you, it will appear here. You can control who can send to your inbox in Settings."
      />
    </div>
  );

  const renderNetworkContent = () => (
    <div className="py-8">
      <div className="text-center max-w-lg mx-auto">
        <GlobeAltIcon className="w-16 h-16 mx-auto text-base-content/20 mb-4" />
        <h3 className="text-lg font-semibold mb-2">Creator Network Map</h3>
        <p className="text-sm text-base-content/60 mb-4">
          An interactive network visualization showing creators connected to the
          people you already follow. Creators followed by many of your follows
          are highlighted -- discover new favorites through your existing
          relationships.
        </p>
        <div className="bg-base-200 rounded-xl p-12 mb-4">
          <div className="flex items-center justify-center gap-2 text-base-content/30">
            <GlobeAltIcon className="w-8 h-8" />
            <span className="text-sm">Network graph coming soon</span>
          </div>
        </div>
        <p className="text-xs text-base-content/40">
          Powered by force-directed graph layout. Follow more creators to make
          the network richer.
        </p>
      </div>
    </div>
  );

  const renderTickerContent = () => (
    <div className="py-8">
      <div className="text-center max-w-lg mx-auto">
        <BoltIcon className="w-16 h-16 mx-auto text-base-content/20 mb-4" />
        <h3 className="text-lg font-semibold mb-2">Live Ticker</h3>
        <p className="text-sm text-base-content/60 mb-4">
          A real-time feed of content as it arrives on the platform. No
          filters, no rankings -- just the raw stream of new projects, posts,
          and updates from every creator on Anthers.
        </p>
        <div className="bg-base-200 rounded-xl p-12">
          <div className="flex items-center justify-center gap-2 text-base-content/30">
            <BoltIcon className="w-8 h-8 animate-pulse" />
            <span className="text-sm">Live ticker coming soon</span>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-full">
      {/* Page content */}
      <div className="max-w-5xl mx-auto px-4 py-6">
        {exploreMode === "browse" && renderBrowseContent()}
        {exploreMode === "inbox" && renderInboxContent()}
        {exploreMode === "network" && renderNetworkContent()}
        {exploreMode === "ticker" && renderTickerContent()}
      </div>
    </div>
  );
}
