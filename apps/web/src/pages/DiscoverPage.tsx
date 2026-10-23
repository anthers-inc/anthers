// SPDX-License-Identifier: Apache-2.0
/**
 * **Discovery** — the place for what the reader has not found yet.
 *
 * Two modes, both carrying a formula the reader can see and change:
 *
 * - **Graph** traces the network around the people they follow: creators ranked by
 *   how many of those people also follow them. A creator the reader already follows
 *   stays in the list, because the graph is a picture of the network rather than a
 *   list of strangers, and the card says so.
 * - **Ticker** is the newest Works and Posts across Anthers, newest first. It reuses
 *   the feed's `?scope=global` stream, so its cards, access verdicts and maturity
 *   filtering are the feed's own rather than a second listing that drifts from it.
 *
 * 🚨 **The formula is the product.** Discovery's promise is that the reader can
 * always see how the corpus is being drawn and change it, so every mode renders its
 * active formula above the content and exposes the parameter behind it. There is no
 * hidden ranking, and nothing here is paid placement.
 *
 * Browse was removed on 2026-10-19, carrying none of its controls: search lives in
 * the top-level bar, and term filtering rides the `search` parameter the bar already
 * sends here. Inbox was removed the same day for having no backend to stand on.
 */

import {
	DISCOVERY_STAGE_LABELS,
	type DiscoveryFormula,
	type DiscoveryReason,
	type GraphBasis,
	graphFormula,
	type TickerWindow,
	tickerFormula,
} from "@anthers/shared/discovery";
import { useAuth } from "@anthers/web-shared/auth";
import CreatorCard from "@anthers/web-shared/creator/CreatorCard";
import { client } from "@anthers/web-shared/rpc";
import { useSidebar } from "@anthers/web-shared/sidebar";
import type { PublicUser } from "@anthers/web-shared/types";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import {
	ArrowPathIcon,
	BoltIcon,
	GlobeAltIcon,
	MagnifyingGlassIcon,
	XMarkIcon,
} from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import FeedTile from "../components/cards/FeedTile";
import SharedFilterSections, {
	SHARED_FILTER_TYPES,
} from "../components/layout/SharedFilterSections";
import SharedLensesSection from "../components/layout/SharedLensesSection";
import { sidebarRowClass } from "../components/layout/sidebar-row-class";
import TabHeader from "../components/layout/TabHeader";

type DiscoveryMode = "graph" | "ticker";

/** One entry of the feed's stream, as `?scope=global` sends it. */
type FeedEntry = {
	kind: "post" | "release";
	id: number;
	at: string;
	title?: string | null;
	creator?: { handle?: string; displayName?: string | null } | null;
	/** Why the entry is here, as the API states it. */
	reason?: DiscoveryReason;
} & Record<string, unknown>;

/** A creator as the graph ranks them: the public card plus the edge that put them here. */
type GraphCreator = PublicUser & {
	sharedFollows: number;
	types: string[];
	hasPosts: boolean;
	tags: string[];
};

const DISCOVERY_MODES = [
	{
		id: "graph" as const,
		label: "Graph",
		icon: GlobeAltIcon,
		description: "Creators connected to the people you follow",
	},
	{
		id: "ticker" as const,
		label: "Ticker",
		icon: BoltIcon,
		description: "The newest Works and Posts across Anthers",
	},
];

/** The graph's presets. `minShared` is the one parameter the reader can move. */
const GRAPH_PRESETS = [
	{
		id: "taste",
		label: "Your network's taste",
		minShared: 2,
		description: "Creators at least two of the people you follow also follow.",
	},
	{
		id: "extended",
		label: "Extended network",
		minShared: 1,
		description: "Anyone at least one of the people you follow follows.",
	},
] as const;

/** The ticker's presets. The window is the parameter; the filters narrow the rest. */
const TICKER_PRESETS: ReadonlyArray<{ id: string; label: string; window: TickerWindow }> = [
	{ id: "everything", label: "Everything new", window: "all" as const },
	{ id: "today", label: "The last day", window: "day" as const },
	{ id: "week", label: "The last week", window: "week" as const },
];

const sectionTitleClass =
	"text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2";

const modeKey = (userId: number | undefined) =>
	userId == null ? null : `anthers_discovery_mode:${userId}`;

function savedMode(userId: number | undefined): DiscoveryMode | null {
	const key = modeKey(userId);
	if (!key) return null;
	try {
		const saved = localStorage.getItem(key);
		return saved === "ticker" || saved === "graph" ? saved : null;
	} catch {
		return null;
	}
}

/**
 * The active formula, rendered above the content. It names what is being drawn, the
 * three stages that drew it, and the control that changes one of them, so the reader
 * never has to guess why a card is on screen. The stages come from the same module the
 * route ranks with, so the bar cannot describe a pipeline the server did not run.
 */
function FormulaBar({
	preset,
	formula,
	children,
	onRefresh,
}: {
	preset: string;
	formula: DiscoveryFormula;
	children?: React.ReactNode;
	onRefresh?: () => void;
}) {
	return (
		<div className="mb-6 rounded-box border border-base-300 bg-base-200/40 p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/40">
						Active formula
					</p>
					<p className="mt-1 max-w-3xl text-sm leading-relaxed text-base-content/80">
						<span className="font-medium">{preset}.</span> {formula.sentence}
					</p>
					<dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
						{formula.stages.map((stage) => (
							<div key={stage.stage} className="flex items-baseline gap-1.5">
								<dt className="text-[10px] font-semibold uppercase tracking-wider text-base-content/40">
									{DISCOVERY_STAGE_LABELS[stage.stage]}
								</dt>
								<dd className="text-base-content/60">{stage.label}</dd>
							</div>
						))}
					</dl>
				</div>
				<div className="flex flex-wrap items-end gap-2">
					{children}
					{onRefresh && (
						<button
							type="button"
							className="btn btn-ghost btn-sm btn-square"
							onClick={onRefresh}
							aria-label="Refresh"
							title="Refresh"
						>
							<ArrowPathIcon className="h-4 w-4" />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

export default function DiscoverPage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const { setPageContent, setSharedContent } = useSidebar();
	const { user } = useAuth();

	const [creators, setCreators] = useState<GraphCreator[]>([]);
	const [basis, setBasis] = useState<GraphBasis>("network");
	const [graphLoading, setGraphLoading] = useState(false);
	const [entries, setEntries] = useState<FeedEntry[]>([]);
	const [tickerLoading, setTickerLoading] = useState(false);
	const [refreshKey, setRefreshKey] = useState(0);

	const urlMode = searchParams.get("mode");
	const mode: DiscoveryMode =
		urlMode === "ticker" || urlMode === "graph" ? urlMode : (savedMode(user?.id) ?? "graph");

	const contentType = searchParams.get("media_type") ?? "";
	const access = searchParams.get("access") ?? "";
	const tags = searchParams.get("tags") ?? "";
	const search = searchParams.get("search") ?? "";
	/** The lens is a second organizing metaphor over the active mode, never a mode. */
	const lens = searchParams.get("lens") ?? "";

	const graphPresetId = searchParams.get("preset") ?? "taste";
	const graphPreset =
		GRAPH_PRESETS.find((preset) => preset.id === graphPresetId) ?? GRAPH_PRESETS[0];
	const minShared = Math.max(
		1,
		Math.min(10, Number(searchParams.get("min_shared") ?? graphPreset.minShared) || 1),
	);

	const tickerPresetId = searchParams.get("preset") ?? "everything";
	const tickerPreset =
		TICKER_PRESETS.find((preset) => preset.id === tickerPresetId) ?? TICKER_PRESETS[0];
	const window = tickerPreset.window;

	const updateParams = useCallback(
		(updates: Record<string, string>) => {
			setSearchParams(
				(prev) => {
					const next = new URLSearchParams(prev);
					for (const [key, value] of Object.entries(updates)) {
						if (value) next.set(key, value);
						else next.delete(key);
					}
					return next;
				},
				{ replace: true },
			);
		},
		[setSearchParams],
	);

	// The mode is sticky per account on this browser. The URL wins when it names one,
	// so a shared link lands where it says; otherwise the last mode the account used
	// is where they return.
	useEffect(() => {
		const key = modeKey(user?.id);
		if (!key) return;
		try {
			localStorage.setItem(key, mode);
		} catch {}
	}, [mode, user?.id]);

	// The URL has to carry the mode once the page has decided one, or a mode switch
	// would be invisible to the browser's back button and to a copied link.
	useEffect(() => {
		if (!urlMode) updateParams({ mode });
	}, [urlMode, mode, updateParams]);

	// Graph: the creators around the people this account follows.
	useEffect(() => {
		if (mode !== "graph") return;
		// The refresh control bumps this counter; the request itself needs no cache
		// buster, so the value is read only to make the dependency real to the linter.
		void refreshKey;
		setGraphLoading(true);
		client.api.accounts.me.graph
			.$get({ query: { min_shared: String(minShared), limit: "24" } })
			.then(async (res) => {
				if (!res.ok) return;
				const data = (await res.json()) as unknown as {
					basis: GraphBasis;
					creators: GraphCreator[];
				};
				setBasis(data.basis ?? "network");
				setCreators(data.creators ?? []);
			})
			.catch(() => {})
			.finally(() => setGraphLoading(false));
	}, [mode, minShared, refreshKey]);

	// Ticker: the same stream the feed draws, widened to every creator.
	useEffect(() => {
		if (mode !== "ticker") return;
		// The refresh control bumps this counter; the feed route has no cache buster.
		void refreshKey;
		setTickerLoading(true);
		client.api.accounts.me.feed
			.$get({
				query: {
					scope: "global",
					...(contentType === "posts"
						? { kind: "posts" }
						: contentType
							? { media_type: contentType }
							: {}),
					...(access ? { access } : {}),
					...(tags ? { tags } : {}),
				},
			})
			.then(async (res) => {
				if (!res.ok) return;
				const data = (await res.json()) as unknown as { entries: FeedEntry[] };
				setEntries(data.entries ?? []);
			})
			.catch(() => {})
			.finally(() => setTickerLoading(false));
	}, [mode, contentType, access, tags, refreshKey]);

	const selectedTags = useMemo(
		() =>
			tags
				.split(",")
				.map((tag) => tag.trim())
				.filter(Boolean),
		[tags],
	);

	// The graph runs the shared Type and Tags filters over each creator's released
	// content. Access is a verdict about one Work, not about a person, so the graph
	// omits that control rather than leaving it inert.
	const visibleCreators = useMemo(() => {
		const term = search.trim().toLowerCase();
		return creators.filter((creator) => {
			if (term) {
				const haystack = `${creator.displayName ?? ""} ${creator.handle ?? ""}`.toLowerCase();
				if (!haystack.includes(term)) return false;
			}
			if (contentType === "posts" && !creator.hasPosts) return false;
			if (contentType && contentType !== "posts" && !creator.types.includes(contentType)) {
				return false;
			}
			if (selectedTags.length > 0 && !selectedTags.every((tag) => creator.tags.includes(tag))) {
				return false;
			}
			return true;
		});
	}, [creators, search, contentType, selectedTags]);

	const graphUnavailableTypes = useMemo(() => {
		const held = new Set<string>();
		for (const creator of creators) {
			for (const type of creator.types) held.add(type);
			if (creator.hasPosts) held.add("posts");
		}
		const unavailable = new Set<string>();
		for (const type of SHARED_FILTER_TYPES) {
			if (type.id && !held.has(type.id)) unavailable.add(type.id);
		}
		return unavailable;
	}, [creators]);

	// The ticker filters the already-fetched page by the window and the term. The
	// server applies the Type, Access and Tags filters; these two are presentation
	// over what it returned.
	const visibleEntries = useMemo(() => {
		const term = search.trim().toLowerCase();
		const cutoff =
			window === "day"
				? Date.now() - 24 * 60 * 60 * 1000
				: window === "week"
					? Date.now() - 7 * 24 * 60 * 60 * 1000
					: null;
		return entries.filter((entry) => {
			if (cutoff != null && new Date(entry.at).getTime() < cutoff) return false;
			if (term) {
				const haystack =
					`${entry.title ?? ""} ${entry.creator?.displayName ?? ""} ${entry.creator?.handle ?? ""}`.toLowerCase();
				if (!haystack.includes(term)) return false;
			}
			return true;
		});
	}, [entries, window, search]);

	// Sidebar: Modes is the page's own section and the lens sits under it, because the
	// mode decides the corpus and the lens organizes that corpus. The URL carries both,
	// so a link to "Ticker under the Music Player" survives. The shared filters sit below
	// the divider the layout draws, exactly as on the Network and Library tabs.
	useEffect(() => {
		setPageContent(
			<div className="flex flex-col gap-5">
				<section>
					<h3 className={sectionTitleClass}>Modes</h3>
					<div className="flex flex-col gap-0.5">
						{DISCOVERY_MODES.map((discoveryMode) => (
							<button
								key={discoveryMode.id}
								type="button"
								className={sidebarRowClass(mode === discoveryMode.id)}
								onClick={() =>
									updateParams({
										mode: discoveryMode.id,
										// Access belongs to the ticker's stream, not to a person.
										...(discoveryMode.id === "graph" ? { access: "" } : {}),
										// Each mode has its own preset vocabulary.
										preset: "",
										min_shared: "",
									})
								}
								title={discoveryMode.description}
							>
								<discoveryMode.icon className="h-5 w-5 shrink-0" />
								{discoveryMode.label}
							</button>
						))}
					</div>
				</section>
				{/* Every lens row renders here; No Lens is the one live on Discovery today.
				    A future lens lights up when its meaning over these modes is built. */}
				<SharedLensesSection lens={lens} onLens={(id) => updateParams({ lens: id })} />
			</div>,
		);
		setSharedContent(
			<SharedFilterSections
				type={contentType}
				onType={(id) => updateParams({ media_type: id })}
				unavailableTypes={mode === "graph" ? graphUnavailableTypes : undefined}
				tags={tags}
				onTags={(value) => updateParams({ tags: value })}
				access={
					mode === "ticker"
						? { value: access, onAccess: (value) => updateParams({ access: value }) }
						: undefined
				}
			/>,
		);
		return () => {
			setPageContent(null);
			setSharedContent(null);
		};
	}, [
		setPageContent,
		setSharedContent,
		mode,
		contentType,
		access,
		tags,
		graphUnavailableTypes,
		lens,
		updateParams,
	]);

	const graphPipeline = graphFormula({ basis, minShared });
	const tickerPipeline = tickerFormula({ window });

	return (
		<div className="min-h-full">
			<div className="mx-auto w-full max-w-7xl px-6 py-6">
				<TabHeader
					icon={MagnifyingGlassIcon}
					title="Discovery"
					subtitle="Find something new to love on Anthers. Use one of our recipes, or cook up your own. There's no paid promotion or hidden algorithms."
				/>

				{search && (
					<div className="mb-4 flex items-center gap-2 text-sm text-base-content/70">
						<span>
							Showing results for <span className="font-medium">&ldquo;{search}&rdquo;</span>
						</span>
						<button
							type="button"
							className="btn btn-ghost btn-xs btn-circle"
							onClick={() => updateParams({ search: "" })}
							aria-label="Clear search"
						>
							<XMarkIcon className="h-3.5 w-3.5" />
						</button>
					</div>
				)}

				{mode === "graph" ? (
					<>
						<FormulaBar
							preset={basis === "followers" ? "Creators by followers" : graphPreset.label}
							formula={graphPipeline}
							onRefresh={() => setRefreshKey((key) => key + 1)}
						>
							{basis === "network" && (
								<>
									<label className="flex flex-col gap-1 text-xs text-base-content/60">
										Preset
										<select
											className="select select-bordered select-sm"
											value={graphPreset.id}
											onChange={(e) => {
												const preset = GRAPH_PRESETS.find((p) => p.id === e.target.value);
												updateParams({
													preset: e.target.value,
													min_shared: preset ? String(preset.minShared) : "",
												});
											}}
										>
											{GRAPH_PRESETS.map((preset) => (
												<option key={preset.id} value={preset.id}>
													{preset.label}
												</option>
											))}
										</select>
									</label>
									<label className="flex flex-col gap-1 text-xs text-base-content/60">
										Shared follows
										<input
											type="number"
											min={1}
											max={10}
											className="input input-bordered input-sm w-20"
											value={minShared}
											onChange={(e) =>
												updateParams({ min_shared: e.target.value.replace(/[^0-9]/g, "") })
											}
										/>
									</label>
								</>
							)}
						</FormulaBar>

						{graphLoading ? (
							<div className="flex justify-center py-16">
								<LoadingSpinner size="lg" />
							</div>
						) : visibleCreators.length === 0 ? (
							<EmptyState
								title={
									creators.length === 0
										? "No one in your network's orbit yet"
										: "No creators match these filters"
								}
								description={
									creators.length === 0
										? "Follow a few creators and this fills with the people they trust. Discovery has no recommendation engine to fall back on."
										: "Clear a Type or Tags filter, or lower the shared-follows threshold."
								}
							/>
						) : (
							<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
								{visibleCreators.map((creator) => (
									<div key={creator.id} className="flex flex-col gap-1">
										<CreatorCard creator={creator} />
										{basis === "network" && (
											<p className="px-1 text-xs text-base-content/50">
												Followed by {creator.sharedFollows}{" "}
												{creator.sharedFollows === 1 ? "person" : "people"} you follow
												{creator.isFollowing ? " · Following" : ""}
											</p>
										)}
									</div>
								))}
							</div>
						)}
					</>
				) : (
					<>
						<FormulaBar
							preset={tickerPreset.label}
							formula={tickerPipeline}
							onRefresh={() => setRefreshKey((key) => key + 1)}
						>
							<label className="flex flex-col gap-1 text-xs text-base-content/60">
								Preset
								<select
									className="select select-bordered select-sm"
									value={tickerPreset.id}
									onChange={(e) => updateParams({ preset: e.target.value })}
								>
									{TICKER_PRESETS.map((preset) => (
										<option key={preset.id} value={preset.id}>
											{preset.label}
										</option>
									))}
								</select>
							</label>
						</FormulaBar>

						{tickerLoading ? (
							<div className="flex justify-center py-16">
								<LoadingSpinner size="lg" />
							</div>
						) : visibleEntries.length === 0 ? (
							<EmptyState
								title="Nothing new here"
								description="No Works or Posts match these filters. Clear a filter, widen the window, or check back soon."
							/>
						) : (
							<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
								{visibleEntries.map((entry) => (
									<FeedTile key={`${entry.kind}-${entry.id}`} entry={entry} />
								))}
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}
