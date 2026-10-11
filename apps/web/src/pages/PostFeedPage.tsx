// SPDX-License-Identifier: Apache-2.0

import { apiFetch } from "@anthers/web-shared/rpc";
import type { PostListItem } from "@anthers/web-shared/types";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import PostCard from "../components/cards/PostCard";

const FILTERS = [
	{ key: "", label: "All" },
	{ key: "text", label: "Writing" },
	{ key: "video", label: "Video" },
	{ key: "audio", label: "Audio" },
] as const;

type PostsResponse = { posts?: PostListItem[]; nextCursor?: string | null };

export default function PostFeedPage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const [posts, setPosts] = useState<PostListItem[]>([]);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);

	const contentTypeFilter = searchParams.get("content_type") ?? "";

	const feedUrl = useCallback(
		(cursor: string | null) => {
			const params = new URLSearchParams();
			if (contentTypeFilter) params.set("content_type", contentTypeFilter);
			if (cursor) params.set("cursor", cursor);
			const qs = params.toString();
			return `/api/content/posts${qs ? `?${qs}` : ""}`;
		},
		[contentTypeFilter],
	);

	useEffect(() => {
		setLoading(true);
		apiFetch(feedUrl(null), {})
			.then((res) => (res.ok ? res.json() : { posts: [] }))
			.then((data: PostsResponse) => {
				setPosts(data.posts ?? []);
				setNextCursor(data.nextCursor ?? null);
			})
			.catch((err) => console.error("Failed to load posts:", err))
			.finally(() => setLoading(false));
	}, [feedUrl]);

	// The next page rides the cursor the last page handed back; its posts append below
	// what is already rendered, so paging never repeats or drops a card.
	const loadMore = () => {
		if (!nextCursor || loadingMore) return;
		setLoadingMore(true);
		apiFetch(feedUrl(nextCursor), {})
			.then((res) => (res.ok ? res.json() : { posts: [] }))
			.then((data: PostsResponse) => {
				setPosts((prev) => [...prev, ...(data.posts ?? [])]);
				setNextCursor(data.nextCursor ?? null);
			})
			.catch((err) => console.error("Failed to load posts:", err))
			.finally(() => setLoadingMore(false));
	};

	const setFilter = (key: string) => {
		const params: Record<string, string> = {};
		if (key) params.content_type = key;
		setSearchParams(params);
	};

	return (
		<div className="container mx-auto px-4 py-8">
			<h1 className="text-3xl font-bold mb-2">Posts</h1>
			<p className="text-base-content/60 mb-6">
				Updates, devlogs, and announcements from creators across Anthers.
			</p>

			{/* Content type filter buttons */}
			<div className="flex gap-2 mb-6">
				{FILTERS.map(({ key, label }) => (
					<button
						type="button"
						key={key}
						className={`btn btn-sm ${contentTypeFilter === key ? "btn-primary" : "btn-outline"}`}
						onClick={() => setFilter(key)}
					>
						{label}
					</button>
				))}
			</div>

			{loading ? (
				<div className="flex justify-center py-16">
					<LoadingSpinner size="lg" />
				</div>
			) : posts.length === 0 ? (
				<EmptyState
					title="No posts yet"
					description="No one has published a post yet. Check back soon."
				/>
			) : (
				<>
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-7xl">
						{posts.map((post) => (
							<PostCard key={post.id} post={post} />
						))}
					</div>
					{nextCursor && (
						<div className="flex justify-center mt-8">
							<button
								type="button"
								className="btn btn-outline"
								onClick={loadMore}
								disabled={loadingMore}
							>
								{loadingMore ? "Loading…" : "Load more"}
							</button>
						</div>
					)}
				</>
			)}
		</div>
	);
}
