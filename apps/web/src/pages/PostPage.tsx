// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import { postUrl } from "@anthers/web-shared/postUrl";
import { profileUrl } from "@anthers/web-shared/profile";
import { Link, useLocation, useNavigate, useParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { Comment, Post } from "@anthers/web-shared/types";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import {
	ClockIcon,
	FilmIcon,
	FlagIcon,
	MusicalNoteIcon,
	PhotoIcon,
} from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import WorkCard from "../components/cards/WorkCard";
import CommentThread from "../components/post/CommentThread";
import ReactionControl from "../components/post/ReactionControl";
import ReportDialog from "../components/ui/ReportDialog";
import SanitizedHtml from "../components/ui/SanitizedHtml";
import { studioEditPostUrl } from "../lib/studio";

/** Whether a transcoding job is still in-flight (show a status card, not a player). */
export default function PostPage() {
	const { slug } = useParams<{ slug: string }>();
	const location = useLocation();
	const navigate = useNavigate();
	const { isAuthenticated, user } = useAuth();
	const [post, setPost] = useState<Post | null>(null);
	const [loading, setLoading] = useState(true);
	/** Which comment the report dialog is open for, if any. */
	const [reportingComment, setReportingComment] = useState<number | null>(null);

	// ── Owner actions (edit / unpublish / delete) ──
	const [showHistory, setShowHistory] = useState(false);
	const [showDelete, setShowDelete] = useState(false);
	const [orphanMedia, setOrphanMedia] = useState<
		{ id: number; title: string | null; type: string; thumbnail: string | null }[]
	>([]);
	const [purgeMedia, setPurgeMedia] = useState(false);
	const [actioning, setActioning] = useState(false);

	// After a purchase, the webhook grants access asynchronously — poll the post until
	// access lands (or a few seconds pass), so the page reveals the unlocked content
	// on its own rather than making the buyer refresh.
	const refetchPost = useCallback(async () => {
		if (!slug) return;
		for (let i = 0; i < 10; i++) {
			const res = await client.api.content.posts[":slug"].$get({ param: { slug } });
			if (res.ok) {
				const data = (await res.json()) as unknown as { post: Post };
				setPost(data.post);
				// A post is never gated, so there is nothing to poll for here — one fetch is
				// the whole story. (Unlocking a WORK re-fetches on its own page.)
				return;
			}
			await new Promise((r) => setTimeout(r, 800));
		}
	}, [slug]);

	/** Path whose post is already in state — see the skip below. */
	const loadedPath = useRef<string | null>(null);

	useEffect(() => {
		if (!slug) return;
		// Don't re-fetch when the URL merely settled to its canonical form. The redirect
		// below rewrites a bare `/posts/{slug}` to `/posts/{slug}-{publicId}`, which changes
		// the route param and re-runs this effect — so without the guard the page fetched
		// itself a second time behind a `setLoading(true)` that tore the rendered page down
		// to a spinner first.
		if (loadedPath.current === `/posts/${slug}`) return;
		setLoading(true);

		// Only the post. Comments belong to <CommentThread>, which fetches and owns them —
		// this page used to fetch them too, into state nothing rendered, so every post view
		// asked the API for the same comments twice.
		client.api.content.posts[":slug"]
			.$get({ param: { slug } })
			.then(async (res) => (res.ok ? ((await res.json()) as unknown as { post: Post }) : null))
			.then((postData) => {
				setPost(postData?.post ?? null);
				// The canonical path this post answers to, so the redirect that follows is
				// recognized as "already loaded" rather than a new post to go and get.
				if (postData?.post) loadedPath.current = postUrl(postData.post);
			})
			.catch(console.error)
			.finally(() => setLoading(false));
	}, [slug]);

	// Canonicalize the URL to /posts/{slug}-{publicId} once the post resolves.
	// Guard: only navigate when the path differs, so replacing (which re-runs this
	// effect via the new slug param) settles rather than looping.
	useEffect(() => {
		if (!post) return;
		const canonical = postUrl(post);
		if (location.pathname !== canonical) {
			navigate(canonical, { replace: true });
		}
	}, [post, location.pathname, navigate]);

	// No transcode poller and no Time Pool claim here, deliberately. A post owns no media
	// and earns nothing — both belong to the Work, and both live on WorkPage now.

	if (loading) {
		return (
			<div className="flex justify-center items-center min-h-[60vh]">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	if (!post) {
		return (
			<div className="container mx-auto px-4 py-16 text-center">
				<h1 className="text-2xl font-bold mb-2">Not Found</h1>
				<p className="text-base-content/60">This post doesn't exist.</p>
			</div>
		);
	}

	const date = new Date(post.createdAt).toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
	});

	const linkedWorks = post.linkedWorks ?? [];

	const isOwner = isAuthenticated && user?.id === post.creatorId;
	const edits = post.edits ?? [];

	// Load which library items would be orphaned, then open the delete confirmation.
	const openDelete = async () => {
		setPurgeMedia(false);
		setOrphanMedia([]);
		setShowDelete(true);
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
		setActioning(true);
		try {
			const res = await client.api.content.posts[":slug"].$delete({
				param: { slug: post.slug },
				query: purgeMedia ? { purgeMedia: "true" } : {},
			});
			if (res.status === 204 || res.ok) {
				navigate(post.creator?.username ? profileUrl(post.creator.username) : "/");
			}
		} finally {
			setActioning(false);
		}
	};

	const handleUnpublish = async () => {
		setActioning(true);
		try {
			const res = await client.api.content.posts[":slug"].$patch({
				param: { slug: post.slug },
				json: { isPublished: false },
			});
			if (res.ok) setPost((prev) => (prev ? { ...prev, isPublished: false } : prev));
		} finally {
			setActioning(false);
		}
	};

	return (
		<div className="container mx-auto px-4 py-8 max-w-3xl">
			<article>
				{/* Post header */}
				{post.title && <h1 className="text-3xl font-bold mb-3">{post.title}</h1>}
				<div className="flex items-center gap-3 mb-6 text-sm">
					{post.creator?.avatar ? (
						<img
							src={post.creator.avatar}
							alt={post.creator?.username}
							className="w-10 h-10 rounded-full object-cover"
						/>
					) : (
						<div className="w-10 h-10 rounded-full bg-base-300 flex items-center justify-center font-bold">
							{(post.creator?.username ?? "?").charAt(0).toUpperCase()}
						</div>
					)}
					<div>
						<Link
							to={profileUrl(post.creator?.username ?? "")}
							className="font-medium link link-hover"
						>
							{post.creator?.displayName || post.creator?.username}
						</Link>
						<p className="text-base-content/50 text-xs">
							{date}
							{edits.length > 0 && (
								<>
									{" · "}
									<button
										type="button"
										className="link link-hover"
										onClick={() => setShowHistory((v) => !v)}
									>
										Edited{" "}
										{new Date(edits[0].editedAt).toLocaleDateString("en-US", {
											month: "short",
											day: "numeric",
											year: "numeric",
										})}
									</button>
								</>
							)}
						</p>
					</div>
				</div>

				{/* Owner status + controls (only the creator reaches an unpublished post). */}
				{isOwner && (
					<div className="flex flex-wrap items-center gap-2 mb-6">
						{post.isPublished === false && (
							<span className="badge badge-warning gap-1">
								{post.scheduledFor
									? `Scheduled for ${new Date(post.scheduledFor).toLocaleString("en-US", {
											month: "short",
											day: "numeric",
											hour: "numeric",
											minute: "2-digit",
										})}`
									: "Draft"}
							</span>
						)}
						<a href={studioEditPostUrl(post.slug)} className="btn btn-sm btn-outline">
							Edit
						</a>
						{post.isPublished && (
							<button
								type="button"
								className="btn btn-sm btn-ghost"
								onClick={handleUnpublish}
								disabled={actioning}
							>
								Unpublish
							</button>
						)}
						<button
							type="button"
							className="btn btn-sm btn-ghost text-error"
							onClick={openDelete}
							disabled={actioning}
						>
							Delete
						</button>
					</div>
				)}

				{/* Edit history (public — the "Edited …" link toggles it). */}
				{showHistory && edits.length > 0 && (
					<div className="rounded-lg border border-base-300 bg-base-200/50 p-4 mb-6 text-sm">
						<h3 className="font-semibold mb-2">Edit history</h3>
						<ul className="flex flex-col gap-1">
							{edits.map((e) => (
								<li
									key={e.editedAt}
									className="flex flex-wrap justify-between gap-x-4 text-base-content/70"
								>
									<span>
										{new Date(e.editedAt).toLocaleString("en-US", {
											month: "short",
											day: "numeric",
											year: "numeric",
											hour: "numeric",
											minute: "2-digit",
										})}
									</span>
									{e.summary && <span className="text-base-content/50">Changed {e.summary}</span>}
								</li>
							))}
						</ul>
					</div>
				)}

				{/* The post body. Always visible — a post is an announcement, and an
				    announcement nobody can read is not one. */}
				{(post.bodyHtml || post.body) && (
					<div className="prose prose-sm max-w-none mb-8">
						{post.bodyHtml ? (
							<SanitizedHtml html={post.bodyHtml} />
						) : (
							<Markdown remarkPlugins={[remarkGfm]}>{post.body}</Markdown>
						)}
					</div>
				)}

				{/* The Works this post is about. Each resolves on its OWN gates, so a post
				    the reader can read may well link something they cannot open — which is
				    the separation working, not a bug. */}
				{linkedWorks.length > 0 && (
					<section className="mb-8">
						<h2 className="text-lg font-semibold mb-3">
							{linkedWorks.length === 1 ? "The work" : "The works"}
						</h2>
						<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
							{linkedWorks.map((ref) => (
								<WorkCard key={ref.work.id} work={{ ...ref.work, creator: post.creator }} />
							))}
						</div>
					</section>
				)}
			</article>

			{/* Delete confirmation (with an offer to purge now-orphaned library media). */}
			{showDelete && (
				<div className="modal modal-open">
					<div className="modal-box">
						<h3 className="text-lg font-bold">Delete this post?</h3>
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
								onClick={() => setShowDelete(false)}
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
						onClick={() => setShowDelete(false)}
						aria-label="Close"
					/>
				</div>
			)}

			<ReactionControl subjectType="post" subjectId={post.id} label={post.title ?? "this post"} />

			<CommentThread subject={{ kind: "post", slug: post.slug }} />
		</div>
	);
}
