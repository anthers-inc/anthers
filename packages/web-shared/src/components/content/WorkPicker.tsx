// SPDX-License-Identifier: Apache-2.0
/**
 * Work picker: a modal TABLE of the creator's Catalog, filterable by type, selected a
 * row at a time and added in one act.
 *
 * Used when a Project wants to SHELVE works. It confers nothing — no access, no
 * ownership — so picking here never changes what the Work costs or who can open it.
 * (The post that wanted to LINK a Work carried this modal once; that flow is being
 * removed — a post links no Work of its own.)
 *
 * The grid it replaced could pick strictly one Work per pass, with no order and no
 * dates — a creator adding an album's twelve tracks walked the modal twelve times
 * (Parker, 2026-10-17). Now: rows click to toggle, the footer's button adds everything
 * ticked, and a Work already in the Project is excluded by the caller. Like its caller, a
 * picker picks and nothing else — no create path; making a Work is `/studio/works/new`'s
 * job, and realizing mid-arrangement that one does not exist is a reason to go and come back.
 *
 * Columns follow the Studio's Works table, narrowed to what adding a member needs:
 * thumbnail · title · work type · status · the two dates in one column (the release
 * date, with the original release date above it when the Work names one).
 */
import { useEffect, useState } from "react";
import { client } from "../../lib/rpc";
import type { UploadableWorkType, Work } from "../../lib/types";
import LoadingSpinner from "../ui/LoadingSpinner";
import Modal from "../ui/Modal";
import { itemPreviewUrl, LIBRARY_TYPE_OPTIONS, ProcessingBadge, TypeIcon } from "./works";

interface WorkPickerProps {
	/** Kept mounted while this is false so the shared wrapper can play the exit. */
	open: boolean;
	/** Everything selected, in the order it was ticked — the order the adds are sent in. */
	onSelect: (works: Work[]) => void;
	onClose: () => void;
	/** Works already in the Project, shown nowhere: picking one again is an error today. */
	excludeIds?: number[];
}

export default function WorkPicker({ open, onSelect, onClose, excludeIds = [] }: WorkPickerProps) {
	const [items, setItems] = useState<Work[]>([]);
	const [loading, setLoading] = useState(true);
	const [typeFilter, setTypeFilter] = useState<"all" | UploadableWorkType>("all");
	/** The selection, as a set for O(1) row toggles and a list for the confirm's order. */
	const [picked, setPicked] = useState<number[]>([]);

	// Each open starts a fresh pick: the catalog is fetched again (a Work made since the
	// last open belongs here) and nothing is still ticked from the previous pass.
	useEffect(() => {
		if (!open) return;
		let live = true;
		setLoading(true);
		setPicked([]);
		setTypeFilter("all");
		client.api.content.works
			.$get()
			.then(async (res) => {
				if (!res.ok) return { works: [] as Work[] };
				return (await res.json()) as unknown as { works: Work[] };
			})
			.then((data) => {
				if (live) setItems(data.works);
			})
			.catch(() => {
				if (live) setItems([]);
			})
			.finally(() => {
				if (live) setLoading(false);
			});
		return () => {
			live = false;
		};
	}, [open]);

	const catalog = items.filter((i) => !excludeIds.includes(i.id));
	const filtered = typeFilter === "all" ? catalog : catalog.filter((i) => i.type === typeFilter);

	const toggle = (id: number) => {
		setPicked((prev) => (prev.includes(id) ? prev.filter((n) => n !== id) : [...prev, id]));
	};

	// Resolve the confirm's payload through the unfiltered catalog: an id ticked under one
	// type filter stays selected when the filter moves, and stays addable when it moves back.
	const selectedWorks = picked
		.map((id) => items.find((i) => i.id === id))
		.filter((w) => w !== undefined && w !== null);
	const pickedSet = new Set(picked);

	return (
		<Modal open={open} label="Add Works">
			<div className="modal-box max-w-4xl max-h-[90vh] flex flex-col gap-4">
				<div className="flex items-center justify-between">
					<h2 className="text-lg font-bold">Add Works</h2>
					<button
						type="button"
						className="btn btn-sm btn-circle btn-ghost"
						onClick={onClose}
						aria-label="Close"
					>
						✕
					</button>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<select
						className="select select-bordered select-sm"
						aria-label="Filter by work type"
						value={typeFilter}
						onChange={(e) => setTypeFilter(e.target.value as "all" | UploadableWorkType)}
					>
						<option value="all">All types</option>
						{LIBRARY_TYPE_OPTIONS.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>
					<span className="text-xs text-base-content/50">
						Click a work to select or unselect it.
					</span>
				</div>

				<div className="overflow-y-auto pr-1">
					{loading ? (
						<div className="flex justify-center py-12">
							<LoadingSpinner size="lg" />
						</div>
					) : filtered.length === 0 ? (
						<p className="text-sm text-base-content/50 text-center py-12">
							{items.length === 0
								? "Your Catalog is empty. Make a Work and it shows up here."
								: catalog.length === 0
									? "Every Work you have is already in this Project."
									: "No Works of this type. Try another filter."}
						</p>
					) : (
						<table className="table table-sm w-full">
							<thead>
								<tr className="border-base-300/50 text-xs text-base-content/50">
									<th scope="col">
										<span className="sr-only">Selected</span>
									</th>
									<th scope="col" className="w-20">
										Thumbnail
									</th>
									<th scope="col">Title</th>
									<th scope="col">Work type</th>
									<th scope="col">Status</th>
									<th scope="col" className="min-w-[10rem]">
										Release date
									</th>
								</tr>
							</thead>
							<tbody>
								{filtered.map((item) => {
									const original = item.originallyReleased
										? new Date(item.originallyReleased).toLocaleDateString("en-US", {
												timeZone: "UTC",
											})
										: null;
									return (
										// The row is the toggle: a click on any part of it selects or
										// unselects, with the checkbox in the first column as the row's
										// own readable state (and the way a screen reader meets it).
										<tr
											key={item.id}
											tabIndex={0}
											onClick={() => toggle(item.id)}
											onKeyDown={(e) => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault();
													toggle(item.id);
												}
											}}
											className={`cursor-pointer hover:bg-base-200/50 ${
												pickedSet.has(item.id) ? "bg-primary/10 border-l-2 border-l-primary" : ""
											}`}
										>
											<td>
												<input
													type="checkbox"
													aria-label={`Select ${item.title || "Untitled"}`}
													className="checkbox checkbox-sm"
													checked={pickedSet.has(item.id)}
													// The checkbox is a real toggle — the row's click and this
													// box's change are one act on two surfaces, and the
													// stopPropagation keeps the two from stacking into a double.
													onChange={() => toggle(item.id)}
													onClick={(e) => e.stopPropagation()}
												/>
											</td>
											<td>
												{itemPreviewUrl(item) ? (
													<img
														src={itemPreviewUrl(item) ?? ""}
														alt=""
														className="h-10 w-14 rounded object-cover"
													/>
												) : (
													<TypeIcon type={item.type} className="h-6 w-6 text-base-content/25" />
												)}
											</td>
											<td
												className="max-w-[16rem] truncate font-medium"
												title={item.title ?? undefined}
											>
												{item.title || "Untitled"}
											</td>
											<td className="text-sm">{item.type}</td>
											<td>
												{item.visibility === "released" ? (
													<span className="badge badge-sm badge-ghost">Released</span>
												) : (
													<span
														className="badge badge-sm badge-neutral"
														title="Private — nobody but you sees this in the Project"
													>
														Private
													</span>
												)}
												{(item.transcoding?.status === "pending" ||
													item.transcoding?.status === "processing") && (
													<ProcessingBadge item={item} />
												)}
											</td>
											<td className="text-sm">
												<div className="flex flex-col">
													{original && (
														<span title="Original release date" className="text-xs">
															Original: {original}
														</span>
													)}
													<span>
														{item.releasedAt
															? new Date(item.releasedAt).toLocaleDateString("en-US", {
																	timeZone: "UTC",
																})
															: "—"}
													</span>
												</div>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					)}
				</div>

				<div className="flex items-center justify-between border-t border-base-300 pt-3">
					<span className="text-sm text-base-content/60">{selectedWorks.length} selected</span>
					<div className="flex items-center gap-2">
						<button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
							Cancel
						</button>
						<button
							type="button"
							className="btn btn-primary btn-sm"
							disabled={selectedWorks.length === 0}
							onClick={() => {
								onSelect(selectedWorks);
								onClose();
							}}
						>
							Add Work(s)
						</button>
					</div>
				</div>
			</div>
			<button type="button" className="modal-backdrop" onClick={onClose} aria-label="Close">
				close
			</button>
		</Modal>
	);
}
