// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Studio's **Posts** tab: everything the creator has written, and the way to write more.
 *
 * 🚨 **A tab, not a button.** The nav read *Dashboard · Catalog · New Post · Analytics ·
 * Settings* until 2026-09-11 — one action sitting among locations, and the action belonging
 * to the object that carries the least. Anthers has three clean objects and the tabs now
 * divide along them: the Catalog owns Projects and Works, this owns posts.
 *
 * A post announces and carries no access of its own — see the wiki's *What You Can Publish*.
 * Nothing here gates, prices or releases anything, and that absence is the model rather than
 * an omission.
 */

import { EyeSlashIcon, PencilSquareIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import EmptyState from "../components/ui/EmptyState";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { useAuth } from "../lib/auth";
import { postUrl } from "../lib/postUrl";
import { Link } from "../lib/router";
import { client } from "../lib/rpc";
import { studioEditPostUrl, studioNewPostUrl } from "../lib/studio";
import type { PostListItem } from "../lib/types";

/** Draft · Scheduled · Published, as one filter over the list. */
type Filter = "all" | "published" | "scheduled" | "draft";

const FILTERS: { value: Filter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "published", label: "Published" },
	{ value: "scheduled", label: "Scheduled" },
	{ value: "draft", label: "Drafts" },
];

function stateOf(post: PostListItem): Exclude<Filter, "all"> {
	if (post.isPublished) return "published";
	return post.scheduledFor ? "scheduled" : "draft";
}

export default function PostsPage() {
	const { user } = useAuth();
	const [posts, setPosts] = useState<PostListItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [filter, setFilter] = useState<Filter>("all");

	const [deleteTarget, setDeleteTarget] = useState<PostListItem | null>(null);
	const [orphanMedia, setOrphanMedia] = useState<
		{ id: number; title: string | null; type: string; thumbnail: string | null }[]
	>([]);
	const [purgeMedia, setPurgeMedia] = useState(false);
	const [actioning, setActioning] = useState(false);

	useEffect(() => {
		let live = true;
		client.api.content.posts
			.$get({ query: { mine: "true" } })
			.then((res) => res.json())
			.then((data) => {
				if (live) setPosts((data as { posts: PostListItem[] }).posts ?? []);
			})
			.catch(() => {})
			.finally(() => {
				if (live) setLoading(false);
			});
		return () => {
			live = false;
		};
	}, []);

	const openDelete = async (post: PostListItem) => {
		setDeleteTarget(post);
		setPurgeMedia(false);
		setOrphanMedia([]);
		try {
			const res = await client.api.content.posts[":slug"]["orphaned-media"].$get({
				param: { slug: post.slug },
			});
			if (res.ok) {
				const data = (await res.json()) as {
					items: { id: number; title: string | null; type: string; thumbnail: string | null }[];
				};
				setOrphanMedia(data.items ?? []);
			}
		} catch {
			// Preview is best-effort — delete still works without it.
		}
	};

	const confirmDelete = async () => {
		if (!deleteTarget) return;
		setActioning(true);
		try {
			const res = await client.api.content.posts[":slug"].$delete({
				param: { slug: deleteTarget.slug },
				query: purgeMedia ? { purgeMedia: "true" } : {},
			});
			if (res.status === 204 || res.ok) {
				setPosts((prev) => prev.filter((p) => p.id !== deleteTarget.id));
				setDeleteTarget(null);
			}
		} finally {
			setActioning(false);
		}
	};

	const unpublish = async (post: PostListItem) => {
		setActioning(true);
		try {
			const res = await client.api.content.posts[":slug"].$patch({
				param: { slug: post.slug },
				json: { isPublished: false },
			});
			if (res.ok) {
				setPosts((prev) =>
					prev.map((p) =>
						p.id === post.id ? { ...p, isPublished: false, scheduledFor: null } : p,
					),
				);
			}
		} finally {
			setActioning(false);
		}
	};

	if (loading) {
		return (
			<div className="flex justify-center py-16">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	const shown = filter === "all" ? posts : posts.filter((p) => stateOf(p) === filter);

	return (
		<div className="max-w-5xl mx-auto px-4 py-8">
			<div className="flex items-center justify-between mb-6">
				<h1 className="text-2xl font-bold">Posts</h1>
				{user?.isCreator && (
					<Link to={studioNewPostUrl()} className="btn btn-primary btn-sm">
						<PlusIcon className="w-4 h-4" /> New Post
					</Link>
				)}
			</div>

			{posts.length === 0 ? (
				<EmptyState
					icon={<PencilSquareIcon className="w-12 h-12" />}
					title="No posts yet"
					description="A post announces — a devlog, a release note, an update. It carries no access of its own, so what it is about lives in your Catalog as a Work."
					action={
						user?.isCreator ? (
							<Link to={studioNewPostUrl()} className="btn btn-primary btn-sm">
								Write a Post
							</Link>
						) : undefined
					}
				/>
			) : (
				<>
					{/* One list with a filter rather than three sections: a draft becomes a
					    scheduled post becomes a published one, and splitting the list moves a post
					    between tables as it goes. */}
					<div role="tablist" className="tabs tabs-bordered mb-4">
						{FILTERS.map(({ value, label }) => {
							const count =
								value === "all" ? posts.length : posts.filter((p) => stateOf(p) === value).length;
							return (
								<button
									key={value}
									type="button"
									role="tab"
									className={`tab ${filter === value ? "tab-active" : ""}`}
									onClick={() => setFilter(value)}
								>
									{label}
									<span className="ml-1.5 text-xs text-base-content/50">{count}</span>
								</button>
							);
						})}
					</div>

					{shown.length === 0 ? (
						<p className="py-12 text-center text-sm text-base-content/50">No {filter} posts.</p>
					) : (
						<div className="overflow-x-auto">
							<table className="table table-sm">
								<thead>
									<tr>
										<th>Title</th>
										<th>Status</th>
										<th>Date</th>
										<th>Actions</th>
									</tr>
								</thead>
								<tbody>
									{shown.map((post) => (
										<tr key={post.id}>
											<td>
												<Link to={postUrl(post)} className="link link-hover font-medium">
													{post.title || "Untitled"}
												</Link>
											</td>
											<td>
												{post.isPublished ? (
													<span className="badge badge-sm badge-success">Published</span>
												) : post.scheduledFor ? (
													<span
														className="badge badge-sm badge-info"
														title={`Scheduled for ${new Date(post.scheduledFor).toLocaleString()}`}
													>
														Scheduled
													</span>
												) : (
													<span className="badge badge-sm badge-warning">Draft</span>
												)}
											</td>
											<td className="text-sm text-base-content/50">
												{new Date(post.createdAt).toLocaleDateString()}
											</td>
											<td className="flex gap-1">
												<Link
													to={studioEditPostUrl(post.slug)}
													className="btn btn-ghost btn-xs"
													title="Edit"
												>
													<PencilSquareIcon className="w-4 h-4" />
												</Link>
												{post.isPublished && (
													<button
														type="button"
														className="btn btn-ghost btn-xs"
														title="Unpublish"
														onClick={() => unpublish(post)}
														disabled={actioning}
													>
														<EyeSlashIcon className="w-4 h-4" />
													</button>
												)}
												<button
													type="button"
													className="btn btn-ghost btn-xs text-error"
													title="Delete"
													onClick={() => openDelete(post)}
													disabled={actioning}
												>
													<TrashIcon className="w-4 h-4" />
												</button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</>
			)}

			{/* Delete confirmation (with an offer to purge now-orphaned library media). */}
			{deleteTarget && (
				<div className="modal modal-open" role="dialog">
					<div className="modal-box">
						<h3 className="text-lg font-bold">Delete "{deleteTarget.title || "Untitled"}"?</h3>
						<p className="py-3 text-sm text-base-content/70">
							This permanently removes the post along with its comments and reviews. It can't be
							undone.
						</p>
						{orphanMedia.length > 0 && (
							<label className="label cursor-pointer items-start justify-start gap-3 rounded-lg border border-base-300 p-3">
								<input
									type="checkbox"
									className="checkbox checkbox-sm mt-0.5"
									checked={purgeMedia}
									onChange={(e) => setPurgeMedia(e.target.checked)}
								/>
								<span className="label-text">
									Also delete {orphanMedia.length} unused media item
									{orphanMedia.length === 1 ? "" : "s"} from your library
									<span className="block text-xs text-base-content/50">
										{orphanMedia.map((m) => m.title || `Untitled ${m.type}`).join(", ")}
									</span>
									<span className="block text-xs text-base-content/50">
										No other post uses {orphanMedia.length === 1 ? "it" : "them"}. Leave unchecked
										to keep {orphanMedia.length === 1 ? "it" : "them"} in your library.
									</span>
								</span>
							</label>
						)}
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost"
								onClick={() => setDeleteTarget(null)}
								disabled={actioning}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-error"
								onClick={confirmDelete}
								disabled={actioning}
							>
								{actioning ? "Deleting..." : "Delete post"}
							</button>
						</div>
					</div>
					<button
						type="button"
						className="modal-backdrop"
						onClick={() => setDeleteTarget(null)}
						aria-label="Close"
					/>
				</div>
			)}
		</div>
	);
}
