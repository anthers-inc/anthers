// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import { postUrl } from "@anthers/web-shared/postUrl";
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
import { useCallback, useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import WorkCard from "../components/cards/WorkCard";
import ProjectRating from "../components/project/ProjectRating";
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
	const [comments, setComments] = useState<Comment[]>([]);
	const [loading, setLoading] = useState(true);
	const [commentBody, setCommentBody] = useState("");
	const [submitting, setSubmitting] = useState(false);
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

	useEffect(() => {
		if (!slug) return;
		setLoading(true);

		Promise.all([
			client.api.content.posts[":slug"].$get({ param: { slug } }).then(async (res) => {
				if (!res.ok) return null;
				return (await res.json()) as unknown as { post: Post };
			}),
			client.api.content.posts[":slug"].comments
				.$get({ param: { slug } })
				.then(async (res) => {
					if (!res.ok) return { comments: [] as Comment[] };
					return (await res.json()) as unknown as { comments: Comment[] };
				})
				.catch(() => ({ comments: [] as Comment[] })),
		])
			.then(([postData, commentData]) => {
				setPost(postData?.post ?? null);
				setComments(commentData.comments);
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

	const handleComment = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!commentBody.trim() || !slug) return;
		setSubmitting(true);
		try {
			const res = await client.api.content.posts[":slug"].comments.$post({
				param: { slug },
				json: { body: commentBody },
			});
			if (!res.ok) throw new Error("Failed to post comment");
			const data = (await res.json()) as unknown as { comment: Comment };
			// The insert response omits the author avatar (no user join); the comment
			// is by the current user, so merge it in for the optimistic prepend.
			setComments([{ ...data.comment, avatar: user?.avatar ?? null }, ...comments]);
			setCommentBody("");
		} catch (err) {
			console.error("Failed to post comment:", err);
		} finally {
			setSubmitting(false);
		}
	};

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
				navigate(post.creator?.username ? `/${post.creator.username}` : "/");
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
						<Link to={`/${post.creator?.username}`} className="font-medium link link-hover">
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

				{/* Reviews */}
				<div className="mb-8 mt-8">
					<ProjectRating slug={post.slug} />
				</div>
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

			{/* Comments */}
			<div className="border-t border-base-300 pt-6">
				<h2 className="text-xl font-bold mb-4">Comments ({comments.length})</h2>

				{isAuthenticated && (
					<form onSubmit={handleComment} className="mb-6">
						<textarea
							className="textarea textarea-bordered w-full"
							placeholder="Write a comment..."
							rows={3}
							value={commentBody}
							onChange={(e) => setCommentBody(e.target.value)}
						/>
						<button
							type="submit"
							className="btn btn-primary btn-sm mt-2"
							disabled={submitting || !commentBody.trim()}
						>
							{submitting ? (
								<span className="loading loading-spinner loading-sm" />
							) : (
								"Post comment"
							)}
						</button>
					</form>
				)}

				{comments.length === 0 ? (
					<p className="text-base-content/50 text-sm">
						No comments yet. {isAuthenticated ? "Be the first!" : "Log in to comment."}
					</p>
				) : (
					<div className="flex flex-col gap-4">
						{comments.map((comment) => (
							<div key={comment.id} className="flex gap-3">
								{comment.avatar ? (
									<img
										src={comment.avatar}
										alt={comment.username}
										className="w-8 h-8 rounded-full object-cover flex-shrink-0"
									/>
								) : (
									<div className="w-8 h-8 rounded-full bg-base-300 flex items-center justify-center text-xs font-bold flex-shrink-0">
										{comment.username.charAt(0).toUpperCase()}
									</div>
								)}
								<div className="flex-1">
									<div className="flex items-center gap-2 text-sm">
										<span className="font-medium">{comment.username}</span>
										<span className="text-base-content/40 text-xs">
											{new Date(comment.createdAt).toLocaleDateString()}
										</span>
										{/* Reporting needs a session — there's nobody to hold accountable
										    for an anonymous report, and the one-per-person rule that keeps
										    the queue honest needs a person to count. */}
										{isAuthenticated && (
											<button
												type="button"
												className="ml-auto text-base-content/30 hover:text-base-content/70"
												onClick={() => setReportingComment(comment.id)}
												title="Report this comment"
												aria-label={`Report ${comment.username}'s comment`}
											>
												<FlagIcon className="w-3.5 h-3.5" />
											</button>
										)}
									</div>
									<p className="text-sm mt-1">{comment.body}</p>
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			{reportingComment !== null && (
				<ReportDialog
					subjectType="comment"
					subjectId={reportingComment}
					label="this comment"
					onClose={() => setReportingComment(null)}
				/>
			)}
		</div>
	);
}
