// SPDX-License-Identifier: Apache-2.0
//
// The public status page. No content module sits behind it — unlike /release-notes,
// whose content is authored and exported from the wiki, this page renders
// live answers: GET /api/status polled on a slow interval, and GET /api/status/history
// beside it, the sampler-maintained record the uptime bars and Past Incidents render
// from. The vault's own rule is why the page lives here rather than in the wiki: a
// real-time status page is exactly what that rule hands to the app. A live answer means
// nothing for the exporter to carry, which is what makes it possible for the page to be
// honest — a cached or authored claim about "operational" is the one sentence on Anthers
// nobody should have to take on faith.
//
// **Everything renders at once — no tabs, no accordions, no lazy sections**, the same
// rule the release-notes page carries: a status page in an incident is skimmed,
// and hiding half of it behind a control is how a reader misses the line that mattered.
//
// **The page says what the data can support and no more.** The standalone status page at
// status.anthers.org is served by the droplet the outside check runs on, a failure domain
// apart from the hub, and stays up when the hub — and this page with it — is down; the
// lede hands readers there in one sentence, without an explanation of why it exists,
// because the reader who needs the reason is having the outage and that page's own copy
// is what they will be reading. Days nothing was recorded for render as empty cells in a
// bar rather than as green: coverage is shown, never faked.

import { Sprig } from "@anthers/web-shared/decor/LineArt";
import { Reveal } from "@anthers/web-shared/decor/Reveal";
import { Lede } from "@anthers/web-shared/decor/sections";
import { FONTS } from "@anthers/web-shared/fonts";
import { usePageTitle } from "@anthers/web-shared/page-title";
import { Link } from "@anthers/web-shared/router";
import { apiFetch } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";
import { WIKI_ROADMAP_URL } from "../lib/wiki";

const serif = { fontFamily: FONTS.fraunces };

/** Milliseconds between polls. Slow enough to be a non-event for the API, fast enough to be useful. */
const POLL_MS = 30_000;

/** The history window the bars render, in days — the same number the record prunes to. */
const HISTORY_DAYS = 90;

/** The answer's shape, from services/status.ts — duplicated as a type only, no runtime import. */
interface StatusComponent {
	name: string;
	state: "operational" | "degraded" | "down";
	detail?: string;
	/** ISO timestamp of when the present condition began. Absent when operational. */
	since?: string;
}
interface StatusReport {
	state: "operational" | "degraded" | "down";
	external: {
		state: "operational" | "degraded" | "down" | "unknown";
		lastReportAt: string | null;
		detail?: string;
	};
	components: StatusComponent[];
	checkedAt: string;
}

/** The history answer's shape, from services/status-history.ts — again types only. */
type TrackedState = "operational" | "degraded" | "down";
interface HistoryDay {
	day: string;
	state: TrackedState | null;
}
interface HistoryComponent {
	name: string;
	uptimePct: number | null;
	days: HistoryDay[];
}
interface IncidentUpdate {
	at: string;
	severity: TrackedState;
	note: string;
}
interface IncidentFeedEntry {
	id: number;
	name: string;
	severity: "degraded" | "down";
	openedAt: string;
	resolvedAt: string | null;
	updates: IncidentUpdate[];
}
interface HistoryAnswer {
	windowDays: number;
	components: HistoryComponent[];
	incidents: IncidentFeedEntry[];
}

/**
 * State accents. These ARE a traffic light — degraded and down are exactly the warning
 * the page exists to deliver, and an incident page that colors nothing is an incident
 * page nobody reads.
 */
const STATE_STYLE: Record<string, string> = {
	operational: "bg-success/15 text-success border-success/25",
	degraded: "bg-warning/15 text-warning border-warning/30",
	down: "bg-error/15 text-error border-error/30",
	unknown: "bg-base-content/10 text-base-content/60 border-base-content/20",
};

const STATE_LABEL: Record<string, string> = {
	operational: "Operational",
	degraded: "Degraded",
	down: "Down",
	unknown: "Unknown",
};

const HEADLINE: Record<StatusReport["state"], string> = {
	operational: "All systems operational",
	degraded: "Some systems degraded",
	down: "Service disruption",
};

/** The banner's fill; `null` states (nothing polled yet, or a failed check) stay neutral. */
const BANNER_STYLE: Record<string, string> = {
	operational: "bg-success text-success-content",
	degraded: "bg-warning text-warning-content",
	down: "bg-error text-error-content",
	unknown: "bg-base-200 text-base-content/70",
};

/** A readable "for about N …" from a timestamp — the same scale the status email uses. */
function durationSince(iso: string): string | null {
	const started = new Date(iso).getTime();
	if (Number.isNaN(started)) return null;
	return durationBetween(started, Date.now());
}

/** The readable span between two times, at the same scale the details render at. */
function durationBetween(fromMs: number, toMs: number): string | null {
	const seconds = Math.max(0, Math.round((toMs - fromMs) / 1000));
	if (seconds < 90) return `${seconds} seconds`;
	if (seconds < 5400) return `${Math.max(1, Math.round(seconds / 60))} minutes`;
	if (seconds < 172_800) return `${Math.round(seconds / 3600)} hours`;
	return `${Math.round(seconds / 86_400)} days`;
}

/** A timestamp in the UTC form status pages conventionally stamp incidents with. */
function formatUtc(iso: string): string | null {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return null;
	const hh = String(date.getUTCHours()).padStart(2, "0");
	const mm = String(date.getUTCMinutes()).padStart(2, "0");
	return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${hh}:${mm} UTC`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A `YYYY-MM-DD` day key, as an incident group's heading reads it. */
function formatDay(day: string): string | null {
	const date = new Date(`${day}T00:00:00Z`);
	if (Number.isNaN(date.getTime())) return null;
	return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** A component card: name, live state pill, and the recorded bar with its availability figure. */
function ComponentRow({
	component,
	history,
}: {
	component: StatusComponent;
	history?: HistoryComponent;
}) {
	return (
		<div className="rounded-xl border border-base-content/10 bg-base-100 px-5 py-4">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="font-semibold">{component.name}</h3>
				<span
					className={`rounded-full border px-3 py-0.5 text-sm font-medium ${
						STATE_STYLE[component.state] ?? STATE_STYLE.unknown
					}`}
				>
					{STATE_LABEL[component.state]}
				</span>
			</div>
			{(component.detail || component.since) && (
				<p className="mt-1 text-sm text-base-content/70">
					{component.detail}
					{component.detail && component.since ? " " : ""}
					{component.since
						? `Continuing for about ${durationSince(component.since) ?? "a moment"}.`
						: ""}
				</p>
			)}
			{history && <UptimeBar history={history} />}
		</div>
	);
}

function UptimeBar({ history }: { history: HistoryComponent }) {
	// The cells are exactly windowDays wide, oldest first, as the feed sent them; a day
	// with no recorded sample renders empty (base-content faint), never green.
	return (
		<div className="mt-3">
			<div
				className="flex h-6 gap-px"
				role="img"
				aria-label={`${history.name} uptime over the last ${history.days.length} days`}
			>
				{history.days.map((cell) => (
					<div
						key={cell.day}
						title={`${cell.day}: ${cell.state ? STATE_LABEL[cell.state] : "no data"}`}
						className={`h-6 min-w-0 flex-1 rounded-[1px] ${
							cell.state === "operational"
								? "bg-success"
								: cell.state === "degraded"
									? "bg-warning"
									: cell.state === "down"
										? "bg-error"
										: "bg-base-content/10"
						}`}
					/>
				))}
			</div>
			<div className="mt-2 flex items-center gap-3 text-sm text-base-content/60">
				<span>{HISTORY_DAYS} days ago</span>
				<span className="h-px flex-1 bg-base-content/15" />
				<span className="font-medium text-base-content/80">
					{history.uptimePct === null ? "No data yet" : `${history.uptimePct.toFixed(2)}% uptime`}
				</span>
				<span className="h-px flex-1 bg-base-content/15" />
				<span>Today</span>
			</div>
		</div>
	);
}

/**
 * Past Incidents: the sampler's own transitions, grouped by the UTC day they opened on,
 * with ongoing incidents pinned under today's heading. Days with nothing to show are
 * skipped entirely (today included, once older incidents exist), so the feed never
 * becomes a scroll of "no incidents" headers.
 */
function IncidentsSection({ incidents }: { incidents: IncidentFeedEntry[] }) {
	const todayKey = new Date().toISOString().slice(0, 10);
	const groups = new Map<string, IncidentFeedEntry[]>();
	for (const incident of incidents) {
		// An ongoing window's day is "now", wherever it opened: the reader's question is
		// what is wrong today, and the group heading is the answer.
		const day = incident.resolvedAt === null ? todayKey : incident.openedAt.slice(0, 10);
		if (!groups.has(day)) groups.set(day, []);
		groups.get(day)?.push(incident);
	}
	for (const entries of groups.values()) {
		entries.sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
	}
	const days = [...groups.keys()].sort((a, b) => (a < b ? 1 : -1));

	return (
		<div className="mt-14">
			<h2 style={serif} className="text-3xl font-light">
				Past Incidents
			</h2>
			{(() => {
				// Nothing recorded anywhere: one line, no date headers to scroll past.
				const recorded = days.filter((day) => (groups.get(day)?.length ?? 0) > 0);
				if (recorded.length === 0) {
					return (
						<p className="mt-4 text-base-content/70">
							No incidents reported in the last {HISTORY_DAYS} days.
						</p>
					);
				}
				return recorded.map((day) => (
					<div key={day} className="mt-8 border-b border-base-content/10 pb-6">
						<h3 className="border-b border-base-content/10 pb-2 text-xl font-normal">
							{formatDay(day) ?? day}
						</h3>
						<div className="mt-4 space-y-5">
							{groups.get(day)?.map((incident) => (
								<IncidentEntry key={incident.id} incident={incident} />
							))}
						</div>
					</div>
				));
			})()}
		</div>
	);
}

/** One incident: its worst-severity title, the resolution or the ongoing line, and its updates. */
function IncidentEntry({ incident }: { incident: IncidentFeedEntry }) {
	const ongoing = incident.resolvedAt === null;
	const title = incident.severity === "down" ? "Outage on" : "Degraded performance on";
	const accent = incident.severity === "down" ? "text-error" : "text-warning";
	const updates = [...incident.updates].reverse();
	// The resolution line states the span once; the matching update row would say it
	// again, so it is dropped from the timeline rather than doubled.
	const timeline = ongoing ? updates : updates.slice(1);
	const resolvedSpan = incident.resolvedAt
		? durationBetween(
				new Date(incident.openedAt).getTime(),
				new Date(incident.resolvedAt).getTime(),
			)
		: null;

	return (
		<article>
			<h4 className={`font-medium ${accent}`}>
				{title} {incident.name}
			</h4>
			<p className="mt-1 text-sm">
				{ongoing ? (
					<>
						<span className="font-semibold">Investigating.</span> Continuing for about{" "}
						{durationSince(incident.openedAt) ?? "a moment"}.
					</>
				) : (
					<>
						<span className="font-semibold">Resolved.</span> The incident lasted about{" "}
						{resolvedSpan ?? "a moment"}.
					</>
				)}
			</p>
			{timeline.length > 0 && (
				<div className="mt-3 space-y-3 border-l-2 border-base-content/10 pl-4">
					{timeline.map((update) => (
						<div key={`${incident.id}-${update.at}-${update.severity}`}>
							<p className="text-sm">
								<span className="font-semibold">
									{update.severity === "down"
										? "Down."
										: update.severity === "degraded"
											? "Degraded."
											: "Recovered."}
								</span>{" "}
								{update.note || null}
							</p>
							<p className="mt-0.5 text-xs text-base-content/50">{formatUtc(update.at)}</p>
						</div>
					))}
				</div>
			)}
		</article>
	);
}

export default function StatusPage() {
	usePageTitle("Status");
	const [report, setReport] = useState<StatusReport | null>(null);
	const [history, setHistory] = useState<HistoryAnswer | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let aborted = false;
		async function poll() {
			try {
				const res = await apiFetch("/api/status");
				if (!res.ok) throw new Error(String(res.status));
				const body = (await res.json()) as StatusReport;
				if (!aborted) {
					setReport(body);
					setFailed(false);
				}
			} catch {
				if (!aborted) setFailed(true);
			}
			// The history answer rides the same interval, and its failure is tolerated
			// quietly: bars and Past Incidents are the record's decoration on a live page,
			// and a read hiccup hides them rather than darkening the headline.
			try {
				const res = await apiFetch("/api/status/history");
				if (!res.ok) throw new Error(String(res.status));
				const body = (await res.json()) as HistoryAnswer;
				if (!aborted) setHistory(body);
			} catch {
				if (!aborted) setHistory(null);
			}
		}
		poll();
		const timer = setInterval(poll, POLL_MS);
		return () => {
			aborted = true;
			clearInterval(timer);
		};
	}, []);

	const bannerState = failed ? "unknown" : report ? report.state : null;
	const historyByName = new Map((history?.components ?? []).map((c) => [c.name, c]));

	return (
		<div>
			<header className="bg-base-200/70">
				<div className="mx-auto max-w-3xl px-6 pt-24 pb-16 text-center">
					<Reveal>
						<Sprig className="mx-auto mb-5 h-11 w-11 text-primary/60" />
						<p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
							Status
						</p>
						<h1
							style={serif}
							className="text-balance text-4xl font-light leading-tight sm:text-5xl"
						>
							Status
						</h1>
					</Reveal>
					<Reveal delay={150}>
						<Lede>
							What is running and what is not, answered fresh each time this page loads, and
							refreshed every thirty seconds. The same status also lives at{" "}
							<a href="https://status.anthers.org" className="link">
								status.anthers.org
							</a>
							.
						</Lede>
					</Reveal>
				</div>
			</header>

			{/* The content band: deliberately not the shared `Section`, whose marketing
				rhythm centers everything. A status page reads left-aligned; the width
				matches the header's so the two line up. */}
			<section>
				<div className="mx-auto max-w-3xl px-6 pb-24 text-left">
					<Reveal>
						{bannerState ? (
							<div
								className={`rounded-xl px-6 py-5 text-lg font-medium ${BANNER_STYLE[bannerState]}`}
							>
								{failed
									? "We could not check just now"
									: report
										? HEADLINE[report.state]
										: "Checking…"}
							</div>
						) : null}
						{report && (
							<div className="mt-4 space-y-3">
								{report.components.map((component) => (
									<ComponentRow
										key={component.name}
										component={component}
										history={historyByName.get(component.name)}
									/>
								))}
							</div>
						)}
					</Reveal>
					{history && <IncidentsSection incidents={history.incidents} />}
					<Reveal delay={200}>
						<p className="mt-10 text-sm text-base-content/55">
							Something not on this page? Report it at{" "}
							<Link to="/issues" className="link">
								Report an Issue
							</Link>
							; that page is for things misbehaving that a status row cannot see. The{" "}
							<a href={WIKI_ROADMAP_URL} className="link">
								roadmap
							</a>{" "}
							and the{" "}
							<Link to="/release-notes" className="link">
								release notes
							</Link>{" "}
							say what is being built and what has shipped.
						</p>
					</Reveal>
				</div>
			</section>
		</div>
	);
}
