// SPDX-License-Identifier: Apache-2.0
/**
 * The **Library** — everything the user has kept.
 *
 * 🚨 **A shelf, not a receipt list, and the commons is what forces the distinction.** Most
 * of what a person loves on Anthers is free, so it was never purchasable — a list built
 * from purchases has nowhere to put it, and bookmarks half-covered that and half-covered
 * four other things, which is why both felt like half a feature.
 *
 * So it reads `/api/content/library`: purchases, which land here automatically and
 * permanently, alongside anything free the user chose to **save**.
 *
 * Two behaviors worth knowing before changing anything here:
 *
 *   🚨 **A purchase can be hidden, never removed.** Somebody who tidies a purchase off
 *      their shelf and can't work out how to get it back has effectively lost the thing
 *      they paid for. The "show hidden" toggle is what makes hiding safe, so it must stay
 *      reachable from this page — it is the only way back.
 *
 *   ⚠️ **A shelf entry may be unopenable, and that is not a bug.** Saving grants no
 *      access, so a free Work whose creator later gated it stays here and stops being
 *      openable. It renders locked with the route to unlock, the same way a gated track
 *      sits in the play queue.
 *
 * The controls live in the SIDEBAR (the house structure, 2026-10-11, v2): the tab-shared
 * LENSES are the section above the second divider, the shared filters (Access, Type,
 * Tags) beneath them — the page body keeps only the content the view selects, plus the
 * Show-hidden toggle, whose invariant is absolute (see below). The lens switcher used
 * to be a page-level tabs row, kept deliberately apart from the media tabs for the
 * narrow-vs-reorganize distinction; the sidebar replaces that visual argument with the
 * structural one, and the graying contract does the rest.
 */

import { WITHDRAWN_RESCUE_DAYS } from "@anthers/shared/constants";
import { BOOKSHELF_WORK_TYPES } from "@anthers/shared/content";
import { contentNoteLabel } from "@anthers/shared/content-rating";
import {
	coverFor,
	MaturityVeil,
	useContentPreferences,
} from "@anthers/web-shared/content-preferences";
import { postUrl, workUrl } from "@anthers/web-shared/postUrl";
import { Link, useSearchParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { useSidebar } from "@anthers/web-shared/sidebar";
import { isAccessResult, type Work } from "@anthers/web-shared/types";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import {
	EyeIcon,
	EyeSlashIcon,
	LockClosedIcon,
	RectangleStackIcon,
} from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useState } from "react";
import SharedFilterSections, {
	SHARED_FILTER_TYPES,
} from "../components/layout/SharedFilterSections";
import SharedLensesSection from "../components/layout/SharedLensesSection";
import { useFilterable, useViewFilter } from "../components/layout/search/filter-context";
import TabHeader from "../components/layout/TabHeader";
import BookshelfLens from "../components/library/BookshelfLens";
import ChannelGuideLens, {
	channelGuideChannelsFromShelf,
} from "../components/library/ChannelGuideLens";
import MusicLens, { type LensItem, type LensProject } from "../components/library/MusicLens";
import { removeItem, setHidden } from "../lib/library";

/**
 * The LENSES (Parker, 2026-10-11, v2): the tab-shared LENSES section carries the rows
 * — the Library's own contribution to it is the live set. **A lens is a view, never a
 * container** — the shelf stays complete and usable with no lens applied, and switching
 * or removing one must never touch what is *in* the Library, which matters more here
 * than in the app this idea came from, because a shelf entry can be a thing somebody
 * paid for. 🚨 **A lens is a UI/UX shift, never a type filter in disguise** (the
 * retired Video lens is the cautionary example: the plain video grid is just the Video
 * type filter).
 *
 * The Music Player's dial rides the lens it is a control on, rendered beneath its row
 * (the shared section's `extras` slot) only while that lens is active.
 */
const LIBRARY_LIVES = new Set(["", "music", "channel-guide", "bookshelf"]);

/** The Music Player's dial, given to the shared section as the row's `extras` — a
 *  control ON the lens, rendered beneath its row only while the lens is selected. */
function musicDial(includeSpoken: boolean, onIncludeSpoken: (on: boolean) => void) {
	return (
		<label className="mt-1 ml-6 flex w-fit cursor-pointer items-center gap-2 text-xs">
			<input
				type="checkbox"
				className="toggle toggle-sm"
				checked={includeSpoken}
				onChange={(e) => onIncludeSpoken(e.target.checked)}
			/>
			Include spoken word
		</label>
	);
}

/** The shelf's view of a saved Project — the album card's whole data source. */
type ShelfProject = LensProject;

/** A saved post as the shelf's card reads it — title, opening and who wrote it. */
interface ShelfPost {
	id: number;
	publicId: number;
	slug: string;
	title: string | null;
	/** The title with each mentioned Work's current name — what the card shows. */
	displayTitle?: string | null;
	excerpt: string | null;
	tags: string[];
	isPublished: boolean;
	creator: { handle: string; displayName: string | null; avatar: string | null } | null;
}

interface ShelfItem {
	id: number;
	kind: "work" | "project" | "post";
	hidden: boolean;
	savedAt: string;
	/** Derived from a completed purchase on every read — never stored on the row. */
	purchased: boolean;
	work?: Work | null;
	project?: ShelfProject | null;
	post?: ShelfPost | null;
}

/**
 * The last day a withdrawn Work can still be rescued, or null when we don't know
 * when it was withdrawn (a row from before `0017` stamped the column).
 */
function rescueDeadline(withdrawnAt: string | null | undefined): string | null {
	if (!withdrawnAt) return null;
	const at = new Date(withdrawnAt);
	if (Number.isNaN(at.getTime())) return null;
	at.setDate(at.getDate() + WITHDRAWN_RESCUE_DAYS);
	return at.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function ShelfCard({ item, onChanged }: { item: ShelfItem; onChanged: () => void }) {
	const [busy, setBusy] = useState(false);
	const work = item.work;
	const project = item.project;
	const post = item.post;

	const title = work?.title ?? project?.title ?? post?.displayTitle ?? post?.title ?? "Untitled";
	const rawCover = work?.thumbnail ?? project?.coverImage ?? null;
	const to =
		work?.publicId != null
			? workUrl({ slug: work.slug, publicId: work.publicId })
			: project
				? `/projects/${project.slug}`
				: post
					? postUrl(post)
					: null;

	// A shelf entry the user cannot currently open — saved free and later gated, or
	// refunded. Stated rather than hidden: it is still theirs to see, just not to open.
	const locked =
		item.kind === "work" && isAccessResult(work?.access) && work.access.canAccess === false;

	// A cover is covered here the same way a card covers it — the rung the user blurs,
	// and each kind of content they asked to cover. The shelf is not exempt: a user who
	// blurs a rung or a kind expects it covered wherever it appears, their own shelf
	// included. Projects carry no rating, so an album's cover renders as-is.
	const { prefs } = useContentPreferences();
	const cover = work ? coverFor(prefs, work) : null;

	const act = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await fn();
			onChanged();
		} finally {
			setBusy(false);
		}
	};

	const body = (
		<>
			{post ? (
				// A post has no picture of its own, so the card's top shows its opening the
				// way the feed's tile does — a post on the shelf reads like a post.
				<div className="flex h-40 w-full items-start bg-base-300/60 p-4">
					<p className="line-clamp-4 text-sm text-base-content/70">{post.excerpt || "No text"}</p>
				</div>
			) : rawCover ? (
				cover ? (
					<MaturityVeil
						maturity={work?.maturity}
						notes={(work?.maturityNotes ?? []).map(contentNoteLabel)}
						because={cover.byRung ? undefined : cover.byNotes.map(contentNoteLabel)}
						className="h-40 w-full"
					>
						<img src={rawCover} alt="" className="h-full w-full object-cover" />
					</MaturityVeil>
				) : (
					<figure>
						<img src={rawCover} alt="" className="h-40 w-full object-cover" />
					</figure>
				)
			) : (
				<div className="flex h-40 w-full items-center justify-center bg-base-300">
					<span className="text-sm text-base-content/30">No thumbnail</span>
				</div>
			)}
			<div className="card-body gap-1 p-4">
				<h2 className="card-title text-sm">{title}</h2>
				{post?.creator && (
					<p className="text-xs text-base-content/60">
						{post.creator.displayName || `@${post.creator.handle}`}
					</p>
				)}
				<div className="flex flex-wrap items-center gap-1.5">
					{/* A word, not only a color: "Purchased" is what makes the permanence
					    rule legible when the remove control refuses. */}
					{item.purchased && <span className="badge badge-sm badge-soft">Purchased</span>}
					{item.kind === "project" && <span className="badge badge-sm badge-ghost">Album</span>}
					{item.kind === "post" && <span className="badge badge-sm badge-ghost">Post</span>}
					{locked && (
						<span className="badge badge-sm badge-ghost gap-1">
							<LockClosedIcon className="size-3" />
							Gated
						</span>
					)}
					{item.hidden && <span className="badge badge-sm badge-ghost">Hidden</span>}
				</div>
				{post && !post.isPublished && (
					<p className="text-xs text-warning">Back in drafts — the creator has unpublished it.</p>
				)}
				{work?.visibility === "withdrawn" && (
					<p className="text-xs text-warning">
						Withdrawn by the creator — still yours
						{rescueDeadline(work.withdrawnAt)
							? `, and free to download until ${rescueDeadline(work.withdrawnAt)}.`
							: " to open and download."}
					</p>
				)}
				{to == null && <p className="text-xs text-base-content/40">No longer available to open.</p>}
			</div>
		</>
	);

	return (
		<div className={`card bg-base-200 ${item.hidden ? "opacity-60" : ""}`}>
			{to ? (
				<Link to={to} className="transition-shadow hover:shadow-lg">
					{body}
				</Link>
			) : (
				<div className="opacity-70">{body}</div>
			)}
			<div className="flex items-center justify-end gap-1 px-3 pb-3">
				<button
					type="button"
					className="btn btn-ghost btn-xs gap-1"
					disabled={busy}
					onClick={() => act(() => setHidden(item.id, !item.hidden))}
				>
					{item.hidden ? <EyeIcon className="size-3.5" /> : <EyeSlashIcon className="size-3.5" />}
					{item.hidden ? "Show" : "Hide"}
				</button>
				{/* Absent entirely on a purchase, rather than present-and-refusing. A control
				    that exists to say no is worse than one that was never offered — and the
				    server refuses regardless, so this is presentation, not enforcement. */}
				{!item.purchased && (
					<button
						type="button"
						className="btn btn-ghost btn-xs"
						disabled={busy}
						onClick={() => act(() => removeItem(item.id))}
					>
						Remove
					</button>
				)}
			</div>
		</div>
	);
}

/**
 * What the topbar's Filter mode reads on a shelf item: the item's own words, its creator,
 * and its tags. The shelf is already fully in memory, so this filter is complete rather
 * than a filter over the loaded page.
 */
function shelfSearchFields(item: ShelfItem): (string | null | undefined)[] {
	const fields: (string | null | undefined)[] = [item.kind];
	if (item.work) {
		fields.push(
			item.work.title,
			item.work.description,
			item.work.type,
			item.work.creatorDisplayName,
			item.work.creatorHandle,
			...(item.work.tags ?? []),
		);
	}
	if (item.project) {
		fields.push(item.project.title, item.project.creatorDisplayName, item.project.creatorHandle);
	}
	if (item.post) {
		fields.push(
			item.post.title,
			item.post.displayTitle,
			item.post.excerpt,
			item.post.creator?.displayName,
			item.post.creator?.handle,
			...(item.post.tags ?? []),
		);
	}
	return fields;
}

/**
 * The shelf items a tag filter keeps — AND semantics, the feed's comma-list read. A
 * Project carries no tags of its own, so it drops while any tag filter is on, the way
 * a post linking nothing drops while any type filter is on. */
function matchesTags(item: ShelfItem, tags: string[]): boolean {
	if (tags.length === 0) return true;
	const own =
		item.kind === "work"
			? (item.work?.tags ?? [])
			: item.kind === "post"
				? (item.post?.tags ?? [])
				: [];
	return tags.every((t) => own.includes(t));
}

/**
 * The shelf items an Access filter keeps — the resolved verdict the card already
 * renders ("unlocked" is canAccess; "locked" its complement). A Project carries no
 * access reading, so any access filter drops it; All is where an album lives.
 */
function matchesAccess(item: ShelfItem, access: string): boolean {
	if (!access) return true;
	// A saved post carries no access reading at all, so it drops under either side of the
	// filter — All is where it lives, the same honesty a Project gets.
	if (item.kind !== "work" || !item.work || !isAccessResult(item.work.access)) return false;
	return access === "unlocked"
		? item.work.access.canAccess === true
		: item.work.access.canAccess === false;
}

export default function LibraryPage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const { setPageContent, setSharedContent } = useSidebar();
	const viewFilter = useViewFilter();
	useFilterable("Library");
	const [items, setItems] = useState<ShelfItem[]>([]);
	// How many entries the shelf was cut to, when it was cut at all. The server leaves out the
	// oldest past its limit, and a shelf that silently ends reads as lost saves.
	const [cutTo, setCutTo] = useState<number | null>(null);
	const [loading, setLoading] = useState(true);

	const activeType = searchParams.get("type") ?? "";
	const showHidden = searchParams.get("hidden") === "1";
	const lens = searchParams.get("lens") ?? "";
	const includeSpoken = searchParams.get("spoken") === "1";
	/** The selected tags as the comma list the shared Tags section carries. */
	const tagsParam = searchParams.get("tags") ?? "";
	/** The Access filter's value — "" any, "unlocked", "locked" — the shared section's control. */
	const accessParam = searchParams.get("access") ?? "";

	/*
	 * 🚨 Always fetch the WHOLE shelf, hidden included, and filter for display below.
	 *
	 * Fetching `hidden=1` only when the toggle is on looks equivalent and is not: the
	 * count that decides whether the toggle *renders* would then be computed from a list
	 * the toggle had already excluded. Hiding your last item removed the toggle along with
	 * it — leaving no way back, which is precisely the black hole that refusing to remove
	 * a purchase exists to prevent, reproduced one layer up. Found by hiding one item in a
	 * one-item Library.
	 */
	const load = useCallback(() => {
		client.api.content.library
			.$get({ query: { hidden: "1" } })
			.then((res) => res.json())
			.then((data) => {
				const shelf = data as unknown as {
					items: ShelfItem[];
					truncated?: boolean;
					limit?: number;
				};
				setItems(shelf.items);
				setCutTo(shelf.truncated && shelf.limit ? shelf.limit : null);
			})
			.catch(() => {})
			.finally(() => setLoading(false));
	}, []);

	useEffect(load, [load]);

	const setParam = useCallback(
		(key: string, value: string) => {
			const next = new URLSearchParams(searchParams);
			if (value) next.set(key, value);
			else next.delete(key);
			setSearchParams(next, { replace: true });
		},
		[searchParams, setSearchParams],
	);

	// Hidden entries are filtered HERE rather than by the request — see `load`.
	const visible = showHidden ? items : items.filter((i) => !i.hidden);
	// The topbar's Filter mode is the broadest term filter and applies before the shelf's
	// own controls, so the Access, Type and Tags sections narrow what is already matched
	// rather than fighting it.
	const searched = useMemo(
		() =>
			viewFilter.terms.length === 0
				? visible
				: visible.filter((item) => viewFilter.matches(shelfSearchFields(item))),
		[visible, viewFilter],
	);
	// The Access filter reads the resolved verdict the cards already carry. A Project
	// has no access reading, so it drops while any access filter is on — the same
	// rule a post obeys under a type filter, and the same honesty: All is where it lives.
	const withAccess = useMemo(
		() => searched.filter((i) => matchesAccess(i, accessParam)),
		[searched, accessParam],
	);
	// The tag filter reads the shelf's own tags, client-side: the Library view is a
	// browser over what is already fetched.
	const selectedTags = useMemo(
		() =>
			tagsParam
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean),
		[tagsParam],
	);
	const withTags = useMemo(
		() => withAccess.filter((i) => matchesTags(i, selectedTags)),
		[withAccess, selectedTags],
	);
	// A Project has no media type of its own, so a type filter necessarily excludes
	// albums. The All type is where they live, which is honest: an album is not "a video".
	// A lens reorganizes the shelf's Works and Projects; a post is not a Work type, so it
	// sits out every lens rather than arriving as a row a lens has no shape for.
	const lensDraw = useMemo(() => withTags.filter((i) => i.kind !== "post"), [withTags]);

	const filtered = useMemo(() => {
		if (!activeType) return withTags;
		// "posts" is the shared Type row's id for the post kind; every other id is a Work
		// type, so a post drops under those and a Work drops under Posts.
		if (activeType === "posts") return withTags.filter((i) => i.kind === "post");
		return withTags.filter((i) => i.kind === "work" && i.work?.type === activeType);
	}, [withTags, activeType]);

	/**
	 * The Type rows the sidebar grays out (Parker, 2026-10-11): a type grayed when the
	 * Library holds nothing of it, and — under a lens — when the lens excludes it. Posts
	 * are a Type row like any other now that a post saves into the Library, so the row is
	 * live exactly when the shelf holds one.
	 */
	const unavailableTypes = useMemo(() => {
		const set = new Set<string>();
		// A lens decides what it draws on, so under it the Type list cannot narrow what
		// the lens reorganizes — non-participating types gray, and a participating one
		// grays on empty stock exactly as it does lensless.
		const lensIncluded: string[] | null =
			lens === "music"
				? includeSpoken
					? ["music", "audio"]
					: ["music"]
				: lens === "bookshelf"
					? [...BOOKSHELF_WORK_TYPES]
					: lens === "channel-guide"
						? ["video"]
						: null;
		if (lensIncluded) {
			for (const t of SHARED_FILTER_TYPES) {
				if (t.id && !lensIncluded.includes(t.id)) set.add(t.id);
			}
			// A type the lens includes but the shelf has nothing of grays the same way.
			for (const type of lensIncluded) {
				if (!items.some((i) => i.kind === "work" && i.work?.type === type)) set.add(type);
			}
		} else {
			for (const t of SHARED_FILTER_TYPES) {
				if (t.id === "posts") {
					if (!items.some((i) => i.kind === "post")) set.add(t.id);
				} else if (t.id && !items.some((i) => i.kind === "work" && i.work?.type === t.id)) {
					set.add(t.id);
				}
			}
		}
		return set;
	}, [lens, includeSpoken, items]);

	// Register the sidebar's two pieces: the tab-shared LENSES, with the Library's live
	// set and the Music Player's dial, and the shared filters with the Access control
	// this page consumes — each adapter writing this page's own params.
	useEffect(() => {
		setPageContent(
			<SharedLensesSection
				lens={lens}
				onLens={(id) => setParam("lens", id)}
				live={LIBRARY_LIVES}
				extras={{
					music: musicDial(includeSpoken, (on) => setParam("spoken", on ? "1" : "")),
				}}
			/>,
		);
		setSharedContent(
			<SharedFilterSections
				type={activeType}
				onType={(id) => setParam("type", id)}
				unavailableTypes={unavailableTypes}
				tags={tagsParam}
				onTags={(value) => setParam("tags", value)}
				access={{ value: accessParam, onAccess: (value) => setParam("access", value) }}
			/>,
		);
		return () => {
			setPageContent(null);
			setSharedContent(null);
		};
	}, [
		setPageContent,
		setSharedContent,
		setParam,
		lens,
		includeSpoken,
		activeType,
		tagsParam,
		accessParam,
		unavailableTypes,
	]);

	if (loading) {
		return (
			<div className="flex min-h-[60vh] items-center justify-center">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	const hiddenCount = items.filter((i) => i.hidden).length;

	return (
		<div className="container mx-auto px-4 py-8">
			<TabHeader
				icon={RectangleStackIcon}
				title="Library"
				subtitle="All of the Works, Projects, and Posts you've purchased or otherwise saved, with everything you've purchased staying yours."
			/>
			{cutTo != null && (
				<p className="mb-6 text-sm text-base-content/60">
					Your Library holds more than {cutTo.toLocaleString()} things, and this page shows the{" "}
					{cutTo.toLocaleString()} you saved most recently. Everything older is still saved.
				</p>
			)}

			{/* The page body holds only what the view selects, plus this toggle. */}
			{(showHidden || hiddenCount > 0) && (
				<div className="mb-6">
					<label className="label cursor-pointer gap-2 text-sm">
						<input
							type="checkbox"
							className="toggle toggle-sm"
							checked={showHidden}
							onChange={(e) => setParam("hidden", e.target.checked ? "1" : "")}
						/>
						Show hidden
						{!showHidden && hiddenCount > 0 && (
							<span className="badge badge-xs">{hiddenCount}</span>
						)}
					</label>
				</div>
			)}

			{lens === "music" ? (
				/* Same rule as before the lenses moved into the sidebar: the lens
				   reorganizes what is on the shelf, never fetches a different corpus.
				   Drawing on `withTags` is what keeps "a lens is a view" true of the whole
				   family of them. */
				<MusicLens items={lensDraw as LensItem[]} includeSpoken={includeSpoken} />
			) : lens === "bookshelf" ? (
				/* The reading shelf: book-like types as spines, alpha by title. The same
				   drawn list as every lens — `withTags`, the shelf's own narrowing. */
				<BookshelfLens items={lensDraw as LensItem[]} />
			) : lens === "channel-guide" ? (
				/* The TV-guide: a channel per creator with saved video, that channel's
				   timeline of saved videos, latest first. Channels translate client-side
				   from the same drawn list; the guide itself owns selection. */
				<ChannelGuideLens
					channels={channelGuideChannelsFromShelf(lensDraw as LensItem[])}
					source="library"
				/>
			) : filtered.length === 0 ? (
				<EmptyState
					title={
						viewFilter.terms.length > 0
							? "No matches in your Library"
							: activeType
								? `No ${SHARED_FILTER_TYPES.find((t) => t.id === activeType)?.label.toLowerCase()} in your Library`
								: "Your Library is empty"
					}
					description={
						viewFilter.terms.length > 0
							? `Nothing here matches “${viewFilter.query.trim()}”.`
							: activeType
								? "Nothing here yet — save something, or buy it, and it lands here."
								: "Save anything you want to keep. Free work included — you don't have to buy something to keep it."
					}
					action={
						viewFilter.terms.length > 0 ? (
							<button
								type="button"
								className="btn btn-primary btn-sm"
								onClick={() => setParam("q", "")}
							>
								Clear filter
							</button>
						) : (
							<Link to="/discovery" className="btn btn-primary btn-sm">
								Explore Discovery
							</Link>
						)
					}
				/>
			) : (
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
					{filtered.map((item) => (
						<ShelfCard key={item.id} item={item} onChanged={load} />
					))}
				</div>
			)}
		</div>
	);
}
