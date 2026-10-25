// SPDX-License-Identifier: Apache-2.0
/**
 * Post picker: a modal TABLE of the creator's own posts, searchable, selected a row at
 * a time and added in one act.
 *
 * The counterpart of `WorkPicker` on a Project's posts list — the same multi-select
 * contract (tick rows, one footer act), narrowed to what a post is: no type, no gate,
 * no delivery, so a search box is what finds the devlog they mean and the table's other
 * columns are state (status) and time.
 *
 * ⚠️ **No "new post" affordance here, and never one.** A Work can be made in thirty
 * seconds from a file, so realizing mid-arrangement that one does not exist yet is a real
 * interruption worth absorbing. A post is prose — writing one is the task, not a step
 * inside another one — and this picker retired every create path long before the Work
 * picker agreed (see its own docblock): a picker picks, and making the thing is always
 * its own page's job.
 */
import { useEffect, useState } from "react";
import { client } from "../../lib/rpc";
import type { PostListItem } from "../../lib/types";
import LoadingSpinner from "../ui/LoadingSpinner";

interface PostPickerProps {
	/** Ids already in the Project, so they are offered nowhere: a repeat add errors today. */
	excludeIds: number[];
	/** Everything selected, in the order it was ticked — the order the adds are sent in. */
	onSelect: (posts: PostListItem[]) => void;
	onClose: () => void;
}

export default function PostPicker({ excludeIds, onSelect, onClose }: PostPickerProps) {
	const [posts, setPosts] = useState<PostListItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [query, setQuery] = useState("");
	/** The selection, as a list for the confirm's order and a set for the row's state. */
	const [picked, setPicked] = useState<number[]>([]);

	useEffect(() => {
		let live = true;
		void (async () => {
			try {
				const res = await client.api.content.posts.$get({ query: { mine: "true" } });
				const d = (await res.json()) as { posts?: PostListItem[] };
				if (live) setPosts(d.posts ?? []);
			} catch {
			} finally {
				if (live) setLoading(false);
			}
		})();
		return () => {
			live = false;
		};
	}, []);

	const term = query.trim().toLowerCase();
	const available = posts.filter((p) => !excludeIds.includes(p.id));
	const shown = term
		? available.filter((p) => (p.title || "Untitled").toLowerCase().includes(term))
		: available;

	const toggle = (id: number) => {
		setPicked((prev) => (prev.includes(id) ? prev.filter((n) => n !== id) : [...prev, id]));
	};

	// Resolve the confirm's payload through the unfiltered list: a post ticked under one
	// search stays selected — and stays addable — when the search moves.
	const selectedPosts = picked
		.map((id) => posts.find((p) => p.id === id))
		.filter((p) => p !== undefined && p !== null);
	const pickedSet = new Set(picked);

	const statusOf = (post: PostListItem) =>
		post.isPublished ? (
			<span className="badge badge-sm badge-ghost">Published</span>
		) : (
			<span className="badge badge-sm badge-neutral">
				{post.scheduledFor ? "Scheduled" : "Draft"}
			</span>
		);

	return (
		<div className="modal modal-open" role="dialog">
			<div className="modal-box flex max-h-[90vh] max-w-3xl flex-col gap-4">
				<div className="flex items-center justify-between">
					<h2 className="text-lg font-bold">Add posts</h2>
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
					<input
						type="search"
						className="input input-bordered input-sm w-full"
						aria-label="Search your posts"
						placeholder="Search your posts"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
					<span className="text-xs text-base-content/50">
						Click a post to select or unselect it.
					</span>
				</div>

				<div className="overflow-y-auto pr-1">
					{loading ? (
						<div className="flex justify-center py-12">
							<LoadingSpinner size="lg" />
						</div>
					) : shown.length === 0 ? (
						<p className="py-12 text-center text-sm text-base-content/50">
							{posts.length === 0
								? "You haven't written any posts yet."
								: available.length === 0
									? "Every post you have written is already in this Project."
									: "No posts match that."}
						</p>
					) : (
						<table className="table table-sm w-full">
							<thead>
								<tr className="border-base-300/50 text-xs text-base-content/50">
									<th scope="col">
										<span className="sr-only">Selected</span>
									</th>
									<th scope="col">Title</th>
									<th scope="col">Status</th>
									<th scope="col" className="min-w-[10rem]">
										Release date
									</th>
								</tr>
							</thead>
							<tbody>
								{shown.map((post) => (
									// The row is the toggle, exactly as the Work picker's row is; the
									// checkbox in the first column is the state a screen reader meets.
									<tr
										key={post.id}
										tabIndex={0}
										onClick={() => toggle(post.id)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												toggle(post.id);
											}
										}}
										className={`cursor-pointer hover:bg-base-200/50 ${
											pickedSet.has(post.id) ? "bg-primary/10 border-l-2 border-l-primary" : ""
										}`}
									>
										<td>
											<input
												type="checkbox"
												aria-label={`Select ${post.displayTitle || post.title || "Untitled"}`}
												className="checkbox checkbox-sm"
												checked={pickedSet.has(post.id)}
												// The checkbox is a real toggle — the row's click and this
												// box's change are one act on two surfaces, and the
												// stopPropagation keeps the two from stacking into a double.
												onChange={() => toggle(post.id)}
												onClick={(e) => e.stopPropagation()}
											/>
										</td>
										<td
											className="max-w-[16rem] truncate font-medium"
											title={post.displayTitle ?? post.title ?? undefined}
										>
											{post.displayTitle || post.title || "Untitled"}
										</td>
										<td>{statusOf(post)}</td>
										<td className="text-sm">
											{post.publishedAt
												? new Date(post.publishedAt).toLocaleDateString("en-US", {
														timeZone: "UTC",
													})
												: "—"}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>

				<div className="flex items-center justify-between border-t border-base-300 pt-3">
					<span className="text-sm text-base-content/60">{selectedPosts.length} selected</span>
					<div className="flex items-center gap-2">
						<button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
							Cancel
						</button>
						<button
							type="button"
							className="btn btn-primary btn-sm"
							disabled={selectedPosts.length === 0}
							onClick={() => {
								onSelect(selectedPosts);
								onClose();
							}}
						>
							Add Post(s)
						</button>
					</div>
				</div>
			</div>
			<button type="button" className="modal-backdrop" onClick={onClose} aria-label="Close">
				close
			</button>
		</div>
	);
}
