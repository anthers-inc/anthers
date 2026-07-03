// SPDX-License-Identifier: AGPL-3.0-or-later
import { ClockIcon, FilmIcon, MusicalNoteIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { Link, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import AudioPlayer from "../components/media/AudioPlayer";
import TranscodingStatus from "../components/media/TranscodingStatus";
import VideoPlayer from "../components/media/VideoPlayer";
import ProjectDownloads from "../components/project/ProjectDownloads";
import ProjectEmbed from "../components/project/ProjectEmbed";
import ProjectPricing from "../components/project/ProjectPricing";
import ProjectRating from "../components/project/ProjectRating";
import ProjectScreenshots from "../components/project/ProjectScreenshots";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { useAttentionTracker } from "../lib/attention";
import { useAuth } from "../lib/auth";
import { useMediaPlayer } from "../lib/media-player";
import { client } from "../lib/rpc";
import type { Comment, Post } from "../lib/types";

function formatDuration(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function PostPage() {
	const { slug } = useParams<{ slug: string }>();
	const { isAuthenticated, user } = useAuth();
	const mediaPlayer = useMediaPlayer();
	const [post, setPost] = useState<Post | null>(null);
	const [comments, setComments] = useState<Comment[]>([]);
	const [loading, setLoading] = useState(true);
	const [commentBody, setCommentBody] = useState("");
	const [submitting, setSubmitting] = useState(false);

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

	// Attention tracking—map contentType to event_type
	const eventType =
		post?.contentType === "video" ? "watch" : post?.contentType === "audio" ? "listen" : "read";

	useAttentionTracker({
		creatorId: post?.creatorId ?? null,
		postId: post?.id ?? null,
		eventType,
		active: !!post && (post.access?.canAccess ?? true),
	});

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

	const access = post.access;
	const canAccess = !access || access.canAccess;

	// Get latest transcoding job for media posts
	const latestJob = post.transcodingJobs?.[0];
	const videoSrc = latestJob?.hlsManifestUrl || (post.videoFile ?? undefined);
	const audioSrc = latestJob?.outputFileUrl || (post.audioFile ?? undefined);

	const handlePlayInMiniPlayer = () => {
		if (!audioSrc) return;
		mediaPlayer.playTrack({
			src: audioSrc,
			title: post.title || "Untitled",
			creator: post.creator?.username || "",
			creatorId: post.creatorId,
			thumbnail: post.thumbnail,
			postId: post.id,
			waveform: latestJob?.waveformData,
		});
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
						<p className="text-base-content/50 text-xs">{date}</p>
					</div>
					<div className="flex items-center gap-2 ml-auto">
						{post.contentType === "text" && post.estimatedReadMinutes && (
							<span className="flex items-center gap-1 text-xs text-base-content/50">
								<ClockIcon className="w-3 h-3" />
								{post.estimatedReadMinutes} min read
							</span>
						)}
						{post.contentType === "video" && post.durationSeconds && (
							<span className="flex items-center gap-1 text-xs text-base-content/50">
								<FilmIcon className="w-3 h-3" />
								{formatDuration(post.durationSeconds)}
							</span>
						)}
						{post.contentType === "audio" && post.durationSeconds && (
							<span className="flex items-center gap-1 text-xs text-base-content/50">
								<MusicalNoteIcon className="w-3 h-3" />
								{formatDuration(post.durationSeconds)}
							</span>
						)}
					</div>
				</div>

				{/* Access gate */}
				{access && !access.canAccess && (
					access.requiresPurchase ? (
						<div className="mb-6">
							<ProjectPricing slug={post.slug} access={access} creatorHasStripe={false} />
						</div>
					) : (
						<div className="card bg-base-200 border border-warning/30 mb-6">
							<div className="card-body text-center">
								<div className="text-4xl mb-2">
									{access.reason === "login_required" ? "🔑" : "🔒"}
								</div>
								<h3 className="font-bold text-lg">
									{access.reason === "login_required" ? "Login Required" : "Subscribers Only"}
								</h3>
								<p className="text-sm text-base-content/60 mb-3">
									{access.reason === "login_required"
										? "Log in to view this content."
										: "Subscribe or boost this creator to unlock their gated content."}
								</p>
								<Link
									to={access.reason === "login_required" ? "/login" : "/subscribe"}
									className="btn btn-primary btn-sm w-fit mx-auto"
								>
									{access.reason === "login_required" ? "Log in" : "Subscribe & Boost"}
								</Link>
							</div>
						</div>
					)
				)}

				{/* Content (only when accessible) */}
				{canAccess && (
					<>
						{/* Embedded web game / app */}
						{post.embedUrl && (
							<div className="mb-6">
								<ProjectEmbed embedUrl={post.embedUrl} title={post.title ?? "Embedded content"} />
							</div>
						)}

						{/* Video content */}
						{post.streamEnabled && post.contentType === "video" && (
							<div className="mb-6">
								{latestJob && latestJob.status !== "completed" ? (
									<TranscodingStatus
										status={latestJob.status}
										progress={latestJob.progress ?? 0}
										errorMessage={latestJob.errorMessage ?? undefined}
									/>
								) : videoSrc ? (
									<VideoPlayer src={videoSrc} poster={post.thumbnail ?? undefined} />
								) : (
									<div className="aspect-video bg-base-200 rounded-lg flex items-center justify-center text-base-content/30">
										<FilmIcon className="w-16 h-16" />
									</div>
								)}
							</div>
						)}

						{/* Audio content */}
						{post.streamEnabled && post.contentType === "audio" && (
							<div className="mb-6">
								{latestJob && latestJob.status !== "completed" ? (
									<TranscodingStatus
										status={latestJob.status}
										progress={latestJob.progress ?? 0}
										errorMessage={latestJob.errorMessage ?? undefined}
									/>
								) : audioSrc ? (
									<AudioPlayer
										src={audioSrc}
										waveform={latestJob?.waveformData}
										onPlayInMiniPlayer={handlePlayInMiniPlayer}
									/>
								) : (
									<div className="h-24 bg-base-200 rounded-lg flex items-center justify-center text-base-content/30">
										<MusicalNoteIcon className="w-12 h-12" />
									</div>
								)}
							</div>
						)}

						{/* Gallery */}
						<ProjectScreenshots images={post.galleryImages ?? []} />

						{/* Post body */}
						{(post.bodyHtml || post.body) && (
							<div className="prose prose-sm max-w-none mb-8">
								{post.bodyHtml ? (
									// biome-ignore lint/security/noDangerouslySetInnerHtml: bodyHtml is sanitized server-side at write time (apps/api/src/services/sanitize.ts)
									<div dangerouslySetInnerHTML={{ __html: post.bodyHtml }} />
								) : (
									<Markdown remarkPlugins={[remarkGfm]}>{post.body}</Markdown>
								)}
							</div>
						)}
					</>
				)}

				{/* Downloads */}
				{post.downloadEnabled && (
					<div className="mb-8">
						<ProjectDownloads
							assets={post.assets ?? []}
							contentType={post.contentType}
							postSlug={post.slug}
							canAccess={post.access?.canAccess ?? true}
						/>
					</div>
				)}

				{/* Rating */}
				<div className="mb-8">
					<ProjectRating slug={post.slug} />
				</div>
			</article>

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
									</div>
									<p className="text-sm mt-1">{comment.body}</p>
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
