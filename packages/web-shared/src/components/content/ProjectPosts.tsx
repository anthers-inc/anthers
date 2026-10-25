// SPDX-License-Identifier: Apache-2.0
/**
 * The posts on a Project page — an ordered list the owner arranges by dragging, with
 * the same sort modes and the same multi-select picker the Works list carries (Parker,
 * 2026-10-17: both lists, same treatment, this pass).
 *
 * ⚠️ The endpoints for this were implemented, owner-checked, and called from nowhere.
 * `POST /projects/:slug/posts`, its delete and its reorder all existed; the public Project
 * page rendered a Posts section beneath the Works; and the wiki's *Projects* says plainly
 * that a Project holds both in two separate ordered lists. The Studio had one list, so the
 * only way a post ever joined a Project was the `projectId` select on the **New Post** form
 * — hidden on edit, and ignored by `PATCH /posts/:slug`, which accepts the field and never
 * reads it. Membership was therefore set at birth or never, could not be removed, and could
 * not be ordered.
 *
 * Lives on the Project's own page now, beside the Works list, and persists each change
 * on its own endpoint rather than with any form: a creator arranging twelve devlogs
 * should not lose them to a failed save on an unrelated field.
 *
 * **A Project's saved sort governs what readers see** (Parker, 2026-10-19, replacing the
 * works list's 2026-10-17 "Manual is the only real order" ruling, binding here):
 * changing a dropdown saves the mode on the Project row, and the API serializes the
 * members in that order for every reader. Manual remains the default and the stored drag
 * order; a non-manual mode never writes it. A post has no original release date, so this
 * list's dated key is its publish date — the field the Project serializer carries for a
 * post — and the Release Date mode reads that. The picker it opens is multi-select.
 *
 * A Project groups its posts: putting one here changes nothing about the post, and taking
 * it off never deletes it — it stays on the creator's profile and in their Posts tab.
 */

import {
	moveProjectItem,
	type ProjectSortDirection,
	type ProjectSortMode,
	sortProjectItems,
} from "@anthers/shared/project-sort";
import { Bars3Icon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { postUrl } from "../../lib/postUrl";
import { Link } from "../../lib/router";
import { client } from "../../lib/rpc";
import type { PostListItem, Project, ProjectPost } from "../../lib/types";
import LoadingSpinner from "../ui/LoadingSpinner";
import PostPicker from "./PostPicker";

/** A post list reads no original date; its modes are the works', minus that one. */
export const PROJECT_POST_SORT_OPTIONS: Array<{ mode: ProjectSortMode; label: string }> = [
	{ mode: "manual", label: "Manual" },
	{ mode: "released", label: "Release Date" },
	{ mode: "title", label: "Alphabetical" },
];

export default function ProjectPosts({ projectSlug }: { projectSlug: string }) {
	const [posts, setPosts] = useState<ProjectPost[]>([]);
	const [loading, setLoading] = useState(true);
	const [picking, setPicking] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sortMode, setSortMode] = useState<ProjectSortMode>("manual");
	const [sortDirection, setSortDirection] = useState<ProjectSortDirection>("asc");
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
				// The list's state is the STORED order (see the Works list); the detail
				// response arrives in the Project's saved reading order.
				setPosts([...(project.posts ?? [])].sort((a, b) => a.sortOrder - b.sortOrder));
				setSortMode(project.postsSortMode ?? "manual");
				setSortDirection(project.postsSortDirection ?? "asc");
			})
			.catch(() => {})
			.finally(() => live && setLoading(false));
		return () => {
			live = false;
		};
	}, [projectSlug]);

	/** Save one sort setting on the Project — optimistic, reverted on failure. */
	const saveSort = async (
		fields: { postsSortMode?: ProjectSortMode; postsSortDirection?: ProjectSortDirection },
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

	const add = async (picked: PostListItem[]) => {
		setPicking(false);
		const fresh = picked.filter((p) => !posts.some((existing) => existing.id === p.id));
		if (fresh.length === 0) return;
		setBusy(true);
		setError(null);
		try {
			const answers: ProjectPost[] = [];
			for (const post of fresh) {
				const res = await client.api.content.projects[":slug"].posts.$post({
					param: { slug: projectSlug },
					json: { postId: post.id },
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => null)) as { error?: string } | null;
					setError(body?.error || "Couldn't add that post.");
					break;
				}
				const { projectPost } = (await res.json()) as { projectPost: { sortOrder: number } };
				answers.push({ ...(post as unknown as ProjectPost), sortOrder: projectPost.sortOrder });
			}
			if (answers.length > 0) setPosts((prev) => [...prev, ...answers]);
		} catch {
			setError("Couldn't add that post.");
		} finally {
			setBusy(false);
		}
	};

	const remove = async (id: number) => {
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.content.projects[":slug"].posts[":postId"].$delete({
				param: { slug: projectSlug, postId: String(id) },
			});
			if (!res.ok) {
				setError("Couldn't remove that post.");
				return;
			}
			setPosts((prev) => prev.filter((p) => p.id !== id));
		} catch {
			setError("Couldn't remove that post.");
		} finally {
			setBusy(false);
		}
	};

	/**
	 * Persist one drag as the list's whole order — optimistic, reverted on failure, and
	 * sending every id, because the server takes the complete order (see the Works list).
	 *
	 * ⚠️ **`$patch` here, `$post` on the Works list.** The two reorder routes were written at
	 * different times and disagree about the verb. Matching the route that exists rather than
	 * changing it: the inconsistency costs one comment, and renaming a live endpoint to tidy it
	 * would cost a deploy where one side of the app is briefly wrong.
	 */
	const move = async (from: number, to: number) => {
		if (to === from) return;
		const before = posts;
		const next = moveProjectItem(posts, from, to).map((p, i) => ({ ...p, sortOrder: i }));
		setPosts(next);
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.content.projects[":slug"].posts.reorder.$patch({
				param: { slug: projectSlug },
				json: { postIds: next.map((p) => p.id) },
			});
			if (!res.ok) {
				setPosts(before);
				setError("Couldn't save the new order.");
			}
		} catch {
			setPosts(before);
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
	const displayed = sortProjectItems(posts, sortMode, sortDirection);

	return (
		<div className="space-y-3">
			{error && (
				<div className="alert alert-error text-sm">
					<span>{error}</span>
				</div>
			)}

			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<span className="text-sm text-base-content/60">Sort</span>
					<select
						aria-label="Sort the posts"
						className="select select-bordered select-sm"
						value={sortMode}
						onChange={(e) => {
							const next = e.target.value as ProjectSortMode;
							const before = sortMode;
							setSortMode(next);
							void saveSort({ postsSortMode: next }, () => setSortMode(before));
						}}
					>
						{PROJECT_POST_SORT_OPTIONS.map((opt) => (
							<option key={opt.mode} value={opt.mode}>
								{opt.label}
							</option>
						))}
					</select>
					<select
						aria-label="Posts sort direction"
						className="select select-bordered select-sm disabled:opacity-50"
						value={sortDirection}
						disabled={manual}
						onChange={(e) => {
							const next = e.target.value as ProjectSortDirection;
							const before = sortDirection;
							setSortDirection(next);
							void saveSort({ postsSortDirection: next }, () => setSortDirection(before));
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
					<PlusIcon className="h-4 w-4" /> Add a post
				</button>
			</div>

			{posts.length === 0 && (
				<p className="text-sm text-base-content/60">
					No posts yet. Put the devlogs, patch notes and announcements about this Project here and
					they read as its history.
				</p>
			)}

			<ul aria-label="Posts on this Project" className="space-y-2">
				{displayed.map((post, i) => {
					const storedIndex = manual ? i : posts.findIndex((p) => p.id === post.id);
					return (
						<li
							key={post.id}
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
									e.dataTransfer.setData("text/plain", String(post.id));
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
							<div className="min-w-0 flex-1">
								<Link to={postUrl(post)} className="link link-hover truncate text-sm font-medium">
									{post.displayTitle || post.title || "Untitled"}
								</Link>
								{!post.isPublished && (
									<span
										className="ml-2 badge badge-neutral badge-xs"
										title="Only you see this here"
									>
										Unpublished
									</span>
								)}
							</div>
							<button
								type="button"
								className="btn btn-ghost btn-xs text-error"
								onClick={() => remove(post.id)}
								disabled={busy}
								aria-label={`Remove ${post.displayTitle || post.title || "Untitled"}`}
							>
								<XMarkIcon className="h-4 w-4" />
							</button>
						</li>
					);
				})}
			</ul>

			<p className="text-xs text-base-content/50">
				Changes here save immediately, separately from the rest of this form. Removing a post from
				this list never deletes it.
			</p>

			{picking && (
				<PostPicker
					excludeIds={posts.map((p) => p.id)}
					onSelect={add}
					onClose={() => setPicking(false)}
				/>
			)}
		</div>
	);
}
