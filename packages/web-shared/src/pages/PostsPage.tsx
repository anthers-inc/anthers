// SPDX-License-Identifier: Apache-2.0
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
 *
 * The listing is a **table of tall rows** (Parker, 2026-10-11), the Works table's treatment:
 * the treatment the third listing's plain rows were missing, so the three Studio listings —
 * Works, Projects, Posts — read as one product. The filters live in the left sidebar below
 * the Studio nav and ride the URL as query parameters; the table re-derives client-side over
 * the loaded list. Filtering and sorting are `posts-list.ts`'s, extracted so a suite can fail
 * on them; the row is `PostRow.tsx`'s.
 *
 * ⚠️ **No `creatorMode` gates on this page** — the Studio's `StudioAuthGate` already admits
 * only signed-in creators, so gating the New button again was checking the same thing the
 * gate did, one layer late; the Works and Projects pages carry no such gate.
 */

import { PencilSquareIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PostRow from "../components/content/PostRow";
import PostsFilterSections from "../components/content/posts-filters";
import {
	arrangePosts,
	DEFAULT_POSTS_SORT,
	type PostsSortKey,
} from "../components/content/posts-list";
import SortableHeader, { ariaSort } from "../components/content/SortableHeader";
import EmptyState from "../components/ui/EmptyState";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import Modal from "../components/ui/Modal";
import { Link, useSearchParams } from "../lib/router";
import { client } from "../lib/rpc";
import { useSidebar } from "../lib/sidebar";
import { studioNewPostUrl } from "../lib/studio";
import type { PostListItem } from "../lib/types";

export default function PostsPage() {
	const [posts, setPosts] = useState<PostListItem[]>([]);
	const [loading, setLoading] = useState(true);

	const [deleteTarget, setDeleteTarget] = useState<PostListItem | null>(null);
	// Held across the dialog's exit: the state clears on close, but the box should keep
	// naming what is being deleted while the overlay fades.
	const lastDeleteTarget = useRef<PostListItem | null>(null);
	if (deleteTarget) lastDeleteTarget.current = deleteTarget;
	const shownDeleteTarget = deleteTarget ?? lastDeleteTarget.current;
	const [actioning, setActioning] = useState(false);

	// The filters and the sort ride the URL, the Works page's pattern — shareable, and
	// visible in the address bar when a creator has filtered to one state.
	const [searchParams, setSearchParams] = useSearchParams();
	const q = searchParams.get("q") ?? "";
	const status = searchParams.get("status") ?? "";
	const [sort, setSort] = useState<{ key: PostsSortKey; dir: "asc" | "desc" }>(DEFAULT_POSTS_SORT);

	const updateParams = useCallback(
		(updates: Record<string, string>) => {
			setSearchParams(
				(prev) => {
					const next = new URLSearchParams(prev);
					for (const [key, value] of Object.entries(updates)) {
						if (value) {
							next.set(key, value);
						} else {
							next.delete(key);
						}
					}
					return next;
				},
				{ replace: true },
			);
		},
		[setSearchParams],
	);

	// Repeat click on a sorted column flips it; a new column starts the way users expect
	// its data to read — names A→Z, numbers and dates high first.
	const onSort = (key: PostsSortKey) =>
		setSort((prev) =>
			prev.key === key
				? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
				: { key, dir: key === "title" ? "asc" : "desc" },
		);

	useEffect(() => {
		let live = true;
		void (async () => {
			try {
				const res = await client.api.content.posts.$get({ query: { mine: "true" } });
				const data = (await res.json()) as { posts?: PostListItem[] };
				if (live) setPosts(data.posts ?? []);
			} catch {
			} finally {
				if (live) setLoading(false);
			}
		})();
		return () => {
			live = false;
		};
	}, []);

	const openDelete = (post: PostListItem) => {
		setDeleteTarget(post);
	};

	const confirmDelete = async () => {
		if (!deleteTarget) return;
		setActioning(true);
		try {
			const res = await client.api.content.posts[":slug"].$delete({
				param: { slug: deleteTarget.slug },
				query: {},
			});
			if (res.status === 204 || res.ok) {
				setPosts((prev) => prev.filter((p) => p.id !== deleteTarget.id));
				setDeleteTarget(null);
			}
		} finally {
			setActioning(false);
		}
	};

	/** Move a published post back to drafts, from the row — the switch under its badge. */
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

	// The sidebar's filter sections, below the Studio nav — registered here, the Feed
	// page's mechanism by way of the Works page. The sections read the URL, so they
	// re-register as it changes.
	const { setPageContent } = useSidebar();
	const filters = useMemo(() => ({ q, status }), [q, status]);
	useEffect(() => {
		setPageContent(
			<PostsFilterSections q={filters.q} status={filters.status} onUpdateParams={updateParams} />,
		);
		return () => setPageContent(null);
	}, [setPageContent, filters, updateParams]);

	const rows = arrangePosts(posts, filters, sort.key, sort.dir);

	if (loading) {
		return (
			<div className="flex justify-center py-16">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	return (
		<div className="w-full px-6 py-6">
			<div className="flex items-center justify-between mb-4">
				<h2 className="text-lg font-semibold">Posts</h2>
				<Link to={studioNewPostUrl()} className="btn btn-primary btn-sm">
					<PlusIcon className="w-4 h-4" /> New Post
				</Link>
			</div>

			{posts.length === 0 ? (
				<EmptyState
					icon={<PencilSquareIcon className="w-12 h-12" />}
					title="No posts yet"
					description="A post announces — a devlog, a release note, an update. It carries no access of its own, so what it is about lives in your Catalog as a Work."
					action={
						<Link to={studioNewPostUrl()} className="btn btn-primary btn-sm">
							Write a Post
						</Link>
					}
				/>
			) : rows.length === 0 ? (
				/* Every post is filtered out — distinguishable from an empty list, and
				   its remedy is a click, not a new post. */
				<div className="text-sm text-base-content/60">
					<p className="mb-2">No posts match these filters.</p>
					<button
						type="button"
						className="btn btn-ghost btn-sm"
						onClick={() => updateParams({ q: "", status: "" })}
					>
						Clear filters
					</button>
				</div>
			) : (
				<div className="overflow-x-auto">
					<table className="table w-full">
						<thead>
							<tr className="border-base-300/50 text-xs text-base-content/50">
								<th scope="col" className="w-2/5" aria-sort={ariaSort(sort, "title")}>
									<SortableHeader label="Post" sortKey="title" sort={sort} onSort={onSort} />
								</th>
								<th scope="col">Status</th>
								<th scope="col" aria-sort={ariaSort(sort, "date")}>
									<SortableHeader label="Date" sortKey="date" sort={sort} onSort={onSort} />
								</th>
								<th scope="col" aria-sort={ariaSort(sort, "views")}>
									<SortableHeader label="Views" sortKey="views" sort={sort} onSort={onSort} />
								</th>
								<th scope="col">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((post) => (
								<PostRow
									key={post.id}
									post={post}
									onDelete={(p) => openDelete(p)}
									onUnpublish={unpublish}
									busy={actioning}
								/>
							))}
						</tbody>
					</table>
				</div>
			)}

			{/* Delete confirmation. */}
			<Modal open={deleteTarget !== null}>
				{shownDeleteTarget && (
					<div className="modal-box">
						<h3 className="text-lg font-bold">Delete "{shownDeleteTarget.title || "Untitled"}"?</h3>
						<p className="py-3 text-sm text-base-content/70">
							This permanently removes the post along with its comments. It can't be undone.
						</p>
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
				)}
				<button
					type="button"
					className="modal-backdrop"
					onClick={() => setDeleteTarget(null)}
					aria-label="Close"
				/>
			</Modal>
		</div>
	);
}
