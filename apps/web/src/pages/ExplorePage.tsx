import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type PaginatedResponse, type ProjectListItem } from "../lib/api";
import ProjectCard from "../components/cards/ProjectCard";
import Pagination from "../components/ui/Pagination";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import EmptyState from "../components/ui/EmptyState";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";

const MEDIA_TYPES = [
  { value: "", label: "All" },
  { value: "game", label: "Games" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
  { value: "text", label: "Text" },
];

const SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "popular", label: "Popular" },
  { value: "top_rated", label: "Top Rated" },
  { value: "trending", label: "Trending" },
  { value: "downloads", label: "Most Downloads" },
];

export default function ExplorePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<PaginatedResponse<ProjectListItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState(searchParams.get("search") ?? "");

  const currentPage = parseInt(searchParams.get("page") ?? "1");
  const mediaType = searchParams.get("media_type") ?? "";
  const search = searchParams.get("search") ?? "";
  const sort = searchParams.get("sort") ?? "newest";

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("page", String(currentPage));
    if (mediaType) params.set("media_type", mediaType);
    if (search) params.set("search", search);
    if (sort && sort !== "newest") params.set("sort", sort);

    api
      .get<PaginatedResponse<ProjectListItem>>(
        `/api/v1/content/projects/?${params.toString()}`
      )
      .then(setData)
      .catch((err) => console.error("Failed to load projects:", err))
      .finally(() => setLoading(false));
  }, [currentPage, mediaType, search, sort]);

  const updateParams = (updates: Record<string, string>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value) {
        next.set(key, value);
      } else {
        next.delete(key);
      }
    }
    // Reset to page 1 when filters change
    if (!("page" in updates)) {
      next.delete("page");
    }
    setSearchParams(next);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    updateParams({ search: searchInput });
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-6">Explore</h1>

      {/* Search + Filters */}
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <form onSubmit={handleSearch} className="flex-1 flex gap-2">
          <input
            type="text"
            placeholder="Search projects..."
            className="input input-bordered flex-1"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <button type="submit" className="btn btn-primary">
            <MagnifyingGlassIcon className="w-5 h-5" />
          </button>
        </form>
        <select
          className="select select-bordered"
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

      {/* Media type tabs */}
      <div className="tabs tabs-boxed mb-6 w-fit">
        {MEDIA_TYPES.map((type) => (
          <button
            key={type.value}
            className={`tab ${mediaType === type.value ? "tab-active" : ""}`}
            onClick={() => updateParams({ media_type: type.value })}
          >
            {type.label}
          </button>
        ))}
      </div>

      {/* Results */}
      {loading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      ) : !data || data.results.length === 0 ? (
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {data.results.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
          <Pagination
            count={data.count}
            next={data.next}
            previous={data.previous}
            currentPage={currentPage}
            onPageChange={(page) => updateParams({ page: String(page) })}
          />
        </>
      )}
    </div>
  );
}
