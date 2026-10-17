// SPDX-License-Identifier: Apache-2.0
/**
 * The Works on a Project's shelf — an ordered list the owner arranges by dragging, and
 * reads through one of four sort modes.
 *
 * Lives on the Project's own page now (the unified-editor pass, 2026-10-17): a creator
 * visiting their project sees this as the working surface where users see the grid or
 * the album record. Deliberately NOT modeled on `PostWorkLinks`, which looks like the
 * same component and isn't. That one holds form state and saves with the post;
 * membership here has its own endpoints and **persists immediately**, the way the builds
 * section of the Work editor does. The reason is the Project form: a creator adding
 * twelve tracks should not lose them to a failed save on an unrelated field, and a list
 * that persists per-action can't.
 *
 * 🚨 **Manual is the only real order** (Parker, 2026-10-17). The dropdown's other modes —
 * Release Date, Original Release Date, Alphabetical — are read-only views over the SAME
 * shelf: `sortShelf` copies and never writes, a drag is offered only in Manual, and no
 * mode change touches the reorder endpoint. The Ascending/Descending pair stays visible
 * but disabled under Manual, so the control's shape does not jump between modes.
 *
 * The picker it opens is multi-select: tick every Work, then one act adds them all —
 * each member arriving at the shelf's end, positions assigned by the server in turn.
 *
 * A Project is a shelf: adding a Work here changes nothing about who can open it, and
 * removing it never touches the Work — it stays in the Catalog, released, with its gates.
 */
import { Bars3Icon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { client } from "../../lib/rpc";
import type { Project, ProjectWork, Work } from "../../lib/types";
import LoadingSpinner from "../ui/LoadingSpinner";
import {
	moveShelfItem,
	type ShelfSortDirection,
	type ShelfSortMode,
	sortShelf,
} from "./project-shelf-sort";
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
	// The reading arrangement. Manual is the shelf; everything else is a view of it,
	// re-derived here on every render — nothing below ever writes `works` from a sort.
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
				if (live) setWorks(project.works ?? []);
			})
			.catch(() => {})
			.finally(() => live && setLoading(false));
		return () => {
			live = false;
		};
	}, [projectSlug]);

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
						onChange={(e) => setSortMode(e.target.value as ShelfSortMode)}
					>
						{SHELF_SORT_OPTIONS.map((opt) => (
							<option key={opt.mode} value={opt.mode}>
								{opt.label}
							</option>
						))}
					</select>
					<select
						aria-label="Sort direction"
						className="select select-bordered select-sm disabled:opacity-50"
						value={sortDirection}
						disabled={manual}
						onChange={(e) => setSortDirection(e.target.value as ShelfSortDirection)}
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

			<ul className="space-y-2">
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
