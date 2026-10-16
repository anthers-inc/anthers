// SPDX-License-Identifier: Apache-2.0
/**
 * The Studio's **Works** tab: the creator's Works, and the way to make another one.
 *
 * 🚨 **One object, one place** (Parker, 2026-10-10). This, the Projects page, and Posts were
 * one "Catalog" page with a Projects table above a Works grid, and each object now has its own
 * listing, its own New button and its own tab. A **Work** OWNS its media, downloadable builds
 * and transcodes, plus its own visibility, dates, delivery switches and access gates; posts and
 * Projects merely reference Works.
 *
 * The listing is a **table** (Parker, 2026-10-11), in the shape of YouTube Studio's Content
 * tab and modeled on it: rows tall enough to carry a small thumbnail, the title and
 * description beside it, then visibility, status, the upload date and the counts as
 * columns, sortable by header and filterable. The filters live in the left sidebar below
 * the Studio nav — the Feed page's pattern — rather than in tabs above the table; they ride
 * the URL as query parameters, and the table (client-side over the loaded list) re-derives
 * from them. The filtering and sorting themselves are `works-list.ts`'s, extracted so a
 * suite can fail on them.
 *
 * Processing state is derived from each Work's latest transcode and polled while anything is
 * still encoding.
 *
 * 🚨 **Catalog, not "Library".** The word is kept for the noun — a creator's whole body of
 * work — while the pages and tabs carry the object names. Library is a bound term meaning the
 * *user's* own owned content — see the wiki's *How Anthers Talks About Itself*. This page's
 * predecessor said "Content Library" until 2026-08-13.
 */
import { PlusIcon, RectangleStackIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useState } from "react";
import WorkRow from "../components/content/WorkRow";
import { processingState } from "../components/content/works";
import WorksFilterSections from "../components/content/works-filters";
import {
	arrangeWorks,
	DEFAULT_WORKS_SORT,
	type WorksSortKey,
} from "../components/content/works-list";
import EmptyState from "../components/ui/EmptyState";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { Link, useSearchParams } from "../lib/router";
import { client } from "../lib/rpc";
import { useSidebar } from "../lib/sidebar";
import { studioNewWorkUrl } from "../lib/studio";
import type { Work } from "../lib/types";
import { useWorkUploads } from "../lib/work-uploads";

/** A post referencing a library item, as returned by the 409 `work_in_use` body. */
interface UsingPost {
	slug: string;
	title: string | null;
	isPublished: boolean;
}

export default function WorksPage() {
	const [items, setItems] = useState<Work[]>([]);
	const [loading, setLoading] = useState(true);

	const [deleteTarget, setDeleteTarget] = useState<Work | null>(null);
	const [deleting, setDeleting] = useState(false);
	/** Posts blocking an unflagged delete — non-null once the server has named them. */
	const [inUse, setInUse] = useState<
		{ slug: string; title: string | null; isPublished: boolean }[] | null
	>(null);
	/** Completed purchases of this Work; null until the preflight answers. */
	const [sold, setSold] = useState<number | null>(null);
	/** Work id whose visibility flip is in flight, so only its own button disables. */
	const [releasing, setReleasing] = useState<number | null>(null);
	/** A refused release, kept beside the table — the server's reason, not a generic one. */
	const [releaseError, setReleaseError] = useState<string | null>(null);

	// The filters and the sort ride the URL, the Feed page's pattern — shareable, and
	// visible in the address bar when a creator has filtered to one kind.
	const [searchParams, setSearchParams] = useSearchParams();
	const q = searchParams.get("q") ?? "";
	const visibility = searchParams.get("visibility") ?? "";
	const contentType = searchParams.get("type") ?? "";
	const [sort, setSort] = useState<{ key: WorksSortKey; dir: "asc" | "desc" }>(DEFAULT_WORKS_SORT);

	const updateParams = useCallback(
		(updates: Record<string, string>) => {
			setSearchParams(
				(prev) => {
					const next = new URLSearchParams(prev);
					for (const [key, value] of Object.entries(updates)) {
						if (value) {
							next.set(key, value);
						} else {
							next.delete(key);
						}
					}
					return next;
				},
				{ replace: true },
			);
		},
		[setSearchParams],
	);

	// Repeat click on a sorted column flips it; a new column starts the way users expect
	// its data to read — names A→Z, numbers and dates high first.
	const onSort = (key: WorksSortKey) =>
		setSort((prev) =>
			prev.key === key
				? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
				: { key, dir: key === "title" ? "asc" : "desc" },
		);

	const fetchItems = useCallback(
		() =>
			client.api.content.works
				.$get()
				.then(async (res) => {
					if (!res.ok) return { works: [] as Work[] };
					return (await res.json()) as unknown as { works: Work[] };
				})
				.then((data) => setItems(data.works))
				.catch(() => setItems([])),
		[],
	);

	useEffect(() => {
		fetchItems().finally(() => setLoading(false));
	}, [fetchItems]);

	// Re-read when a file this tab was uploading lands on its Work. The row shows the upload
	// from the store while it runs, but the processing it starts is only on the row — and the
	// poll below switches on only once a row says something is processing.
	const landed = useWorkUploads().filter((u) => u.status === "done").length;
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-read on each upload that lands, and only then
	useEffect(() => {
		if (landed > 0) fetchItems();
	}, [landed]);

	// Catch up whenever the tab comes back into view — cheap, and it covers the case
	// where processing finished while the creator was looking at something else.
	// biome-ignore lint/correctness/useExhaustiveDependencies: fetchItems only closes over setItems
	useEffect(() => {
		const onVisible = () => {
			if (!document.hidden) fetchItems();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, []);

	// Poll while any item is still processing so its badge/players settle without a
	// refresh. Ticks are skipped while the tab is hidden — the visibility listener above
	// catches up on return, so nothing is missed and a backgrounded tab isn't polling.
	const anyProcessing = items.some((i) => processingState(i) === "processing");
	// biome-ignore lint/correctness/useExhaustiveDependencies: fetchItems only closes over setItems
	useEffect(() => {
		if (!anyProcessing) return;
		const interval = setInterval(() => {
			if (!document.hidden) fetchItems();
		}, 4000);
		return () => clearInterval(interval);
	}, [anyProcessing]);

	const upsert = (item: Work) =>
		setItems((prev) =>
			prev.some((i) => i.id === item.id)
				? prev.map((i) => (i.id === item.id ? item : i))
				: [item, ...prev],
		);

	/**
	 * Flip a Work between private and released, from the row.
	 *
	 * The server owns the preconditions — media finished encoding, at least one delivery
	 * switch on — and refuses with a specific message when they aren't met. Show that
	 * message: "can't release yet, the media is still processing" is something the creator
	 * can wait out, and a generic failure is not.
	 */
	const setVisibility = async (work: Work, visibility: "private" | "released") => {
		setReleasing(work.id);
		setReleaseError(null);
		try {
			const res = await client.api.content.works[":id"].$patch({
				param: { id: String(work.id) },
				json: { visibility },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setReleaseError(body?.error || "Couldn't change this Work's visibility.");
				return;
			}
			const { work: updated } = (await res.json()) as unknown as { work: Work };
			upsert(updated);
		} catch {
			setReleaseError("Couldn't change this Work's visibility.");
		} finally {
			setReleasing(null);
		}
	};

	/**
	 * Open the delete dialog, asking the server which posts use this item FIRST so the
	 * warning arrives before the decision rather than after it. Best-effort: if the
	 * preview call fails the dialog still opens, and the server's 409 remains the
	 * backstop that makes the destructive path impossible to take blind.
	 */
	const openDelete = async (item: Work) => {
		setDeleteTarget(item);
		setInUse(null);
		setSold(null);
		try {
			const res = await client.api.content.works[":id"].usage.$get({
				param: { id: String(item.id) },
			});
			if (res.ok) {
				const body = (await res.json()) as { posts: UsingPost[]; purchaseCount?: number };
				setInUse(body.posts ?? []);
				setSold(body.purchaseCount ?? 0);
			}
		} catch {
			// Preview is best-effort — the 409 still catches it on submit.
		}
	};

	/**
	 * Delete, forcing only once the creator has been shown what it costs.
	 *
	 * Two things can block an unflagged delete — posts referencing the Work, and people
	 * having bought it — and `force` overrides both, so it may only be sent when the
	 * dialog is actually displaying the corresponding warning.
	 */
	const confirmDelete = async () => {
		if (!deleteTarget) return;
		setDeleting(true);
		try {
			// Force once the dialog is actually SHOWING a warning — either one. Keyed on the
			// warnings being non-empty rather than merely fetched, because the preflight
			// populates both with "nothing here" for a clean item, and treating that as
			// confirmation would send `force` on every delete and defeat the server guard.
			const warned = (inUse && inUse.length > 0) || (sold !== null && sold > 0);
			const res = await client.api.content.works[":id"].$delete({
				param: { id: String(deleteTarget.id) },
				query: warned ? { force: "1" } : {},
			});
			if (res.ok) {
				// 204 = deleted, so drop it. 200 = WITHDRAWN, which means the Work is still
				// there in a different state — refetch rather than remove, or the row would
				// reappear on the next load and read as a delete that failed.
				if (res.status === 204) {
					setItems((prev) => prev.filter((i) => i.id !== deleteTarget.id));
				} else {
					await fetchItems();
				}
				setDeleteTarget(null);
				setInUse(null);
				setSold(null);
				return;
			}
			if (res.status === 409) {
				const body = (await res.json()) as {
					code?: string;
					posts?: UsingPost[];
					purchaseCount?: number;
				};
				// `work_in_use`, not `item_in_use` — the server renamed this code with the
				// Catalog rename and this branch was never updated, so the in-use 409 fell
				// through to the silent close below and the dialog just vanished.
				if (body.code === "work_in_use") {
					setInUse(body.posts ?? []);
					return;
				}
				if (body.code === "work_purchased") {
					setSold(body.purchaseCount ?? 0);
					return;
				}
			}
			setDeleteTarget(null);
		} finally {
			setDeleting(false);
		}
	};

	// The sidebar's filter sections, below the Studio nav — registered here, the Feed
	// page's mechanism. The sections read the URL, so they re-register as it changes.
	const { setPageContent } = useSidebar();
	const filters = useMemo(
		() => ({ q, visibility, type: contentType }),
		[q, visibility, contentType],
	);
	useEffect(() => {
		setPageContent(
			<WorksFilterSections
				items={items}
				q={filters.q}
				visibility={filters.visibility}
				contentType={filters.type}
				onUpdateParams={updateParams}
			/>,
		);
		return () => setPageContent(null);
	}, [setPageContent, items, filters, updateParams]);

	const rows = arrangeWorks(items, filters, sort.key, sort.dir);

	if (loading) {
		return (
			<div className="flex justify-center py-16">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	return (
		<div className="w-full px-6 py-6">
			<div className="flex items-center justify-between mb-4">
				<h2 className="text-lg font-semibold">Works</h2>
				<Link to={studioNewWorkUrl()} className="btn btn-primary btn-sm">
					<PlusIcon className="w-4 h-4" /> New Work
				</Link>
			</div>

			{releaseError && (
				<div className="alert alert-error text-sm mb-4">
					<span>{releaseError}</span>
				</div>
			)}

			{items.length === 0 ? (
				<EmptyState
					icon={<RectangleStackIcon className="w-12 h-12" />}
					title="Your Catalog is empty"
					description="Upload video, music and other audio, images, comics and books, games or software, or list physical goods and services. Each one is a Work you can release, gate or sell on its own — with or without ever writing a post about it."
					action={
						<Link to={studioNewWorkUrl()} className="btn btn-primary btn-sm">
							<PlusIcon className="w-4 h-4" /> New Work
						</Link>
					}
				/>
			) : rows.length === 0 ? (
				/* Every Work is filtered out — distinguishable from an empty Catalog, and
				   its remedy is a click, not an upload. */
				<div className="text-sm text-base-content/60">
					<p className="mb-2">No Works match these filters.</p>
					<button
						type="button"
						className="btn btn-ghost btn-sm"
						onClick={() => updateParams({ q: "", visibility: "", type: "" })}
					>
						Clear filters
					</button>
				</div>
			) : (
				<div className="overflow-x-auto">
					<table className="table w-full">
						<thead>
							<tr className="border-base-300/50 text-xs text-base-content/50">
								<th scope="col" aria-sort={ariaSort(sort, "title")}>
									<SortButton label="Work" k="title" sort={sort} onSort={onSort} />
								</th>
								<th scope="col" className="min-w-[14rem]">
									Description
								</th>
								<th scope="col">Visibility</th>
								<th scope="col">Status</th>
								<th scope="col" aria-sort={ariaSort(sort, "date")}>
									<SortButton label="Date" k="date" sort={sort} onSort={onSort} />
								</th>
								<th scope="col" aria-sort={ariaSort(sort, "views")}>
									<SortButton label="Views" k="views" sort={sort} onSort={onSort} />
								</th>
								<th scope="col">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((item) => (
								<WorkRow
									key={item.id}
									item={item}
									onDelete={(it) => openDelete(it)}
									onSetVisibility={setVisibility}
									busy={releasing === item.id}
								/>
							))}
						</tbody>
					</table>
				</div>
			)}

			{deleteTarget && (
				<div className="modal modal-open" role="dialog">
					<div className="modal-box">
						<h3 className="font-bold text-lg">
							{sold !== null && sold > 0 ? "Withdraw this work?" : "Delete content?"}
						</h3>
						<p className="py-3 text-sm text-base-content/70">
							{sold !== null && sold > 0
								? `"${deleteTarget.title || "Untitled"}" will be taken out of public circulation.`
								: `"${deleteTarget.title || "Untitled"}" and its media, builds, and transcodes will be permanently removed.`}
						</p>
						{sold !== null && sold > 0 && (
							<div className="alert alert-warning text-sm mb-2">
								<div>
									<p className="font-medium">
										{sold} {sold === 1 ? "person has" : "people have"} bought this.
									</p>
									<p className="mt-1">
										It leaves your Catalog and public view and can no longer be bought.{" "}
										{sold === 1 ? "The person who" : "People who"} already paid keep access to it.
									</p>
								</div>
							</div>
						)}
						{inUse && inUse.length > 0 && (
							<div className="alert alert-warning text-sm">
								<div>
									<p className="font-medium">
										Used by {inUse.length} post{inUse.length === 1 ? "" : "s"} — deleting it removes
										this content from {inUse.length === 1 ? "it" : "them"}:
									</p>
									<ul className="list-disc list-inside mt-1">
										{inUse.map((p) => (
											<li key={p.slug}>
												{p.title || "Untitled"}
												{p.isPublished ? " (published)" : " (draft)"}
											</li>
										))}
									</ul>
								</div>
							</div>
						)}
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost"
								onClick={() => {
									setDeleteTarget(null);
									setInUse(null);
									setSold(null);
								}}
								disabled={deleting}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-error"
								onClick={confirmDelete}
								disabled={deleting}
							>
								{deleting
									? sold !== null && sold > 0
										? "Withdrawing…"
										: "Deleting…"
									: (inUse && inUse.length > 0) || (sold !== null && sold > 0)
										? sold !== null && sold > 0
											? "Withdraw"
											: "Delete anyway"
										: "Delete"}
							</button>
						</div>
					</div>
					<button
						type="button"
						className="modal-backdrop"
						onClick={() => {
							setDeleteTarget(null);
							setInUse(null);
							setSold(null);
						}}
						aria-label="Close"
					>
						close
					</button>
				</div>
			)}
		</div>
	);
}

/** The `aria-sort` a column header carries, given the table's current sort. */
function ariaSort(sort: { key: WorksSortKey; dir: "asc" | "desc" }, key: WorksSortKey) {
	if (sort.key !== key) return undefined;
	return sort.dir === "asc" ? "ascending" : "descending";
}

/** A sortable column header. Not a link, not a plain button row — repeat click flips it. */
function SortButton({
	label,
	k,
	sort,
	onSort,
}: {
	label: string;
	k: WorksSortKey;
	sort: { key: WorksSortKey; dir: "asc" | "desc" };
	onSort: (key: WorksSortKey) => void;
}) {
	const active = sort.key === k;
	return (
		<button
			type="button"
			className="flex items-center gap-1 hover:text-base-content transition-colors"
			onClick={() => onSort(k)}
		>
			{label}
			<span className={active ? "" : "opacity-0"} aria-hidden="true">
				{active ? (sort.dir === "asc" ? "↑" : "↓") : "↓"}
			</span>
		</button>
	);
}
