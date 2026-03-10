import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { client } from "../lib/rpc";
import type {
  AnalyticsOverview,
  ContentAnalyticsItem,
  TimeseriesEntry,
  CrossPublishResult,
  CreatorEarnings,
  CrfSubsidy,
} from "../lib/types";
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

const apiBase =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
    ? "http://localhost:8000"
    : "";

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
  const e = overview.events;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
      <div className="stat bg-base-200 rounded-lg p-4">
        <div className="stat-figure text-primary">
          <EyeIcon className="w-6 h-6" />
        </div>
        <div className="stat-title text-xs">Total Views</div>
        <div className="stat-value text-lg">{formatNumber(e.views)}</div>
      </div>
      <div className="stat bg-base-200 rounded-lg p-4">
        <div className="stat-figure text-secondary">
          <ClockIcon className="w-6 h-6" />
        </div>
        <div className="stat-title text-xs">Watch Time</div>
        <div className="stat-value text-lg">
          {overview.totalDurationHours.toFixed(1)}h
        </div>
      </div>
      <div className="stat bg-base-200 rounded-lg p-4">
        <div className="stat-figure text-accent">
          <UsersIcon className="w-6 h-6" />
        </div>
        <div className="stat-title text-xs">Unique Viewers</div>
        <div className="stat-value text-lg">
          {formatNumber(overview.uniqueViewers)}
        </div>
      </div>
      <div className="stat bg-base-200 rounded-lg p-4">
        <div className="stat-figure text-info">
          <ArrowTrendingUpIcon className="w-6 h-6" />
        </div>
        <div className="stat-title text-xs">Total Events</div>
        <div className="stat-value text-lg">
          {formatNumber(e.total)}
        </div>
      </div>
    </div>
  );
}

// ─── Event Type Breakdown ───

function EventBreakdown({ overview }: { overview: AnalyticsOverview }) {
  const e = overview.events;
  const items = [
    { label: "Page Views", value: e.views, color: "bg-primary" },
    { label: "Plays", value: e.plays, color: "bg-secondary" },
    { label: "Watches", value: e.watches, color: "bg-accent" },
    { label: "Reads", value: e.reads, color: "bg-info" },
    { label: "Listens", value: e.listens, color: "bg-warning" },
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
            data={timeseries.map((d) => d.views + d.plays + d.watches + d.reads + d.listens)}
            label="Events"
            color="bg-primary"
          />
          <SparkBar
            data={timeseries.map((d) => d.views)}
            label="Views"
            color="bg-accent"
          />
          <SparkBar
            data={timeseries.map((d) => d.watches + d.listens)}
            label="Media Engagement"
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
                <th className="text-right">Events</th>
                <th className="text-right">Time</th>
              </tr>
            </thead>
            <tbody>
              {content.slice(0, 20).map((item) => (
                <tr key={`${item.type}-${item.id}`}>
                  <td>
                    <div className="flex items-center gap-2">
                      <EventTypeIcon type={item.type} />
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
                    {formatNumber(item.eventCount)}
                  </td>
                  <td className="text-right text-sm">
                    {formatDuration(item.totalDuration)}
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

// ─── Revenue Analytics ───

function RevenueSection({
  earnings,
}: {
  earnings: CreatorEarnings | null;
}) {
  if (!earnings) return null;
  const total = parseFloat(earnings.total);
  if (total === 0 && earnings.subscriberCount === 0) return null;

  return (
    <div className="card bg-base-200 mb-8">
      <div className="card-body p-4">
        <h3 className="font-semibold text-sm mb-3">Revenue</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <div className="text-xs text-base-content/50">Pool Income</div>
            <div className="text-lg font-bold text-success">
              ${earnings.poolTotal}
            </div>
          </div>
          <div>
            <div className="text-xs text-base-content/50">Boost Income</div>
            <div className="text-lg font-bold text-success">
              ${earnings.boostTotal}
            </div>
          </div>
          <div>
            <div className="text-xs text-base-content/50">Total</div>
            <div className="text-lg font-bold">${earnings.total}</div>
          </div>
          <div>
            <div className="text-xs text-base-content/50">Subscribers</div>
            <div className="text-lg font-bold">
              {earnings.subscriberCount}
            </div>
          </div>
        </div>
        {earnings.cycle && (
          <p className="text-xs text-base-content/40 mt-2">
            Current cycle:{" "}
            {new Date(earnings.cycle).toLocaleDateString("en-US", {
              month: "long",
              year: "numeric",
            })}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Cross-Publish History ───

function CrossPublishHistory() {
  const [results, setResults] = useState<CrossPublishResult[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    client.api.integrations["cross-publish"]
      .$get()
      .then((res) => res.json())
      .then((data) =>
        setResults((data as { results: CrossPublishResult[] }).results),
      )
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading || results.length === 0) return null;

  const statusBadge = (s: string) => {
    switch (s) {
      case "published":
        return "badge-success";
      case "pending":
        return "badge-warning";
      case "failed":
        return "badge-error";
      default:
        return "badge-ghost";
    }
  };

  return (
    <div className="card bg-base-200 mb-8">
      <div className="card-body p-4">
        <h3 className="font-semibold text-sm mb-3">Cross-Publish History</h3>
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Status</th>
                <th>Date</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody>
              {results.slice(0, 10).map((r) => (
                <tr key={r.id}>
                  <td className="text-sm">{r.platform}</td>
                  <td>
                    <span className={`badge badge-xs ${statusBadge(r.status)}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="text-xs text-base-content/50">
                    {new Date(r.createdAt).toLocaleDateString()}
                  </td>
                  <td>
                    {r.externalUrl ? (
                      <a
                        href={r.externalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="link link-primary text-xs"
                      >
                        View
                      </a>
                    ) : (
                      <span className="text-xs text-base-content/30">—</span>
                    )}
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

// ─── CRF Hosting Subsidy ───

function CRFSubsidySection({
  crfStatus,
}: {
  crfStatus: { balance: string; subsidies: CrfSubsidy[] } | null;
}) {
  if (!crfStatus || crfStatus.subsidies.length === 0) return null;

  const latest = crfStatus.subsidies[0];
  const hasSubsidy = parseFloat(latest.subsidyAmount) > 0;

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  return (
    <div className="card bg-base-200 mb-8">
      <div className="card-body p-4">
        <h3 className="font-semibold text-sm mb-3">
          Hosting Costs & CRF Subsidy
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-3">
          <div>
            <div className="text-xs text-base-content/50">Hosting Cost</div>
            <div className="text-lg font-bold">
              ${latest.estimatedHostingCost}
            </div>
          </div>
          <div>
            <div className="text-xs text-base-content/50">Your Earnings</div>
            <div className="text-lg font-bold">
              ${latest.creatorEarnings}
            </div>
          </div>
          <div>
            <div className="text-xs text-base-content/50">CRF Subsidy</div>
            <div
              className={`text-lg font-bold ${hasSubsidy ? "text-success" : ""}`}
            >
              ${latest.subsidyAmount}
            </div>
          </div>
          <div>
            <div className="text-xs text-base-content/50">Storage Used</div>
            <div className="text-lg font-bold">
              {formatBytes(latest.storageBytes ?? 0)}
            </div>
          </div>
        </div>
        <p className="text-xs text-base-content/40">
          {hasSubsidy
            ? "The Community Resilience Fund is covering part of your hosting costs. As your audience grows, the subsidy decreases."
            : "Your earnings cover your hosting costs. Thank you for being part of the community!"}
        </p>
        <p className="text-xs text-base-content/40 mt-1">
          {latest.projectCount} projects, {latest.postCount} posts —{" "}
          {new Date(latest.billingCycle).toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
          })}
        </p>
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
  const [earnings, setEarnings] = useState<CreatorEarnings | null>(null);
  const [crfStatus, setCrfStatus] = useState<{
    balance: string;
    subsidies: CrfSubsidy[];
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);

    // Use raw fetch for endpoints that need query params
    Promise.all([
      fetch(`${apiBase}/api/integrations/analytics/overview?period=${period}`, {
        credentials: "include",
      }).then((res) => res.json()),
      fetch(`${apiBase}/api/integrations/analytics/content?period=${period}`, {
        credentials: "include",
      }).then((res) => res.json()),
      fetch(
        `${apiBase}/api/integrations/analytics/timeseries?period=${period}`,
        { credentials: "include" },
      ).then((res) => res.json()),
    ])
      .then(([overviewData, contentData, timeseriesData]) => {
        setOverview(overviewData as AnalyticsOverview);
        setContent(
          (contentData as { content: ContentAnalyticsItem[] }).content,
        );
        setTimeseries(
          (timeseriesData as { timeseries: TimeseriesEntry[] }).timeseries,
        );
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    // Fetch earnings and CRF status (non-blocking, independent of period)
    client.api.subscriptions.earnings
      .$get()
      .then((res) => res.json())
      .then((data) => setEarnings(data as CreatorEarnings))
      .catch(() => {});

    client.api.payments.crf.status
      .$get()
      .then((res) => res.json())
      .then((data) =>
        setCrfStatus(data as { balance: string; subsidies: CrfSubsidy[] }),
      )
      .catch(() => {});
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
          <RevenueSection earnings={earnings} />
          <CRFSubsidySection crfStatus={crfStatus} />
          <CrossPublishHistory />
        </>
      )}
    </div>
  );
}
