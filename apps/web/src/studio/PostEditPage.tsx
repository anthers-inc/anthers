// SPDX-License-Identifier: Apache-2.0
/**
 * The Studio's post-edit address — a **redirect only**, since 2026-10-16: a post's
 * editing surface is the post's own page (`pages/PostPage.tsx` carries the ruling and
 * the inline editor), the Work pattern (`studio/WorkEditPage.tsx`) applied to posts.
 * The route stays because it is a published address: Studio rows, the Dashboard's
 * Schedule panel and bookmarks round it, and the redirect keeps them honest — the
 * Studio stopped having a page of its own for the work, and its addresses walk to the
 * place that now owns it.
 */

import { postUrl } from "@anthers/web-shared/postUrl";
import { Link, Navigate, useParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { studioUrl } from "@anthers/web-shared/studio";
import type { Post } from "@anthers/web-shared/types";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { useEffect, useState } from "react";

export default function PostEditPage() {
	const { slug } = useParams<{ slug: string }>();
	const [loading, setLoading] = useState(true);
	const [loaded, setLoaded] = useState<Post | null>(null);

	useEffect(() => {
		if (!slug) return;
		let live = true;
		client.api.content.posts[":slug"]
			.$get({ param: { slug } })
			.then(async (res) => (res.ok ? ((await res.json()) as unknown as { post: Post }) : null))
			.then((data) => {
				if (live) setLoaded(data?.post ?? null);
			})
			.catch(() => {})
			.finally(() => {
				if (live) setLoading(false);
			});
		return () => {
			live = false;
		};
	}, [slug]);

	if (loading) {
		return (
			<div className="flex justify-center py-16">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	if (!loaded) {
		return (
			<div className="max-w-3xl mx-auto px-4 py-16 text-center">
				<h1 className="text-2xl font-bold">We can't find that post</h1>
				<p className="mt-2 text-sm text-base-content/60">
					It may have been deleted, or it belongs to someone else.
				</p>
				<Link to={studioUrl("/posts")} className="btn btn-primary btn-sm mt-6">
					Back to your Posts
				</Link>
			</div>
		);
	}

	return <Navigate to={postUrl(loaded)} replace />;
}
