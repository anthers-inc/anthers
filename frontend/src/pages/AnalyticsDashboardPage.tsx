import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type {
  AnalyticsOverview,
  ContentAnalyticsItem,
  ContentAnalyticsResponse,
  TimeseriesEntry,
  TimeseriesResponse,
  CrossPlatformComparison,
} from "../lib/api";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import EmptyState from "../components/ui/EmptyState";
import {
  ChartBarIcon,
  EyeIcon,
  ClockIcon,
  UsersIcon,
  PlayIcon,
  FilmIcon,
  MusicalNoteIcon,
  DocumentTextIcon,
  ArrowTrendingUpIcon,
} from "@heroicons/react/24/outline";

const PERIOD_OPTIONS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function EventTypeIcon({ type }: { type: string }) {
  switch (type) {
    case "game":
      return <PlayIcon className="w-4 h-4" />;
    case "video":
      return <FilmIcon className="w-4 h-4" />;
    case "audio":
      return <MusicalNoteIcon className="w-4 h-4" />;
    default:
      return <DocumentTextIcon className="w-4 h-4" />;
  }
}

// ─── Sparkline Bar Chart (pure CSS) ───

function SparkBar({
  data,
  label,
  color = "bg-primary",
}: {
  data: number[];
  label: string;
  color?: string;
}) {
  const max = Math.max(...data, 1);
  return (
    <div>
      <div className="text-xs text-base-content/50 mb-1">{label}</div>
      <div className="flex items-end gap-px h-16">
        {data.map((value, i) => (
          <div
            key={i}
            className={`flex-1 ${color} rounded-t-sm opacity-80 min-h-[2px]`}
            style={{ height: `${(value / max) * 100}%` }}
            title={`${value}`}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Overview Stats Cards ───

function OverviewCards({ overview }: { overview: AnalyticsOverview }) {
  const m = overview.metrics;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
      <div className="stat bg-base-200 rounded-lg p-4">
        <div className="stat-figure text-primary">
          <EyeIcon className="w-6 h-6" />
        </div>
        <div className="stat-title text-xs">Total Views</div>
        <div className="stat-value text-lg">{formatNumber(m.total_views)}</div>
      </div>
      <div className="stat bg-base-200 rounded-lg p-4">
        <div className="stat-figure text-secondary">
          <ClockIcon className="w-6 h-6" />
        </div>
        <div className="stat-title text-xs">Watch Time</div>
        <div className="stat-value text-lg">
          {formatDuration(m.total_duration_seconds)}
        </div>
      </div>
      <div className="stat bg-base-200 rounded-lg p-4">
        <div className="stat-figure text-accent">
          <UsersIcon className="w-6 h-6" />
        </div>
        <div className="stat-title text-xs">Unique Viewers</div>
        <div className="stat-value text-lg">
          {formatNumber(m.unique_viewers)}
        </div>
      </div>
      <div className="stat bg-base-200 rounded-lg p-4">
        <div className="stat-figure text-info">
          <ArrowTrendingUpIcon className="w-6 h-6" />
        </div>
        <div className="stat-title text-xs">Total Events</div>
        <div className="stat-value text-lg">
          {formatNumber(m.total_events)}
        </div>
      </div>
    </div>
  );
}

// ─── Event Type Breakdown ───

function EventBreakdown({ overview }: { overview: AnalyticsOverview }) {
  const m = overview.metrics;
  const items = [
    { label: "Page Views", value: m.total_views, color: "bg-primary" },
    { label: "Plays", value: m.total_plays, color: "bg-secondary" },
    { label: "Watches", value: m.total_watches, color: "bg-accent" },
    { label: "Reads", value: m.total_reads, color: "bg-info" },
    { label: "Listens", value: m.total_listens, color: "bg-warning" },
  ].filter((i) => i.value > 0);

  if (items.length === 0) return null;

  const total = items.reduce((sum, i) => sum + i.value, 0);

  return (
    <div className="card bg-base-200 mb-8">
      <div className="card-body p-4">
        <h3 className="font-semibold text-sm mb-3">Engagement Breakdown</h3>
        <div className="flex rounded-full overflow-hidden h-3 mb-3">
          {items.map((item) => (
            <div
              key={item.label}
              className={`${item.color}`}
              style={{ width: `${(item.value / total) * 100}%` }}
              title={`${item.label}: ${item.value}`}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-4">
          {items.map((item) => (
            <div key={item.label} className="flex items-center gap-1.5">
              <div className={`w-2.5 h-2.5 rounded-full ${item.color}`} />
              <span className="text-xs">
                {item.label}: {formatNumber(item.value)} (
                {Math.round((item.value / total) * 100)}%)
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Timeseries Charts ───

function TimeseriesCharts({
  timeseries,
}: {
  timeseries: TimeseriesEntry[];
}) {
  if (timeseries.length === 0) return null;

  return (
    <div className="card bg-base-200 mb-8">
      <div className="card-body p-4">
        <h3 className="font-semibold text-sm mb-3">Daily Trends</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <SparkBar
            data={timeseries.map((d) => d.total_events)}
            label="Events"
            color="bg-primary"
          />
          <SparkBar
            data={timeseries.map((d) => d.unique_viewers)}
            label="Unique Viewers"
            color="bg-accent"
          />
          <SparkBar
            data={timeseries.map((d) => d.duration_seconds)}
            label="Duration"
            color="bg-secondary"
          />
        </div>
        <div className="flex justify-between text-xs text-base-content/40 mt-1">
          <span>{timeseries[0]?.date}</span>
          <span>{timeseries[timeseries.length - 1]?.date}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Content Performance Table ───

function ContentPerformanceTable({
  content,
}: {
  content: ContentAnalyticsItem[];
}) {
  if (content.length === 0) {
    return (
      <EmptyState
        title="No content activity yet"
        description="Analytics will appear here once viewers interact with your content."
      />
    );
  }

  return (
    <div className="card bg-base-200 mb-8">
      <div className="card-body p-4">
        <h3 className="font-semibold text-sm mb-3">Content Performance</h3>
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Content</th>
                <th className="text-right">Views</th>
                <th className="text-right">Time</th>
                <th className="text-right">Viewers</th>
              </tr>
            </thead>
            <tbody>
              {content.slice(0, 20).map((item) => (
                <tr key={`${item.type}-${item.id}`}>
                  <td>
                    <div className="flex items-center gap-2">
                      <EventTypeIcon
                        type={item.media_type || item.content_type || "text"}
                      />
                      <div>
                        {item.type === "project" && item.slug ? (
                          <Link
                            to={`/explore/${item.slug}`}
                            className="link link-hover text-sm font-medium"
                          >
                            {item.title}
                          </Link>
                        ) : item.type === "post" ? (
                          <Link
                            to={`/posts/${item.id}`}
                            className="link link-hover text-sm font-medium"
                          >
                            {item.title}
                          </Link>
                        ) : (
                          <span className="text-sm font-medium">
                            {item.title}
                          </span>
                        )}
                        <div className="text-xs text-base-content/40">
                          {item.type}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="text-right text-sm">
                    {formatNumber(item.views)}
                  </td>
                  <td className="text-right text-sm">
                    {formatDuration(item.duration_seconds)}
                  </td>
                  <td className="text-right text-sm">
                    {formatNumber(item.unique_viewers)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Cross-Platform Comparison ───

function CrossPlatformSection({
  comparison,
}: {
  comparison: CrossPlatformComparison | null;
}) {
  if (!comparison) return null;

  const platforms = Object.entries(comparison.platforms);
  if (platforms.length === 0 && comparison.bluebell.views === 0) return null;

  const platformNames: Record<string, string> = {
    youtube: "YouTube",
    steam: "Steam",
    itchio: "itch.io",
    substack: "Substack",
  };

  return (
    <div className="card bg-base-200 mb-8">
      <div className="card-body p-4">
        <h3 className="font-semibold text-sm mb-3">
          Cross-Platform Comparison
        </h3>
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Platform</th>
                <th className="text-right">Views</th>
                <th className="text-right">Watch Time</th>
                <th className="text-right">Revenue/View</th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-primary/10">
                <td className="font-medium">Bluebell</td>
                <td className="text-right">
                  {formatNumber(comparison.bluebell.views)}
                </td>
                <td className="text-right">
                  {formatDuration(comparison.bluebell.duration_seconds)}
                </td>
                <td className="text-right text-base-content/40">--</td>
              </tr>
              {platforms.map(([platform, data]) => (
                <tr key={platform}>
                  <td>{platformNames[platform] || platform}</td>
                  <td className="text-right">{formatNumber(data.views)}</td>
                  <td className="text-right">
                    {formatDuration(data.watch_time_seconds)}
                  </td>
                  <td className="text-right">
                    ${data.revenue_per_view.toFixed(4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {platforms.length === 0 && (
          <p className="text-xs text-base-content/40 mt-2">
            Connect external platforms in{" "}
            <Link to="/settings" className="link">
              Settings
            </Link>{" "}
            to see cross-platform comparisons.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ───

export default function AnalyticsDashboardPage() {
  const [period, setPeriod] = useState("30");
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [content, setContent] = useState<ContentAnalyticsItem[]>([]);
  const [timeseries, setTimeseries] = useState<TimeseriesEntry[]>([]);
  const [comparison, setComparison] =
    useState<CrossPlatformComparison | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get<AnalyticsOverview>(
        `/api/v1/integrations/analytics/overview/?period=${period}`,
      ),
      api.get<ContentAnalyticsResponse>(
        `/api/v1/integrations/analytics/content/?period=${period}`,
      ),
      api.get<TimeseriesResponse>(
        `/api/v1/integrations/analytics/timeseries/?period=${period}`,
      ),
      api.get<CrossPlatformComparison>(
        `/api/v1/integrations/analytics/comparison/?period=${period}`,
      ),
    ])
      .then(([overviewData, contentData, timeseriesData, comparisonData]) => {
        setOverview(overviewData);
        setContent(contentData.content);
        setTimeseries(timeseriesData.timeseries);
        setComparison(comparisonData);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [period]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <ChartBarIcon className="w-6 h-6" />
          <h1 className="text-2xl font-bold">Analytics</h1>
        </div>
        <select
          className="select select-sm select-bordered"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
        >
          {PERIOD_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      ) : !overview ? (
        <EmptyState
          title="Analytics unavailable"
          description="Something went wrong loading your analytics."
        />
      ) : (
        <>
          <OverviewCards overview={overview} />
          <EventBreakdown overview={overview} />
          <TimeseriesCharts timeseries={timeseries} />
          <ContentPerformanceTable content={content} />
          <CrossPlatformSection comparison={comparison} />
        </>
      )}
    </div>
  );
}
