// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The posts on a Project's shelf, as an ordered, reorderable list.
 *
 * 🚨 **The endpoints for this were implemented, owner-checked, and called from nowhere.**
 * `POST /projects/:slug/posts`, its delete and its reorder all existed; the public Project
 * page rendered a Posts section beneath the Works; and the wiki's *Projects* says plainly
 * that a Project holds both in two separate ordered lists. The Studio had one list, so the
 * only way a post ever joined a Project was the `projectId` select on the **New Post** form
 * — hidden on edit, and ignored by `PATCH /posts/:slug`, which accepts the field and never
 * reads it. Membership was therefore set at birth or never, could not be removed, and could
 * not be ordered.
 *
 * Modeled on `ProjectWorks`, down to persisting each change on its own endpoint rather than
 * with the form: a creator arranging twelve devlogs should not lose them to a failed save on
 * an unrelated field.
 *
 * ⚠️ **Edit-only, because every endpoint is keyed on the Project's slug.** There is nothing
 * to attach a post to until the Project exists.
 *
 * A Project is a shelf: putting a post on it changes nothing about the post, and taking it
 * off never deletes it — it stays on the creator's profile and in their Posts tab.
 */
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { postUrl } from "../../lib/postUrl";
import { Link } from "../../lib/router";
import { client } from "../../lib/rpc";
import type { PostListItem, Project, ProjectPost } from "../../lib/types";
import LoadingSpinner from "../ui/LoadingSpinner";
import PostPicker from "./PostPicker";

export default function ProjectPosts({ projectSlug }: { projectSlug: string }) {
	const [posts, setPosts] = useState<ProjectPost[]>([]);
	const [loading, setLoading] = useState(true);
	const [picking, setPicking] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		client.api.content.projects[":slug"]
			.$get({ param: { slug: projectSlug } })
			.then(async (res) => {
				if (!res.ok) return;
				const { project } = (await res.json()) as unknown as { project: Project };
				if (live) setPosts(project.posts ?? []);
			})
			.catch(() => {})
			.finally(() => live && setLoading(false));
		return () => {
			live = false;
		};
	}, [projectSlug]);

	const add = async (post: PostListItem) => {
		setPicking(false);
		if (posts.some((p) => p.id === post.id)) return; // one membership per post
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.content.projects[":slug"].posts.$post({
				param: { slug: projectSlug },
				json: { postId: post.id },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error || "Couldn't add that post.");
				return;
			}
			// The server assigns the position (max + 1), so mirror that rather than guessing.
			setPosts((prev) => [
				...prev,
				{ ...(post as unknown as ProjectPost), sortOrder: prev.length },
			]);
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
	 * Move one post up or down, persisting the whole order.
	 *
	 * Optimistic and reverted on failure — the alternative is a list that visibly reorders and
	 * then silently is not saved, which is the worst of both. The server takes the complete
	 * order rather than a delta, so this sends every id: a partial list would let an unlisted
	 * member keep a position that now collides with an assigned one.
	 *
	 * ⚠️ **`$patch` here, `$post` on the Works shelf.** The two reorder routes were written at
	 * different times and disagree about the verb. Matching the route that exists rather than
	 * changing it: the inconsistency costs one comment, and renaming a live endpoint to tidy it
	 * would cost a deploy where one side of the app is briefly wrong.
	 */
	const move = async (index: number, delta: number) => {
		const target = index + delta;
		if (target < 0 || target >= posts.length) return;
		const before = posts;
		const next = [...posts];
		[next[index], next[target]] = [next[target], next[index]];
		setPosts(next.map((p, i) => ({ ...p, sortOrder: i })));
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

	return (
		<div className="space-y-3">
			{error && (
				<div className="alert alert-error text-sm">
					<span>{error}</span>
				</div>
			)}

			{posts.length === 0 && (
				<p className="text-sm text-base-content/60">
					No posts yet. Put the devlogs, patch notes and announcements about this Project here and
					they read as its history.
				</p>
			)}

			<ul className="space-y-2">
				{posts.map((post, i) => (
					<li
						key={post.id}
						className="flex items-center gap-3 rounded-lg border border-base-300 bg-base-100 p-2"
					>
						<div className="min-w-0 flex-1">
							<Link to={postUrl(post)} className="link link-hover truncate text-sm font-medium">
								{post.title || "Untitled"}
							</Link>
							{!post.isPublished && (
								<span className="ml-2 badge badge-neutral badge-xs" title="Only you see this here">
									Unpublished
								</span>
							)}
						</div>
						<div className="flex shrink-0 items-center gap-1">
							<button
								type="button"
								className="btn btn-ghost btn-xs"
								onClick={() => move(i, -1)}
								disabled={busy || i === 0}
								aria-label={`Move ${post.title || "Untitled"} up`}
							>
								<ArrowUpIcon className="h-4 w-4" />
							</button>
							<button
								type="button"
								className="btn btn-ghost btn-xs"
								onClick={() => move(i, 1)}
								disabled={busy || i === posts.length - 1}
								aria-label={`Move ${post.title || "Untitled"} down`}
							>
								<ArrowDownIcon className="h-4 w-4" />
							</button>
							<button
								type="button"
								className="btn btn-ghost btn-xs text-error"
								onClick={() => remove(post.id)}
								disabled={busy}
								aria-label={`Remove ${post.title || "Untitled"}`}
							>
								<XMarkIcon className="h-4 w-4" />
							</button>
						</div>
					</li>
				))}
			</ul>

			<button
				type="button"
				className="btn btn-outline btn-sm"
				onClick={() => setPicking(true)}
				disabled={busy}
			>
				<PlusIcon className="h-4 w-4" /> Add a post
			</button>

			<p className="text-xs text-base-content/50">
				Changes here save immediately, separately from the rest of this form. Removing a post from
				this shelf never deletes it.
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
