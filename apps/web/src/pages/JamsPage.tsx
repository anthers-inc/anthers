// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	CalendarIcon,
	ClockIcon,
	InformationCircleIcon,
	PlusIcon,
	SparklesIcon,
	TrophyIcon,
	UserGroupIcon,
	XMarkIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import EmptyState from "../components/ui/EmptyState";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { useAuth } from "../lib/auth";
import type { GameJam } from "../lib/types";

const apiBase =
	window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
		? "http://localhost:8000"
		: "";

const STATUS_TABS = [
	{ value: "", label: "All" },
	{ value: "upcoming", label: "Upcoming" },
	{ value: "active", label: "Active" },
	{ value: "voting", label: "Judging" },
	{ value: "ended", label: "Completed" },
];

// Content type filters for when multi-type jams are supported
const CONTENT_TYPE_FILTERS = [
	{ value: "", label: "All Types" },
	{ value: "game", label: "Games" },
	{ value: "video", label: "Video" },
	{ value: "audio", label: "Audio" },
	{ value: "text", label: "Writing" },
	{ value: "mixed", label: "Mixed Media" },
];

function JamStatusBadge({ status }: { status: string }) {
	const styles: Record<string, string> = {
		upcoming: "badge-info",
		active: "badge-success",
		voting: "badge-warning",
		ended: "badge-ghost",
	};
	const labels: Record<string, string> = {
		upcoming: "upcoming",
		active: "accepting entries",
		voting: "judging",
		ended: "completed",
	};
	return (
		<span className={`badge badge-sm ${styles[status] || "badge-ghost"}`}>
			{labels[status] || status}
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
	const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
	if (sameMonth) {
		return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${e.getDate()}, ${e.getFullYear()}`;
	}
	return `${formatDate(start)} – ${formatDate(end)}`;
}

function JamCard({ jam }: { jam: GameJam }) {
	return (
		<Link to={`/jams/${jam.slug}`} className="card bg-base-200 hover:bg-base-300 transition-colors">
			{jam.coverImage && (
				<figure className="h-40">
					<img src={jam.coverImage} alt={jam.title} className="w-full h-full object-cover" />
				</figure>
			)}
			<div className="card-body p-4">
				<div className="flex items-start justify-between gap-2">
					<h2 className="card-title text-base">{jam.title}</h2>
					<JamStatusBadge status={(jam as GameJam & { status: string }).status} />
				</div>
				<div className="flex flex-col gap-1 text-sm text-base-content/60">
					<div className="flex items-center gap-1.5">
						<CalendarIcon className="w-3.5 h-3.5" />
						<span>{formatDateRange(jam.startAt, jam.endAt)}</span>
					</div>
					<div className="flex items-center gap-1.5">
						<ClockIcon className="w-3.5 h-3.5" />
						<span>Judging until {formatDate(jam.votingEndAt)}</span>
					</div>
				</div>
				<div className="flex items-center justify-between mt-2">
					<span className="text-xs text-base-content/40">by {jam.creator?.username}</span>
					<span className="text-xs text-base-content/50">
						{jam.entryCount} {jam.entryCount === 1 ? "entry" : "entries"}
					</span>
				</div>
			</div>
		</Link>
	);
}

export default function JamsPage() {
	const { user } = useAuth();
	const [statusFilter, setStatusFilter] = useState("");
	const [contentTypeFilter, setContentTypeFilter] = useState("");
	const [jams, setJams] = useState<GameJam[]>([]);
	const [loading, setLoading] = useState(true);
	const [showInfo, setShowInfo] = useState(false);

	useEffect(() => {
		setLoading(true);
		const params = statusFilter ? `?status=${statusFilter}` : "";
		fetch(`${apiBase}/api/jams${params}`, { credentials: "include" })
			.then((res) => res.json())
			.then((data: { jams: GameJam[] }) => setJams(data.jams))
			.catch(() => {})
			.finally(() => setLoading(false));
	}, [statusFilter]);

	return (
		<div className="max-w-7xl mx-auto px-4 py-8">
			{/* Header */}
			<div className="flex items-start justify-between mb-2">
				<div className="flex items-center gap-2">
					<h1 className="text-2xl font-bold">Jams</h1>
					<button
						type="button"
						className="btn btn-ghost btn-xs btn-circle"
						onClick={() => setShowInfo(!showInfo)}
						aria-label="What are Jams?"
					>
						<InformationCircleIcon className="w-4 h-4 text-base-content/40" />
					</button>
				</div>
				{user?.isCreator && (
					<Link to="/dashboard/jams/new" className="btn btn-primary btn-sm">
						<PlusIcon className="w-4 h-4" />
						Host a Jam
					</Link>
				)}
			</div>

			<p className="text-base-content/60 text-sm mb-6">
				Contests, challenges, and calls for creative content.
			</p>

			{/* Info panel */}
			{showInfo && (
				<div className="bg-base-200 rounded-lg p-4 text-sm mb-6 relative">
					<button
						type="button"
						className="btn btn-ghost btn-xs btn-circle absolute top-2 right-2"
						onClick={() => setShowInfo(false)}
					>
						<XMarkIcon className="w-4 h-4" />
					</button>
					<p className="font-semibold mb-2">What are Jams?</p>
					<p className="text-base-content/70 mb-3">
						Jams are creative contests where sponsors put out calls for content and creators compete
						to produce their best work. Prizes range from cash to featured placement to professional
						opportunities.
					</p>
					<div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
						<div className="flex items-start gap-2">
							<TrophyIcon className="w-4 h-4 text-warning shrink-0 mt-0.5" />
							<div>
								<p className="font-medium text-base-content/80">Win prizes</p>
								<p className="text-base-content/50">Cash, features, and recognition</p>
							</div>
						</div>
						<div className="flex items-start gap-2">
							<SparklesIcon className="w-4 h-4 text-primary shrink-0 mt-0.5" />
							<div>
								<p className="font-medium text-base-content/80">All media types</p>
								<p className="text-base-content/50">Games, video, audio, and writing</p>
							</div>
						</div>
						<div className="flex items-start gap-2">
							<UserGroupIcon className="w-4 h-4 text-secondary shrink-0 mt-0.5" />
							<div>
								<p className="font-medium text-base-content/80">Fair competition</p>
								<p className="text-base-content/50">Size-tiered to spotlight emerging creators</p>
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Filters row */}
			<div className="flex flex-wrap items-center gap-4 mb-6">
				{/* Status tabs */}
				<div className="tabs tabs-boxed">
					{STATUS_TABS.map((tab) => (
						<button
							key={tab.value}
							type="button"
							className={`tab tab-sm ${statusFilter === tab.value ? "tab-active" : ""}`}
							onClick={() => setStatusFilter(tab.value)}
						>
							{tab.label}
						</button>
					))}
				</div>

				{/* Content type filter (scaffolding for future multi-type jams) */}
				<select
					className="select select-bordered select-sm"
					value={contentTypeFilter}
					onChange={(e) => setContentTypeFilter(e.target.value)}
				>
					{CONTENT_TYPE_FILTERS.map((f) => (
						<option key={f.value} value={f.value}>
							{f.label}
						</option>
					))}
				</select>
			</div>

			{/* Results */}
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
							: "No jams have been created yet. Check back soon, or host your own."
					}
					action={
						user?.isCreator ? (
							<Link to="/dashboard/jams/new" className="btn btn-primary btn-sm">
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
