// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Work picker: a modal grid of the creator's Catalog (filterable by type), plus a quiet
 * second action that makes a new one without leaving.
 *
 * Used when a post wants to LINK a Work and when a Project wants to SHELVE one. Neither
 * confers anything — no access, no ownership — so picking here never changes what the Work
 * costs or who can open it. The verb differs between the two, which is why the heading
 * takes one rather than always saying "Link".
 *
 * 🚨 **Picking is this dialog's job; creating is the lesser path** (Parker, 2026-09-11).
 * `QuickWorkCreate` is a ghost button rather than a primary one, and it makes a deliberately
 * minimal Work, because the good flow is the Work's own page at `/studio/works/new`. This
 * used to swap itself for the full twelve-section editor two modals deep.
 */
import { PlusIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { Link } from "../../lib/router";
import { client } from "../../lib/rpc";
import { studioEditWorkUrl } from "../../lib/studio";
import type { UploadableWorkType, Work } from "../../lib/types";
import LoadingSpinner from "../ui/LoadingSpinner";
import QuickWorkCreate from "./QuickWorkCreate";
import {
	itemPreviewUrl,
	LIBRARY_TYPE_OPTIONS,
	ProcessingBadge,
	TypeBadge,
	TypeIcon,
} from "./works";

interface WorkPickerProps {
	onSelect: (item: Work) => void;
	onClose: () => void;
	/**
	 * What picking does here, in the caller's own word. A post **links** a Work and a
	 * Project **adds** one to its shelf, and a dialog headed "Link a Work" opened by a
	 * button reading "Add a Work" is the two halves of one action disagreeing.
	 */
	verb?: "link" | "add";
}

export default function WorkPicker({ onSelect, onClose, verb = "link" }: WorkPickerProps) {
	const [items, setItems] = useState<Work[]>([]);
	const [loading, setLoading] = useState(true);
	const [typeFilter, setTypeFilter] = useState<"all" | UploadableWorkType>("all");
	const [creating, setCreating] = useState(false);
	/** A Work just made here, so the dialog can offer the page that finishes it. */
	const [justCreated, setJustCreated] = useState<Work | null>(null);

	useEffect(() => {
		client.api.content.works
			.$get()
			.then(async (res) => {
				if (!res.ok) return { works: [] as Work[] };
				return (await res.json()) as unknown as { works: Work[] };
			})
			.then((data) => setItems(data.works))
			.catch(() => setItems([]))
			.finally(() => setLoading(false));
	}, []);

	const filtered = typeFilter === "all" ? items : items.filter((i) => i.type === typeFilter);

	if (creating) {
		return (
			<QuickWorkCreate
				onCreated={(work) => {
					setCreating(false);
					setJustCreated(work);
					onSelect(work);
				}}
				onClose={() => setCreating(false)}
			/>
		);
	}

	return (
		<div className="modal modal-open" role="dialog">
			<div className="modal-box max-w-3xl max-h-[90vh] flex flex-col gap-4">
				<div className="flex items-center justify-between">
					<h2 className="text-lg font-bold">{verb === "add" ? "Add a Work" : "Link a Work"}</h2>
					<button
						type="button"
						className="btn btn-sm btn-circle btn-ghost"
						onClick={onClose}
						aria-label="Close"
					>
						✕
					</button>
				</div>

				{justCreated && (
					<div className="alert alert-info text-sm">
						<span>
							“{justCreated.title || "Untitled"}” is made and attached, and it is private until you
							give it access and release it.{" "}
							<Link to={studioEditWorkUrl(justCreated.publicId ?? justCreated.id)} className="link">
								Finish setting it up
							</Link>
							.
						</span>
					</div>
				)}

				<div className="flex flex-wrap items-center gap-2">
					<select
						className="select select-bordered select-sm"
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
					{/* Ghost, and to the right of the filter rather than beside the grid: picking is
					    what this dialog is for, and the better way to make a Work is its own page. */}
					<button
						type="button"
						className="btn btn-ghost btn-sm ml-auto"
						onClick={() => setCreating(true)}
					>
						<PlusIcon className="w-4 h-4" /> New Work
					</button>
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
								: "No Works of this type. Try another filter."}
						</p>
					) : (
						<div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
							{filtered.map((item) => (
								<button
									type="button"
									key={item.id}
									onClick={() => onSelect(item)}
									className="text-left card bg-base-100 border border-base-300 hover:border-primary overflow-hidden"
								>
									<div className="aspect-video bg-base-200 flex items-center justify-center overflow-hidden">
										{itemPreviewUrl(item) ? (
											<img
												src={itemPreviewUrl(item) ?? ""}
												alt={item.title ?? ""}
												className="w-full h-full object-cover"
											/>
										) : (
											<TypeIcon type={item.type} className="w-10 h-10 text-base-content/30" />
										)}
									</div>
									<div className="p-2 gap-1 flex flex-col">
										<span className="text-sm font-medium truncate" title={item.title ?? undefined}>
											{item.title || "Untitled"}
										</span>
										<div className="flex flex-wrap items-center gap-1">
											<TypeBadge type={item.type} />
											<ProcessingBadge item={item} />
										</div>
									</div>
								</button>
							))}
						</div>
					)}
				</div>
			</div>
			<button type="button" className="modal-backdrop" onClick={onClose} aria-label="Close">
				close
			</button>
		</div>
	);
}
