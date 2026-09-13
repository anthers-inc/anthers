// SPDX-License-Identifier: Apache-2.0
/**
 * Pick one of the creator's posts — a modal list, filterable by title.
 *
 * The counterpart of `WorkPicker`, and deliberately thinner. A post has no type, no gate and
 * no delivery, so there is nothing to filter by and nothing to preview; what a creator needs
 * is to find the devlog they mean among a few dozen, which is a search box.
 *
 * ⚠️ **No "new post" affordance here, unlike the Work picker.** A Work can be made in thirty
 * seconds from a file, so realizing mid-shelf that one does not exist yet is a real
 * interruption worth absorbing. A post is prose — writing one is the task, not a step inside
 * another one — so the button would open an editor the creator then has to abandon this
 * screen to use.
 */
import { useEffect, useState } from "react";
import { client } from "../../lib/rpc";
import type { PostListItem } from "../../lib/types";
import LoadingSpinner from "../ui/LoadingSpinner";

interface PostPickerProps {
	/** Ids already on the shelf, so they can be shown as taken rather than offered twice. */
	excludeIds: number[];
	onSelect: (post: PostListItem) => void;
	onClose: () => void;
}

export default function PostPicker({ excludeIds, onSelect, onClose }: PostPickerProps) {
	const [posts, setPosts] = useState<PostListItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [query, setQuery] = useState("");

	useEffect(() => {
		let live = true;
		client.api.content.posts
			.$get({ query: { mine: "true" } })
			.then((res) => res.json())
			.then((d) => {
				if (live) setPosts((d as { posts: PostListItem[] }).posts ?? []);
			})
			.catch(() => {})
			.finally(() => {
				if (live) setLoading(false);
			});
		return () => {
			live = false;
		};
	}, []);

	const term = query.trim().toLowerCase();
	const available = posts.filter((p) => !excludeIds.includes(p.id));
	const shown = term
		? available.filter((p) => (p.title || "Untitled").toLowerCase().includes(term))
		: available;

	return (
		<div className="modal modal-open" role="dialog">
			<div className="modal-box flex max-h-[90vh] max-w-xl flex-col gap-4">
				<div className="flex items-center justify-between">
					<h2 className="text-lg font-bold">Add a post</h2>
					<button
						type="button"
						className="btn btn-sm btn-circle btn-ghost"
						onClick={onClose}
						aria-label="Close"
					>
						✕
					</button>
				</div>

				<input
					type="search"
					className="input input-bordered input-sm w-full"
					placeholder="Search your posts"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>

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
									? "Every post you have written is already on this shelf."
									: "No posts match that."}
						</p>
					) : (
						<ul className="flex flex-col gap-1">
							{shown.map((post) => (
								<li key={post.id}>
									<button
										type="button"
										className="flex w-full items-center gap-2 rounded border border-base-300 bg-base-100 px-3 py-2 text-left hover:border-primary"
										onClick={() => onSelect(post)}
									>
										<span className="flex-1 truncate text-sm font-medium">
											{post.title || "Untitled"}
										</span>
										{!post.isPublished && (
											<span className="badge badge-ghost badge-xs">
												{post.scheduledFor ? "Scheduled" : "Draft"}
											</span>
										)}
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
			<button type="button" className="modal-backdrop" onClick={onClose} aria-label="Close">
				close
			</button>
		</div>
	);
}
