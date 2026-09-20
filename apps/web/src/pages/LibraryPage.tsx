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
 */

import { WITHDRAWN_RESCUE_DAYS } from "@anthers/shared/constants";
import { contentNoteLabel } from "@anthers/shared/content-rating";
import {
	coverFor,
	MaturityVeil,
	useContentPreferences,
} from "@anthers/web-shared/content-preferences";
import { workUrl } from "@anthers/web-shared/postUrl";
import { Link, useSearchParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { Work } from "@anthers/web-shared/types";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import {
	BookOpenIcon,
	EyeIcon,
	EyeSlashIcon,
	LockClosedIcon,
	MicrophoneIcon,
	MusicalNoteIcon,
	PencilSquareIcon,
	PuzzlePieceIcon,
	RectangleGroupIcon,
	RectangleStackIcon,
	VideoCameraIcon,
} from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import MusicLens, { type LensItem, type LensProject } from "../components/library/MusicLens";
import VideoLens from "../components/library/VideoLens";
import { removeItem, setHidden } from "../lib/library";

const MEDIA_TABS = [
	{ id: "", label: "All", icon: RectangleStackIcon },
	{ id: "game", label: "Games", icon: PuzzlePieceIcon },
	{ id: "music", label: "Music", icon: MusicalNoteIcon },
	{ id: "audio", label: "Audio", icon: MicrophoneIcon },
	{ id: "video", label: "Video", icon: VideoCameraIcon },
	{ id: "text", label: "Writing", icon: PencilSquareIcon },
	{ id: "ebook", label: "Books", icon: BookOpenIcon },
	{ id: "comic", label: "Comics", icon: RectangleGroupIcon },
] as const;

/** The shelf's view of a saved Project — the album card's whole data source. */
type ShelfProject = LensProject;

interface ShelfItem {
	id: number;
	kind: "work" | "project";
	hidden: boolean;
	savedAt: string;
	/** Derived from a completed purchase on every read — never stored on the row. */
	purchased: boolean;
	work?: Work | null;
	project?: ShelfProject | null;
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

	const title = work?.title ?? project?.title ?? "Untitled";
	const rawCover = work?.thumbnail ?? project?.coverImage ?? null;
	const to =
		work?.publicId != null
			? workUrl({ slug: work.slug, publicId: work.publicId })
			: project
				? `/projects/${project.slug}`
				: null;

	// A shelf entry the viewer cannot currently open — saved free and later gated, or
	// refunded. Stated rather than hidden: it is still theirs to see, just not to open.
	const locked = item.kind === "work" && work?.access?.canAccess === false;

	// A cover is covered here the same way a card covers it — the rung the reader blurs,
	// and each kind of content they asked to cover. The shelf is not exempt: a reader who
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
			{rawCover ? (
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
				<div className="flex flex-wrap items-center gap-1.5">
					{/* A word, not only a color: "Purchased" is what makes the permanence
					    rule legible when the remove control refuses. */}
					{item.purchased && <span className="badge badge-sm badge-soft">Purchased</span>}
					{item.kind === "project" && <span className="badge badge-sm badge-ghost">Album</span>}
					{locked && (
						<span className="badge badge-sm badge-ghost gap-1">
							<LockClosedIcon className="size-3" />
							Gated
						</span>
					)}
					{item.hidden && <span className="badge badge-sm badge-ghost">Hidden</span>}
				</div>
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

export default function LibraryPage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const [items, setItems] = useState<ShelfItem[]>([]);
	// How many entries the shelf was cut to, when it was cut at all. The server leaves out the
	// oldest past its limit, and a shelf that silently ends reads as lost saves.
	const [cutTo, setCutTo] = useState<number | null>(null);
	const [loading, setLoading] = useState(true);

	const activeTab = searchParams.get("type") ?? "";
	const showHidden = searchParams.get("hidden") === "1";
	/**
	 * Which lens is applied, or the bare shelf.
	 *
	 * 🚨 **A lens is a view, never a container.** The shelf stays complete and usable with
	 * no lens applied, and switching or removing one must never touch what is *in* the
	 * Library — which matters more here than in the app this idea came from, because a
	 * shelf entry can be a thing somebody paid for.
	 */
	const lens = searchParams.get("lens") ?? "";
	/**
	 * The music lens's one preset dial over its own filter: widen the same view to spoken
	 * word. Off by default — the lens *is* music by default — and switching it is a view
	 * change with the same invariant as the lens itself: never a change to what the shelf
	 * holds. Only the music lens reads this today; a future spoken-word lens would ship
	 * the same control in reverse if it earns one.
	 */
	const includeSpoken = searchParams.get("spoken") === "1";

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

	const setParam = (key: string, value: string) => {
		const next = new URLSearchParams(searchParams);
		if (value) next.set(key, value);
		else next.delete(key);
		setSearchParams(next, { replace: true });
	};

	// Hidden entries are filtered HERE rather than by the request — see `load`.
	const visible = showHidden ? items : items.filter((i) => !i.hidden);
	// A Project has no media type of its own, so a media tab necessarily excludes albums.
	// The All tab is where they live, which is honest: an album is not "a video".
	const filtered = activeTab
		? visible.filter((i) => i.kind === "work" && i.work?.type === activeTab)
		: visible;

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
			<h1 className="mb-2 text-2xl font-bold">Library</h1>
			<p className="mb-6 text-sm text-base-content/60">
				Everything you've kept — what you've bought, and anything free you saved.
			</p>
			{cutTo != null && (
				<p className="-mt-4 mb-6 text-sm text-base-content/60">
					Your Library holds more than {cutTo.toLocaleString()} things, and this page shows the{" "}
					{cutTo.toLocaleString()} you saved most recently. Everything older is still saved.
				</p>
			)}

			{/*
			 * The lens switcher.
			 *
			 * Deliberately separated from the media tabs below, and above them, because the
			 * two do genuinely different things and putting them in one row would say they
			 * are the same kind of control: a media tab NARROWS the shelf, a lens REORGANIZES
			 * it. The whole point of the concept is that those are not the same move.
			 */}
			<div className="mb-4 flex flex-wrap items-center gap-2">
				<span className="text-xs font-semibold uppercase tracking-wider text-base-content/40">
					View
				</span>
				{/* Named, because the page carries TWO tab groups and one of the labels
				    ("Music") appears in both — as a lens that reorganizes, and as a media
				    type that narrows. Sighted users get the "View" heading beside it; without
				    these, a screen reader hears two identical tabs with different meanings. */}
				<div role="tablist" aria-label="View" className="tabs tabs-box tabs-sm w-fit">
					<button
						type="button"
						role="tab"
						className={`tab ${lens === "" ? "tab-active" : ""}`}
						onClick={() => setParam("lens", "")}
					>
						Shelf
					</button>
					<button
						type="button"
						role="tab"
						className={`tab gap-1.5 ${lens === "music" ? "tab-active" : ""}`}
						onClick={() => setParam("lens", "music")}
					>
						<MusicalNoteIcon className="size-4" />
						Music
					</button>
					<button
						type="button"
						role="tab"
						className={`tab gap-1.5 ${lens === "video" ? "tab-active" : ""}`}
						onClick={() => setParam("lens", "video")}
					>
						<VideoCameraIcon className="size-4" />
						Video
					</button>
				</div>
			</div>

			{/* The media tabs belong to the shelf. Under a lens they would be a second,
			    competing way to narrow the same list, and the lens already decides what it
			    draws on. */}
			<div className={`mb-6 flex flex-wrap items-center gap-3 ${lens ? "hidden" : ""}`}>
				{/* `tabs-box`, not the retired v4 `tabs-boxed`. */}
				<div role="tablist" aria-label="Media type" className="tabs tabs-box w-fit">
					{MEDIA_TABS.map((tab) => (
						<button
							key={tab.id}
							type="button"
							role="tab"
							className={`tab tab-sm gap-1.5 ${activeTab === tab.id ? "tab-active" : ""}`}
							onClick={() => setParam("type", tab.id)}
						>
							<tab.icon className="size-4" />
							{tab.label}
							{tab.id === "" && visible.length > 0 && (
								<span className="badge badge-xs">{visible.length}</span>
							)}
						</button>
					))}
				</div>

				{/*
				 * 🚨 The way back from Hide, and therefore not optional.
				 *
				 * A purchase can only ever be hidden — never removed — so if this control is
				 * missing or hard to find, hiding becomes the black hole that refusing to
				 * remove was supposed to prevent. Shown whenever anything is hidden, and also
				 * while the toggle is on, so turning it off is possible.
				 */}
				{(showHidden || hiddenCount > 0) && (
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
				)}
			</div>

			{lens === "music" ? (
				<>
					{/* The lens's one dial — a preset control over the filter the lens itself
					    defines (Parker, 2026-09-20). This is a control ON the lens rather than
					    a second lens, so it lives inside the lens block, beside the view it
					    re-scopes. */}
					<label className="mb-4 flex w-fit cursor-pointer items-center gap-2 text-sm">
						<input
							type="checkbox"
							className="toggle toggle-sm"
							checked={includeSpoken}
							onChange={(e) => setParam("spoken", e.target.checked ? "1" : "")}
						/>
						Include spoken word
					</label>
					{/* The lens draws on the same `visible` list the shelf does — it reorganizes
					    what is there rather than fetching a different corpus, which is what
					    keeps "a lens is a view" true rather than merely stated. The toggle is
					    passed in so the same rule holds of it: toggling re-scopes the view,
					    never the shelf. */}
					<MusicLens items={visible as LensItem[]} includeSpoken={includeSpoken} />
				</>
			) : lens === "video" ? (
				// Same rule as the music lens: the lens reorganizes what is on the shelf,
				// never fetches a different corpus. Drawing on `visible` is what keeps
				// "a lens is a view" true of the whole family of them.
				<VideoLens items={visible as LensItem[]} />
			) : filtered.length === 0 ? (
				<EmptyState
					title={
						activeTab
							? `No ${MEDIA_TABS.find((t) => t.id === activeTab)?.label.toLowerCase()} in your Library`
							: "Your Library is empty"
					}
					description={
						activeTab
							? "Nothing here yet — save something, or buy it, and it lands here."
							: "Save anything you want to keep. Free work included — you don't have to buy something to keep it."
					}
					action={
						<Link to="/discover" className="btn btn-primary btn-sm">
							Discover Content
						</Link>
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
