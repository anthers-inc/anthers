// SPDX-License-Identifier: Apache-2.0
/**
 * **Discovery** — the newest Works and Posts across Anthers, newest first.
 *
 * One stream, reusing the feed's `?scope=global` route, so its cards, access verdicts
 * and maturity filtering are the feed's own rather than a second listing that drifts
 * from it. The mix that spreads one creator's run across the page is the feed's too.
 *
 * 🚨 **The recipe is the product.** Discovery's promise is that the reader can
 * always see how the corpus is being drawn and change it, so the stream renders its
 * active recipe above the content and exposes the parameter behind it. There is no
 * hidden ranking, and nothing here is paid placement.
 *
 * The graph's shared-follow ranking is a route (`GET /api/accounts/me/graph`) and a
 * recipe builder with no page drawing them: a network of follows ranks nearly
 * everyone a reader can already see until the platform holds enough content for the
 * edges to say something. Discovery carried it as a second mode until 2026-10-23;
 * the mode picker is gone rather than left holding a single live row.
 *
 * Browse was removed on 2026-10-19, carrying none of its controls: search lives in
 * the top-level bar, and term filtering rides the `search` parameter the bar already
 * sends here. Inbox was removed the same day for having no backend to stand on.
 */

import {
	DISCOVERY_STAGE_LABELS,
	type DiscoveryReason,
	type DiscoveryRecipe,
	type RecipeWindow,
	streamRecipe,
} from "@anthers/shared/discovery";
import { client } from "@anthers/web-shared/rpc";
import { useSidebar } from "@anthers/web-shared/sidebar";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { ArrowPathIcon, MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import FeedTile from "../components/cards/FeedTile";
import SharedFilterSections from "../components/layout/SharedFilterSections";
import SharedLensesSection from "../components/layout/SharedLensesSection";
import TabHeader from "../components/layout/TabHeader";

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

/** The stream's presets. The window is the parameter; the filters narrow the rest. */
const RECIPE_PRESETS: ReadonlyArray<{ id: string; label: string; window: RecipeWindow }> = [
	{ id: "everything", label: "Everything new", window: "all" as const },
	{ id: "today", label: "The last day", window: "day" as const },
	{ id: "week", label: "The last week", window: "week" as const },
];

/**
 * The active recipe, rendered above the content. It names what is being drawn, the
 * three stages that drew it, and the control that changes one of them, so the reader
 * never has to guess why a card is on screen. The stages come from the same module the
 * route ranks with, so the bar cannot describe a pipeline the server did not run.
 */
function RecipeBar({
	preset,
	recipe,
	children,
	onRefresh,
}: {
	preset: string;
	recipe: DiscoveryRecipe;
	children?: React.ReactNode;
	onRefresh?: () => void;
}) {
	return (
		<div className="mb-6 rounded-box border border-base-300 bg-base-200/40 p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/40">
						Active recipe
					</p>
					<p className="mt-1 max-w-3xl text-sm leading-relaxed text-base-content/80">
						<span className="font-medium">{preset}.</span> {recipe.sentence}
					</p>
					<dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
						{recipe.stages.map((stage) => (
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

	const [entries, setEntries] = useState<FeedEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [refreshKey, setRefreshKey] = useState(0);

	const contentType = searchParams.get("media_type") ?? "";
	const access = searchParams.get("access") ?? "";
	const tags = searchParams.get("tags") ?? "";
	const search = searchParams.get("search") ?? "";
	/** The lens is an organizing metaphor over the stream, never a mode. */
	const lens = searchParams.get("lens") ?? "";

	const tickerPresetId = searchParams.get("preset") ?? "everything";
	const tickerPreset =
		RECIPE_PRESETS.find((preset) => preset.id === tickerPresetId) ?? RECIPE_PRESETS[0];
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

	// The stream: the feed's own, widened to every creator. The refresh control bumps
	// this counter; the feed route has no cache buster, so the value exists only to
	// make the dependency real to the linter.
	useEffect(() => {
		void refreshKey;
		setLoading(true);
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
			.finally(() => setLoading(false));
	}, [contentType, access, tags, refreshKey]);

	// The stream filters the already-fetched page by the window and the term. The
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

	// Sidebar: the lens is the page's own section, and the shared filters sit below the
	// divider the layout draws, exactly as on the Network and Library tabs. The URL
	// carries the lens, so a link to "the stream under the Music Player" survives.
	useEffect(() => {
		setPageContent(<SharedLensesSection lens={lens} onLens={(id) => updateParams({ lens: id })} />);
		setSharedContent(
			<SharedFilterSections
				type={contentType}
				onType={(id) => updateParams({ media_type: id })}
				tags={tags}
				onTags={(value) => updateParams({ tags: value })}
				access={{ value: access, onAccess: (value) => updateParams({ access: value }) }}
			/>,
		);
		return () => {
			setPageContent(null);
			setSharedContent(null);
		};
	}, [setPageContent, setSharedContent, contentType, access, tags, lens, updateParams]);

	const recipe = streamRecipe({ window });

	return (
		<div className="min-h-full">
			<div className="mx-auto w-full max-w-7xl px-6 py-6">
				<TabHeader
					icon={MagnifyingGlassIcon}
					title="Discovery"
					subtitle="Explore the Anthers ecosystem to find creators and creations you haven't discovered yet. Use one of our transparent preset formulas, or cook up your own. There are no advertisers or incentives to shove things in front of you; find your next fandom in your own way, for your own reasons."
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

				<RecipeBar
					preset={tickerPreset.label}
					recipe={recipe}
					onRefresh={() => setRefreshKey((key) => key + 1)}
				>
					<label className="flex flex-col gap-1 text-xs text-base-content/60">
						Preset
						<select
							className="select select-bordered select-sm"
							value={tickerPreset.id}
							onChange={(e) => updateParams({ preset: e.target.value })}
						>
							{RECIPE_PRESETS.map((preset) => (
								<option key={preset.id} value={preset.id}>
									{preset.label}
								</option>
							))}
						</select>
					</label>
				</RecipeBar>

				{loading ? (
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
			</div>
		</div>
	);
}
