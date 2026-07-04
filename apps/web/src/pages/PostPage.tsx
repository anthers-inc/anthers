// SPDX-License-Identifier: AGPL-3.0-or-later
import { ClockIcon, FilmIcon, MusicalNoteIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
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
import { postUrl } from "../lib/postUrl";
import { client } from "../lib/rpc";
import type { Comment, ContentElement, Post, TranscodingJob } from "../lib/types";

/** Whether a transcoding job is still in-flight (show a status card, not a player). */
function isJobPending(status: string): boolean {
	return status !== "completed";
}

/** Thumbnail-only preview shown when a media element's payload is gated/blank. */
function MediaPreview({
	element,
	icon,
}: {
	element: ContentElement;
	icon: React.ReactNode;
}) {
	if (element.thumbnail) {
		return (
			<div className="relative rounded-lg overflow-hidden bg-base-200">
				<img
					src={element.thumbnail}
					alt={element.title ?? "Preview"}
					className="w-full object-cover"
				/>
			</div>
		);
	}
	return (
		<div className="aspect-video bg-base-200 rounded-lg flex items-center justify-center text-base-content/30">
			{icon}
		</div>
	);
}

/** Card describing a physical good or service (no media payload). */
function PhysicalServiceCard({ element }: { element: ContentElement }) {
	const meta = element.metadata ?? {};
	const scalarEntries = Object.entries(meta).filter(
		([, v]) => typeof v === "string" || typeof v === "number",
	);
	return (
		<div className="card bg-base-200">
			<div className="card-body gap-2">
				<div className="flex items-center gap-2">
					<h3 className="card-title text-base">
						{element.title ?? (element.contentType === "service" ? "Service" : "Physical item")}
					</h3>
					<span className="badge badge-outline badge-sm capitalize">{element.contentType}</span>
				</div>
				{element.bodyHtml && (
					// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized server-side at write time (apps/api/src/services/sanitize.ts)
					<div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: element.bodyHtml }} />
				)}
				{scalarEntries.length > 0 && (
					<dl className="text-sm">
						{scalarEntries.map(([k, v]) => (
							<div key={k} className="flex gap-2">
								<dt className="text-base-content/50 capitalize">{k}</dt>
								<dd>{String(v)}</dd>
							</div>
						))}
					</dl>
				)}
			</div>
		</div>
	);
}

export default function PostPage() {
	const { slug } = useParams<{ slug: string }>();
	const location = useLocation();
	const navigate = useNavigate();
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

	// While any element is still transcoding, poll its status so the progress bar
	// advances live and the player swaps in on completion — no manual refresh.
	const hasActiveTranscode = (post?.contents ?? []).some(
		(c) =>
			c.transcoding != null &&
			c.transcoding.status !== "completed" &&
			c.transcoding.status !== "failed",
	);
	useEffect(() => {
		if (!slug || !hasActiveTranscode) return;
		const tick = async () => {
			try {
				const res = await client.api.content.posts[":slug"].transcoding.$get({ param: { slug } });
				if (!res.ok) return;
				const { jobs } = (await res.json()) as unknown as { jobs: TranscodingJob[] };
				const latest = new Map<number, TranscodingJob>();
				for (const j of jobs) if (!latest.has(j.contentId)) latest.set(j.contentId, j);
				setPost((prev) => {
					if (!prev?.contents) return prev;
					let changed = false;
					const contents = prev.contents.map((el) => {
						const job = latest.get(el.id);
						if (
							job &&
							(el.transcoding?.status !== job.status || el.transcoding?.progress !== job.progress)
						) {
							changed = true;
							return { ...el, transcoding: job };
						}
						return el;
					});
					return changed ? { ...prev, contents } : prev;
				});
			} catch {
				// transient — keep polling
			}
		};
		const interval = setInterval(tick, 2000);
		return () => clearInterval(interval);
	}, [slug, hasActiveTranscode]);

	// Attention tracking — map the post's derived contentType to an event type.
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
	const contents = post.contents ?? [];

	const playAudioInMiniPlayer = (element: ContentElement, src: string) => {
		mediaPlayer.playTrack({
			src,
			title: element.title || post.title || "Untitled",
			creator: post.creator?.username || "",
			creatorId: post.creatorId,
			thumbnail: element.thumbnail || post.thumbnail,
			postId: post.id,
			waveform: element.transcoding?.waveformData,
		});
	};

	const renderElementBody = (element: ContentElement) => {
		switch (element.contentType) {
			case "video": {
				const job = element.transcoding;
				const src = job?.hlsManifestUrl || element.videoFile || "";
				if (job && isJobPending(job.status)) {
					return (
						<TranscodingStatus
							status={job.status}
							progress={job.progress ?? 0}
							errorMessage={job.errorMessage ?? undefined}
						/>
					);
				}
				if (src) return <VideoPlayer src={src} poster={element.thumbnail ?? undefined} />;
				return <MediaPreview element={element} icon={<FilmIcon className="w-16 h-16" />} />;
			}
			case "audio": {
				const job = element.transcoding;
				const src = job?.outputFileUrl || element.audioFile || "";
				if (job && isJobPending(job.status)) {
					return (
						<TranscodingStatus
							status={job.status}
							progress={job.progress ?? 0}
							errorMessage={job.errorMessage ?? undefined}
						/>
					);
				}
				if (src)
					return (
						<AudioPlayer
							src={src}
							waveform={element.transcoding?.waveformData}
							onPlayInMiniPlayer={() => playAudioInMiniPlayer(element, src)}
						/>
					);
				return <MediaPreview element={element} icon={<MusicalNoteIcon className="w-12 h-12" />} />;
			}
			case "image": {
				const images = element.images ?? [];
				if (images.length > 0) return <ProjectScreenshots images={images} />;
				return <MediaPreview element={element} icon={<FilmIcon className="w-16 h-16" />} />;
			}
			case "game":
			case "software":
				return element.embedUrl ? (
					<ProjectEmbed
						embedUrl={element.embedUrl}
						title={element.title || post.title || "Embedded content"}
					/>
				) : null;
			case "text":
				return element.bodyHtml ? (
					// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized server-side at write time (apps/api/src/services/sanitize.ts)
					<div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: element.bodyHtml }} />
				) : null;
			case "physical":
			case "service":
				return <PhysicalServiceCard element={element} />;
			default:
				return null;
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
						<p className="text-base-content/50 text-xs">{date}</p>
					</div>
					{post.estimatedReadMinutes && (
						<div className="flex items-center gap-2 ml-auto">
							<span className="flex items-center gap-1 text-xs text-base-content/50">
								<ClockIcon className="w-3 h-3" />
								{post.estimatedReadMinutes} min read
							</span>
						</div>
					)}
				</div>

				{/* Post body — always visible (sanitized server-side). */}
				{(post.bodyHtml || post.body) && (
					<div className="prose prose-sm max-w-none mb-8">
						{post.bodyHtml ? (
							// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized server-side at write time (apps/api/src/services/sanitize.ts)
							<div dangerouslySetInnerHTML={{ __html: post.bodyHtml }} />
						) : (
							<Markdown remarkPlugins={[remarkGfm]}>{post.body}</Markdown>
						)}
					</div>
				)}

				{/* Access gate */}
				{access &&
					!access.canAccess &&
					(access.requiresPurchase ? (
						<div className="mb-8">
							<ProjectPricing slug={post.slug} access={access} creatorHasStripe={false} />
						</div>
					) : (
						<div className="card bg-base-200 border border-warning/30 mb-8">
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
					))}

				{/* Deliverable — the ordered content elements. */}
				{contents.map((element) => {
					const body = renderElementBody(element);
					const showDownloads = post.downloadEnabled && element.assets.length > 0;
					if (!body && !showDownloads) return null;
					return (
						<div key={element.id} className="mb-6">
							{element.title && contents.length > 1 && (
								<h2 className="text-lg font-semibold mb-2">{element.title}</h2>
							)}
							{body}
							{showDownloads && (
								<div className="mt-4">
									<ProjectDownloads
										assets={element.assets}
										contentType={element.contentType}
										postSlug={post.slug}
										canAccess={canAccess}
									/>
								</div>
							)}
						</div>
					);
				})}

				{/* Rating */}
				<div className="mb-8 mt-8">
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
							{submitting ? <span className="loading loading-spinner loading-sm" /> : "Post comment"}
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
