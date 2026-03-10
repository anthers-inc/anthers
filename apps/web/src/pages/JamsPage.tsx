import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { GameJamListItem, PaginatedResponse } from "../lib/api";
import { useAuth } from "../lib/auth";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import EmptyState from "../components/ui/EmptyState";
import { PlusIcon, CalendarIcon, ClockIcon } from "@heroicons/react/24/outline";

const STATUS_TABS = [
  { value: "", label: "All" },
  { value: "upcoming", label: "Upcoming" },
  { value: "active", label: "Active" },
  { value: "voting", label: "Voting" },
  { value: "ended", label: "Ended" },
];

function JamStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    upcoming: "badge-info",
    active: "badge-success",
    voting: "badge-warning",
    ended: "badge-ghost",
  };
  return (
    <span className={`badge badge-sm ${styles[status] || "badge-ghost"}`}>
      {status}
    </span>
  );
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const sameMonth =
    s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
  if (sameMonth) {
    return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${e.getDate()}, ${e.getFullYear()}`;
  }
  return `${formatDate(start)} – ${formatDate(end)}`;
}

function JamCard({ jam }: { jam: GameJamListItem }) {
  return (
    <Link
      to={`/jams/${jam.slug}`}
      className="card bg-base-200 hover:bg-base-300 transition-colors"
    >
      {jam.cover_image && (
        <figure className="h-40">
          <img
            src={jam.cover_image}
            alt={jam.title}
            className="w-full h-full object-cover"
          />
        </figure>
      )}
      <div className="card-body p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="card-title text-base">{jam.title}</h2>
          <JamStatusBadge status={jam.status} />
        </div>
        <div className="flex flex-col gap-1 text-sm text-base-content/60">
          <div className="flex items-center gap-1.5">
            <CalendarIcon className="w-3.5 h-3.5" />
            <span>{formatDateRange(jam.start_at, jam.end_at)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <ClockIcon className="w-3.5 h-3.5" />
            <span>Voting until {formatDate(jam.voting_end_at)}</span>
          </div>
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs text-base-content/40">
            by {jam.creator_username}
          </span>
          <span className="text-xs text-base-content/50">
            {jam.entry_count} {jam.entry_count === 1 ? "entry" : "entries"}
          </span>
        </div>
      </div>
    </Link>
  );
}

export default function JamsPage() {
  const { user } = useAuth();
  const [statusFilter, setStatusFilter] = useState("");
  const [jams, setJams] = useState<GameJamListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = statusFilter ? `?status=${statusFilter}` : "";
    api
      .get<PaginatedResponse<GameJamListItem>>(`/api/v1/jams/${params}`)
      .then((data) => setJams(data.results))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [statusFilter]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Game Jams</h1>
        {user?.isCreator && (
          <Link to="/dashboard/jams/new" className="btn btn-primary btn-sm">
            <PlusIcon className="w-4 h-4" />
            Host a Jam
          </Link>
        )}
      </div>

      {/* Status tabs */}
      <div className="tabs tabs-boxed mb-6">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            className={`tab ${statusFilter === tab.value ? "tab-active" : ""}`}
            onClick={() => setStatusFilter(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      ) : jams.length === 0 ? (
        <EmptyState
          title="No jams found"
          description={
            statusFilter
              ? `No ${statusFilter} jams right now.`
              : "No game jams have been created yet."
          }
          action={
            user?.isCreator ? (
              <Link
                to="/dashboard/jams/new"
                className="btn btn-primary btn-sm"
              >
                Host the First Jam
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {jams.map((jam) => (
            <JamCard key={jam.id} jam={jam} />
          ))}
        </div>
      )}
    </div>
  );
}
