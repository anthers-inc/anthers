// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Works a post links, as an ordered, reorderable list.
 *
 * This replaced the post *content* editor, and the difference is the whole model. That
 * editor built a post's deliverable — an ordered list of text blocks and media the post
 * owned and gated. This builds a list of **references**: each Work already exists in the
 * Catalog, already carries its own gates and delivery, and is entirely unaffected by being
 * linked here. There is nothing to configure per entry, because a reference that carried
 * settings would be the post owning the Work again.
 */
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import type { Work } from "../../lib/types";
import WorkPicker from "../content/WorkPicker";
import { itemPreviewUrl, ProcessingBadge, TypeBadge, TypeIcon } from "../content/works";

interface PostWorkLinksProps {
	works: Work[];
	onChange: (next: Work[]) => void;
}

export default function PostWorkLinks({ works, onChange }: PostWorkLinksProps) {
	const [picking, setPicking] = useState(false);

	const add = (work: Work) => {
		setPicking(false);
		if (works.some((w) => w.id === work.id)) return; // one link per Work per post
		onChange([...works, work]);
	};

	const remove = (id: number) => onChange(works.filter((w) => w.id !== id));

	const move = (index: number, delta: number) => {
		const target = index + delta;
		if (target < 0 || target >= works.length) return;
		const next = [...works];
		[next[index], next[target]] = [next[target], next[index]];
		onChange(next);
	};

	return (
		<div className="space-y-3">
			{works.length === 0 && (
				<p className="text-sm text-base-content/60">
					No Works linked. A post doesn't need one — link a Work when you're announcing it.
				</p>
			)}

			<ul className="space-y-2">
				{works.map((work, i) => {
					const preview = itemPreviewUrl(work);
					return (
						<li
							key={work.id}
							className="flex items-center gap-3 rounded-lg border border-base-300 bg-base-100 p-2"
						>
							<div className="h-12 w-16 shrink-0 overflow-hidden rounded bg-base-200">
								{preview ? (
									<img src={preview} alt="" className="h-full w-full object-cover" />
								) : (
									<div className="flex h-full w-full items-center justify-center">
										<TypeIcon type={work.type} className="h-5 w-5 text-base-content/40" />
									</div>
								)}
							</div>

							<div className="min-w-0 flex-1">
								<div className="truncate text-sm font-medium">{work.title || "Untitled"}</div>
								<div className="mt-0.5 flex items-center gap-2">
									<TypeBadge type={work.type} />
									<ProcessingBadge item={work} />
									{work.visibility === "private" && (
										<span className="badge badge-ghost badge-xs">Not released</span>
									)}
								</div>
							</div>

							<div className="flex shrink-0 items-center gap-1">
								<button
									type="button"
									className="btn btn-ghost btn-xs btn-square"
									onClick={() => move(i, -1)}
									disabled={i === 0}
									aria-label="Move up"
								>
									<ArrowUpIcon className="h-4 w-4" />
								</button>
								<button
									type="button"
									className="btn btn-ghost btn-xs btn-square"
									onClick={() => move(i, 1)}
									disabled={i === works.length - 1}
									aria-label="Move down"
								>
									<ArrowDownIcon className="h-4 w-4" />
								</button>
								<button
									type="button"
									className="btn btn-ghost btn-xs btn-square text-error"
									onClick={() => remove(work.id)}
									aria-label="Remove link"
								>
									<XMarkIcon className="h-4 w-4" />
								</button>
							</div>
						</li>
					);
				})}
			</ul>

			<button type="button" className="btn btn-sm btn-outline" onClick={() => setPicking(true)}>
				<PlusIcon className="h-4 w-4" />
				Link a Work
			</button>

			<p className="text-xs text-base-content/50">
				Linking doesn't change who can open a Work — each one keeps its own access. A post can link
				something its readers can't open yet.
			</p>

			{picking && <WorkPicker onSelect={add} onClose={() => setPicking(false)} />}
		</div>
	);
}
