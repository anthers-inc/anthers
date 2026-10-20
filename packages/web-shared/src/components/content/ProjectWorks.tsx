// SPDX-License-Identifier: Apache-2.0
/**
 * The Works on a Project's shelf — an ordered list the owner arranges by dragging, and
 * reads through one of four sort modes.
 *
 * ⭐ **The chosen sort is the Project's, and it governs what readers see** (Parker,
 * 2026-10-19, replacing the 2026-10-17 "Manual is the only real order" ruling): changing
 * the dropdown saves the mode on the Project row and the API serializes the members in
 * that order for every reader. Manual is the default and the stored drag order, so the
 * handles stay the way a creator arranged them until they choose otherwise; a non-manual
 * mode is a named reading order over the same shelf and never rewrites `sortOrder`.
 *
 * Lives on the Project's own page now (the unified-editor pass, 2026-10-17): a creator
 * visiting their project sees this as the working surface where users see the grid or
 * the album record. A Project's shelf is NOT a form-held list — the post builder used
 * to hold one, and it is what this design was considered against and rejected:
 * membership here has its own endpoints and **persists immediately**, the way the builds
 * section of the Work editor does. The reason is the Project form: a creator adding
 * twelve tracks should not lose them to a failed save on an unrelated field, and a list
 * that persists per-action can't.
 *
 * Drag is Manual's alone — a saved reading order is not an arrangement, so switching to
 * Manual is what restores the handles and shows the stored order. The Ascending/Descending
 * pair stays visible but disabled under Manual, so the control's shape does not jump
 * between modes.
 *
 * The picker it opens is multi-select: tick every Work, then one act adds them all —
 * each member arriving at the shelf's end, positions assigned by the server in turn.
 *
 * A Project is a shelf: adding a Work here changes nothing about who can open it, and
 * removing it never touches the Work — it stays in the Catalog, released, with its gates.
 */

import {
	moveShelfItem,
	type ShelfSortDirection,
	type ShelfSortMode,
	sortShelf,
} from "@anthers/shared/project-shelf-sort";
import { Bars3Icon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { client } from "../../lib/rpc";
import type { Project, ProjectWork, Work } from "../../lib/types";
import LoadingSpinner from "../ui/LoadingSpinner";
import WorkPicker from "./WorkPicker";
import { itemPreviewUrl, ProcessingBadge, TypeBadge, TypeIcon } from "./works";

/**
 * The sort modes a shelf's dropdown offers, in display order. Keys read by
 * `sortShelf`; the direction pair under Manual is disabled, not hidden.
 */
export const SHELF_SORT_OPTIONS: Array<{ mode: ShelfSortMode; label: string }> = [
	{ mode: "manual", label: "Manual" },
	{ mode: "released", label: "Release Date" },
	{ mode: "original", label: "Original Release Date" },
	{ mode: "title", label: "Alphabetical" },
];

export default function ProjectWorks({ projectSlug }: { projectSlug: string }) {
	const [works, setWorks] = useState<ProjectWork[]>([]);
	const [loading, setLoading] = useState(true);
	const [picking, setPicking] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The reading arrangement, read from the Project's saved setting and written back to
	// it when changed. Manual is the stored drag order; everything else re-derives the
	// view on every render — nothing below ever writes `works` from a sort.
	const [sortMode, setSortMode] = useState<ShelfSortMode>("manual");
	const [sortDirection, setSortDirection] = useState<ShelfSortDirection>("asc");
	/** Where the drag started, in the stored list's own indices; cleared on every end. */
	const dragFrom = useRef<number | null>(null);

	useEffect(() => {
		let live = true;
		client.api.content.projects[":slug"]
			.$get({ param: { slug: projectSlug } })
			.then(async (res) => {
				if (!res.ok) return;
				const { project } = (await res.json()) as unknown as { project: Project };
				if (!live) return;
				/*
				 * The detail response arrives already sorted by the Project's saved setting.
				 * The shelf's own state is the STORED order, because that is what a drag
				 * edits and what the reorder endpoint persists — so restore it by the
				 * membership's `sortOrder`, then let the mode render a view over it.
				 */
				setWorks([...(project.works ?? [])].sort((a, b) => a.sortOrder - b.sortOrder));
				setSortMode(project.worksSortMode ?? "manual");
				setSortDirection(project.worksSortDirection ?? "asc");
			})
			.catch(() => {})
			.finally(() => live && setLoading(false));
		return () => {
			live = false;
		};
	}, [projectSlug]);

	/**
	 * Save one sort setting on the Project. Optimistic, and reverted on failure — the
	 * same rule the drag uses, because a dropdown that visibly changed and then silently
	 * did not save is the worst of both.
	 */
	const saveSort = async (
		fields: { worksSortMode?: ShelfSortMode; worksSortDirection?: ShelfSortDirection },
		revert: () => void,
	) => {
		setError(null);
		try {
			const res = await client.api.content.projects[":slug"].$patch({
				param: { slug: projectSlug },
				json: fields,
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				revert();
				setError(body?.error || "Couldn't save the sort.");
			}
		} catch {
			revert();
			setError("Couldn't save the sort.");
		}
	};

	const add = async (picked: Work[]) => {
		setPicking(false);
		// One membership per Work; the picker excludes shelf members, but a row may have
		// joined while the modal stood open, so the filter runs again here.
		const fresh = picked.filter((w) => !works.some((existing) => existing.id === w.id));
		if (fresh.length === 0) return;
		setBusy(true);
		setError(null);
		try {
			const answers: ProjectWork[] = [];
			for (const work of fresh) {
				const res = await client.api.content.projects[":slug"].works.$post({
					param: { slug: projectSlug },
					json: { workId: work.id },
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => null)) as { error?: string } | null;
					setError(body?.error || "Couldn't add that Work.");
					break;
				}
				const { projectItem } = (await res.json()) as { projectItem: { sortOrder: number } };
				answers.push({ ...(work as ProjectWork), sortOrder: projectItem.sortOrder });
			}
			// The server assigned every position it accepted; adopt them rather than guessing.
			if (answers.length > 0) setWorks((prev) => [...prev, ...answers]);
		} catch {
			setError("Couldn't add that Work.");
		} finally {
			setBusy(false);
		}
	};

	const remove = async (id: number) => {
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.content.projects[":slug"].works[":workId"].$delete({
				param: { slug: projectSlug, workId: String(id) },
			});
			if (!res.ok) {
				setError("Couldn't remove that Work.");
				return;
			}
			setWorks((prev) => prev.filter((w) => w.id !== id));
		} catch {
			setError("Couldn't remove that Work.");
		} finally {
			setBusy(false);
		}
	};

	/**
	 * Persist one drag as the shelf's whole order.
	 *
	 * Optimistic, and reverted on failure — the alternative is a list that visibly reorders
	 * and then silently isn't saved, which is the worst of both. The server takes the
	 * complete order rather than a delta, so this sends every id: a partial list would let
	 * an unlisted member keep a position that now collides with an assigned one.
	 *
	 * Only ever called from Manual, where the displayed list IS the stored array — the
	 * indices a drag carries are stored-order indices, which is what makes the two safe
	 * to conflate here.
	 */
	const move = async (from: number, to: number) => {
		if (to === from) return;
		const before = works;
		const next = moveShelfItem(works, from, to).map((w, i) => ({ ...w, sortOrder: i }));
		setWorks(next);
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.content.projects[":slug"].works.reorder.$post({
				param: { slug: projectSlug },
				json: { workIds: next.map((w) => w.id) },
			});
			if (!res.ok) {
				setWorks(before);
				setError("Couldn't save the new order.");
			}
		} catch {
			setWorks(before);
			setError("Couldn't save the new order.");
		} finally {
			setBusy(false);
		}
	};

	if (loading) {
		return (
			<div className="flex justify-center py-6">
				<LoadingSpinner size="sm" />
			</div>
		);
	}

	const manual = sortMode === "manual";
	const displayed = sortShelf(works, sortMode, sortDirection);

	return (
		<div className="space-y-3">
			{error && (
				<div className="alert alert-error text-sm">
					<span>{error}</span>
				</div>
			)}

			{/* The shelf's controls. Direction stays visible and disabled under Manual so the
			    layout holds across modes; drag is Manual's, so the handles below carry it. */}
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<span className="text-sm text-base-content/60">Sort</span>
					<select
						aria-label="Sort the works"
						className="select select-bordered select-sm"
						value={sortMode}
						onChange={(e) => {
							const next = e.target.value as ShelfSortMode;
							const before = sortMode;
							setSortMode(next);
							void saveSort({ worksSortMode: next }, () => setSortMode(before));
						}}
					>
						{SHELF_SORT_OPTIONS.map((opt) => (
							<option key={opt.mode} value={opt.mode}>
								{opt.label}
							</option>
						))}
					</select>
					<select
						aria-label="Works sort direction"
						className="select select-bordered select-sm disabled:opacity-50"
						value={sortDirection}
						disabled={manual}
						onChange={(e) => {
							const next = e.target.value as ShelfSortDirection;
							const before = sortDirection;
							setSortDirection(next);
							void saveSort({ worksSortDirection: next }, () => setSortDirection(before));
						}}
					>
						<option value="asc">Ascending</option>
						<option value="desc">Descending</option>
					</select>
				</div>
				<button
					type="button"
					className="btn btn-outline btn-sm"
					onClick={() => setPicking(true)}
					disabled={busy}
				>
					<PlusIcon className="w-4 h-4" /> Add a Work
				</button>
			</div>

			{works.length === 0 && (
				<p className="text-sm text-base-content/60">
					No Works yet. A Project is a shelf — put the album's tracks, the game's builds or the
					chapters of a book on it, and they keep whatever access you already gave them.
				</p>
			)}

			{/* The list names itself for the tests' role-targeting and for a screen reader
			    over a page whose other lists (menus) are not shelves. */}
			<ul aria-label="Works on this Project" className="space-y-2">
				{displayed.map((work, i) => {
					const preview = itemPreviewUrl(work);
					// Manual renders the stored array in stored order, so the displayed index is
					// the stored index — the claim `move`'s comment rests on.
					const storedIndex = manual ? i : works.findIndex((w) => w.id === work.id);
					return (
						<li
							key={work.id}
							className="flex items-center gap-3 rounded-lg border border-base-300 bg-base-100 p-2"
							onDragOver={(e) => e.preventDefault()}
							onDrop={(e) => {
								e.preventDefault();
								const from = dragFrom.current;
								dragFrom.current = null;
								if (from !== null && from !== storedIndex) void move(from, storedIndex);
							}}
						>
							{/* The grip is the drag source a native HTML5 drag needs (the sidebar
							    nav's pattern). Keyboard reorder is not built; the gap is named in
							    the task. */}
							<span
								title={manual ? "Drag to reorder" : "Sorting is Manual's — switch back to drag"}
								aria-hidden="true"
								draggable={manual}
								onDragStart={(e) => {
									if (!manual) {
										e.preventDefault();
										return;
									}
									e.dataTransfer.effectAllowed = "move";
									e.dataTransfer.setData("text/plain", String(work.id));
									dragFrom.current = storedIndex;
								}}
								onDragEnd={() => {
									dragFrom.current = null;
								}}
								className={
									manual
										? "cursor-grab px-1.5 text-base-content/25 hover:text-base-content/50 transition-colors self-stretch flex items-center active:cursor-grabbing"
										: "px-1.5 text-base-content/10 self-stretch flex items-center"
								}
							>
								<Bars3Icon className="w-3.5 h-3.5 rotate-90 pointer-events-none" />
							</span>
							<div className="h-12 w-16 shrink-0 overflow-hidden rounded bg-base-200 flex items-center justify-center">
								{preview ? (
									<img src={preview} alt="" className="h-full w-full object-cover" />
								) : (
									<TypeIcon type={work.type} className="w-5 h-5 text-base-content/30" />
								)}
							</div>
							<div className="min-w-0 flex-1">
								<p className="truncate text-sm font-medium">{work.title || "Untitled"}</p>
								<div className="mt-1 flex flex-wrap items-center gap-1">
									<TypeBadge type={work.type} />
									{/*
									 * Visibility only — deliberately NOT the Catalog's `AccessBadge`.
									 *
									 * 🚨 That badge reads `access`, and this list comes from the
									 * user-facing serializer, which withholds the creator's access table
									 * on purpose. Using it here reported **"Nobody can open"** for three
									 * Works that were plainly Public Access — a confident, entirely wrong
									 * label, and one no error would ever have surfaced.
									 *
									 * Visibility is the field this endpoint genuinely provides, and it is
									 * also the one that matters while arranging a shelf: a private member is
									 * invisible to everyone but its creator. Gates belong to the Work and
									 * are edited in the Catalog.
									 */}
									{work.visibility !== "released" && (
										<span
											className="badge badge-sm badge-neutral"
											title="Private — nobody but you sees this on the shelf"
										>
											Private
										</span>
									)}
									<ProcessingBadge item={work} />
								</div>
							</div>
							<button
								type="button"
								className="btn btn-ghost btn-xs text-error"
								onClick={() => remove(work.id)}
								disabled={busy}
								aria-label={`Remove ${work.title || "Untitled"}`}
							>
								<XMarkIcon className="w-4 h-4" />
							</button>
						</li>
					);
				})}
			</ul>

			<p className="text-xs text-base-content/50">
				Changes here save immediately, separately from the rest of this form.
			</p>

			{picking && (
				<WorkPicker
					excludeIds={works.map((w) => w.id)}
					onSelect={add}
					onClose={() => setPicking(false)}
				/>
			)}
		</div>
	);
}
