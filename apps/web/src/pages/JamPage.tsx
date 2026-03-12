import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { client } from "../lib/rpc";
import type {
  GameJam,
  JamEntry,
  JamEntryResult,
  Project,
} from "../lib/types";
import { useAuth } from "../lib/auth";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import StarRating from "../components/ui/StarRating";
import EmptyState from "../components/ui/EmptyState";
import {
  CalendarIcon,
  TrophyIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";

const apiBase =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
    ? "http://localhost:8000"
    : "";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function JamStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    upcoming: "badge-info",
    active: "badge-success",
    voting: "badge-warning",
    ended: "badge-ghost",
  };
  return (
    <span className={`badge ${styles[status] || "badge-ghost"}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function EntryCard({
  entry,
  showVoting,
  onVote,
}: {
  entry: JamEntry | JamEntryResult;
  showVoting: boolean;
  onVote?: (entryId: number, score: number) => void;
}) {
  const rank = "rank" in entry ? (entry as JamEntryResult).rank : null;

  return (
    <div className="card bg-base-200">
      {entry.project?.coverImage && (
        <figure className="h-32">
          <img
            src={entry.project.coverImage}
            alt={entry.project?.title}
            className="w-full h-full object-cover"
          />
        </figure>
      )}
      <div className="card-body p-4">
        {rank !== null && (
          <div className="flex items-center gap-1 mb-1">
            <TrophyIcon
              className={`w-4 h-4 ${rank <= 3 ? "text-warning" : "text-base-content/30"}`}
            />
            <span className="font-bold text-sm">#{rank}</span>
          </div>
        )}
        <Link
          to={`/${entry.submitter?.username ?? "unknown"}/${entry.project?.slug}`}
          className="link link-hover font-semibold text-sm"
        >
          {entry.project?.title}
        </Link>
        <p className="text-xs text-base-content/50">
          by {entry.submitter?.username}
        </p>
        <div className="flex items-center justify-between mt-2">
          <div className="text-xs text-base-content/50">
            {entry.voteCount} {entry.voteCount === 1 ? "vote" : "votes"}
            {entry.avgScore !== null && entry.avgScore !== undefined && (
              <span> · avg {entry.avgScore}</span>
            )}
          </div>
          {showVoting && onVote && (
            <StarRating
              rating={null}
              interactive
              onRate={(score: number) => onVote(entry.id, score)}
              size="sm"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SubmitEntryForm({
  jamSlug,
  onSubmitted,
}: {
  jamSlug: string;
  onSubmitted: () => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${apiBase}/api/content/projects?mine=true`, {
      credentials: "include",
    })
      .then((res) => res.json())
      .then((data: { projects: Project[] }) =>
        setProjects(data.projects.filter((p) => p.isPublished)),
      )
      .finally(() => setLoading(false));
  }, []);

  const handleSubmit = async () => {
    if (!selectedProject) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await client.api.jams[":slug"].entries.$post({
        param: { slug: jamSlug },
        json: { projectId: selectedProject },
      });
      if (!res.ok) {
        const data = (await res.json()) as { detail?: string };
        throw new Error(data?.detail ?? "Failed to submit entry.");
      }
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <LoadingSpinner size="sm" />;
  if (projects.length === 0) {
    return (
      <p className="text-sm text-base-content/50">
        You need a published project to submit.{" "}
        <Link to="/dashboard/projects/new" className="link">
          Create one
        </Link>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <div className="alert alert-error text-sm">
          <span>{error}</span>
        </div>
      )}
      <div className="flex gap-2">
        <select
          className="select select-bordered select-sm flex-1"
          value={selectedProject ?? ""}
          onChange={(e) =>
            setSelectedProject(e.target.value ? parseInt(e.target.value) : null)
          }
        >
          <option value="">Select a project...</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <button
          className="btn btn-primary btn-sm"
          onClick={handleSubmit}
          disabled={!selectedProject || submitting}
        >
          {submitting ? "Submitting..." : "Submit"}
        </button>
      </div>
    </div>
  );
}

export default function JamPage() {
  const { slug } = useParams<{ slug: string }>();
  const { user, isAuthenticated } = useAuth();
  const [jam, setJam] = useState<(GameJam & { status: string }) | null>(null);
  const [entries, setEntries] = useState<JamEntry[]>([]);
  const [results, setResults] = useState<JamEntryResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = () => {
    if (!slug) return;
    setLoading(true);
    Promise.all([
      client.api.jams[":slug"]
        .$get({ param: { slug } })
        .then((res) => res.json() as Promise<unknown>),
      client.api.jams[":slug"].entries
        .$get({ param: { slug } })
        .then((res) => res.json() as Promise<unknown>),
    ])
      .then(([jamData, entryData]) => {
        const jamObj = (jamData as { jam: GameJam & { status: string } }).jam;
        setJam(jamObj);
        setEntries((entryData as { entries: JamEntry[] }).entries);

        // If ended, also fetch results
        if (jamObj.status === "ended") {
          client.api.jams[":slug"].results
            .$get({ param: { slug } })
            .then((res) => res.json() as Promise<unknown>)
            .then((r) => setResults((r as { results: JamEntryResult[] }).results))
            .catch(() => {});
        }
      })
      .catch((err) => {
        if (err instanceof Response && err.status === 404) {
          setError("Jam not found.");
        } else {
          setError("Failed to load jam.");
        }
      })
      .finally(() => setLoading(false));
  };

  useEffect(fetchData, [slug]);

  const handleVote = async (entryId: number, score: number) => {
    if (!slug) return;
    try {
      const res = await client.api.jams[":slug"].entries[":entryId"].vote.$post(
        {
          param: { slug, entryId: String(entryId) },
          json: { score },
        },
      );
      if (!res.ok) {
        const data = (await res.json()) as { detail?: string };
        alert(data?.detail ?? "Failed to vote.");
        return;
      }
      fetchData();
    } catch {
      alert("Failed to vote.");
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error || !jam) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <EmptyState
          title="Jam not found"
          description={error || "This jam doesn't exist."}
        />
      </div>
    );
  }

  const isOwner = user?.id === jam.creatorId;
  const canSubmit = isAuthenticated && jam.status === "active";
  const canVote = isAuthenticated && jam.status === "voting";
  const showResults = jam.status === "ended" && results !== null;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Header */}
      {jam.coverImage && (
        <div className="rounded-lg overflow-hidden mb-6 h-48 md:h-64">
          <img
            src={jam.coverImage}
            alt={jam.title}
            className="w-full h-full object-cover"
          />
        </div>
      )}

      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-3xl font-bold">{jam.title}</h1>
          <p className="text-sm text-base-content/50 mt-1">
            Hosted by{" "}
            <Link
              to={`/${jam.creator?.username}`}
              className="link link-hover"
            >
              {jam.creator?.username}
            </Link>
          </p>
        </div>
        <JamStatusBadge status={jam.status} />
      </div>

      {/* Schedule */}
      <div className="flex flex-wrap gap-4 mb-6 text-sm">
        <div className="flex items-center gap-1.5 text-base-content/60">
          <CalendarIcon className="w-4 h-4" />
          <span>Starts: {formatDate(jam.startAt)}</span>
        </div>
        <div className="flex items-center gap-1.5 text-base-content/60">
          <CalendarIcon className="w-4 h-4" />
          <span>Ends: {formatDate(jam.endAt)}</span>
        </div>
        <div className="flex items-center gap-1.5 text-base-content/60">
          <TrophyIcon className="w-4 h-4" />
          <span>Voting until: {formatDate(jam.votingEndAt)}</span>
        </div>
        <div className="flex items-center gap-1.5 text-base-content/60">
          <UsersIcon className="w-4 h-4" />
          <span>
            {jam.entryCount} {jam.entryCount === 1 ? "entry" : "entries"}
          </span>
        </div>
      </div>

      {/* Theme */}
      {jam.theme && (
        <div className="alert mb-6">
          <div>
            <div className="text-xs font-bold uppercase text-base-content/50">
              Theme
            </div>
            <div className="text-lg font-bold">{jam.theme}</div>
          </div>
        </div>
      )}

      {/* Description */}
      {jam.description && (
        <div className="prose prose-sm max-w-none mb-8">
          <p className="whitespace-pre-wrap">{jam.description}</p>
        </div>
      )}

      {/* Submit entry */}
      {canSubmit && (
        <div className="card bg-base-200 mb-8">
          <div className="card-body p-4">
            <h3 className="font-semibold text-sm mb-2">Submit Your Entry</h3>
            <SubmitEntryForm jamSlug={slug!} onSubmitted={fetchData} />
          </div>
        </div>
      )}

      {/* Edit link for owner */}
      {isOwner && (
        <div className="mb-6">
          <Link
            to={`/dashboard/jams/${jam.slug}/edit`}
            className="btn btn-outline btn-sm"
          >
            Edit Jam
          </Link>
        </div>
      )}

      {/* Results or Entries */}
      {showResults ? (
        <section>
          <h2 className="text-xl font-bold mb-4">Results</h2>
          {results!.length === 0 ? (
            <EmptyState
              title="No entries"
              description="This jam had no submissions."
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {results!.map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  showVoting={false}
                />
              ))}
            </div>
          )}
        </section>
      ) : (
        <section>
          <h2 className="text-xl font-bold mb-4">
            Entries ({entries.length})
          </h2>
          {entries.length === 0 ? (
            <EmptyState
              title="No entries yet"
              description={
                jam.status === "upcoming"
                  ? "Submissions open when the jam starts."
                  : "Be the first to submit!"
              }
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {entries.map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  showVoting={canVote}
                  onVote={handleVote}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
