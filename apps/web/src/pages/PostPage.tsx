// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import { LockedCover, UnlockPanel } from "@anthers/web-shared/post/unlock";
import { postUrl } from "@anthers/web-shared/postUrl";
import { Link, useLocation, useNavigate, useParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type {
	Comment,
	ContentItem,
	Post,
	PostEntry,
	TranscodingJob,
} from "@anthers/web-shared/types";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { ClockIcon, FilmIcon, MusicalNoteIcon, PhotoIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import AudioPlayer from "../components/media/AudioPlayer";
import TranscodingStatus from "../components/media/TranscodingStatus";
import VideoPlayer from "../components/media/VideoPlayer";
import ProjectDownloads from "../components/project/ProjectDownloads";
import ProjectEmbed from "../components/project/ProjectEmbed";
import ProjectPricing from "../components/project/ProjectPricing";
import ProjectRating from "../components/project/ProjectRating";
import SanitizedHtml from "../components/ui/SanitizedHtml";
import { useAttentionTracker } from "../lib/attention";
import { useMediaPlayer } from "../lib/media-player";

/** Whether a transcoding job is still in-flight (show a status card, not a player). */
function isJobPending(status: string): boolean {
	return status !== "completed";
}

/** Thumbnail-only preview shown when a content item lacks a playable payload. */
function MediaPreview({ item, icon }: { item: ContentItem; icon: React.ReactNode }) {
	if (item.thumbnail) {
		return (
			<div className="relative rounded-lg overflow-hidden bg-base-200">
				<img src={item.thumbnail} alt={item.title ?? "Preview"} className="w-full object-cover" />
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
function PhysicalServiceCard({ item }: { item: ContentItem }) {
	const meta = item.metadata ?? {};
	const scalarEntries = Object.entries(meta).filter(
		([, v]) => typeof v === "string" || typeof v === "number",
	);
	return (
		<div className="card bg-base-200">
			<div className="card-body gap-2">
				<div className="flex items-center gap-2">
					<h3 className="card-title text-base">
						{item.title ?? (item.type === "service" ? "Service" : "Physical item")}
					</h3>
					<span className="badge badge-outline badge-sm capitalize">{item.type}</span>
				</div>
				{item.description && (
					<p className="text-sm text-base-content/70 whitespace-pre-line">{item.description}</p>
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

	// While a referenced item is still transcoding, poll its status so the progress bar
	// advances live and the player swaps in on completion — no manual refresh.
	const hasActiveTranscode = (post?.contents ?? []).some(
		(entry) =>
			entry.kind === "content" &&
			entry.contentItem?.transcoding != null &&
			entry.contentItem.transcoding.status !== "completed" &&
			entry.contentItem.transcoding.status !== "failed",
	);
	useEffect(() => {
		if (!slug || !hasActiveTranscode) return;
		const tick = async () => {
			try {
				const res = await client.api.content.posts[":slug"].transcoding.$get({ param: { slug } });
				if (!res.ok) return;
				const { jobs } = (await res.json()) as unknown as { jobs: TranscodingJob[] };
				const latest = new Map<number, TranscodingJob>();
				for (const j of jobs) if (!latest.has(j.contentItemId)) latest.set(j.contentItemId, j);
				setPost((prev) => {
					if (!prev?.contents) return prev;
					let changed = false;
					const contents = prev.contents.map((entry) => {
						if (entry.kind !== "content" || !entry.contentItem) return entry;
						const job = latest.get(entry.contentItem.id);
						const cur = entry.contentItem.transcoding;
						if (
							job &&
							(cur?.status !== job.status ||
								cur?.progress !== job.progress ||
								cur?.etaSeconds !== job.etaSeconds)
						) {
							changed = true;
							return { ...entry, contentItem: { ...entry.contentItem, transcoding: job } };
						}
						return entry;
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

	const playAudioInMiniPlayer = (item: ContentItem, src: string) => {
		mediaPlayer.playTrack({
			src,
			title: item.title || post.title || "Untitled",
			creator: post.creator?.username || "",
			creatorId: post.creatorId,
			thumbnail: item.thumbnail || post.thumbnail,
			postId: post.id,
			waveform: item.transcoding?.waveformData,
		});
	};

	/** The media/body for one content item (null → nothing to render). */
	const renderContentItem = (item: ContentItem): React.ReactNode => {
		switch (item.type) {
			case "video": {
				const job = item.transcoding;
				const src = job?.hlsManifestUrl || item.sourceKey || "";
				if (job && isJobPending(job.status)) {
					return (
						<TranscodingStatus
							status={job.status}
							progress={job.progress ?? 0}
							etaSeconds={job.etaSeconds}
							errorMessage={job.errorMessage ?? undefined}
						/>
					);
				}
				if (src) return <VideoPlayer src={src} poster={item.thumbnail ?? undefined} />;
				return <MediaPreview item={item} icon={<FilmIcon className="w-16 h-16" />} />;
			}
			case "audio": {
				const job = item.transcoding;
				const src = job?.outputFileUrl || item.sourceKey || "";
				if (job && isJobPending(job.status)) {
					return (
						<TranscodingStatus
							status={job.status}
							progress={job.progress ?? 0}
							etaSeconds={job.etaSeconds}
							errorMessage={job.errorMessage ?? undefined}
						/>
					);
				}
				if (src)
					return (
						<AudioPlayer
							src={src}
							waveform={item.transcoding?.waveformData}
							onPlayInMiniPlayer={() => playAudioInMiniPlayer(item, src)}
						/>
					);
				return <MediaPreview item={item} icon={<MusicalNoteIcon className="w-12 h-12" />} />;
			}
			case "image":
				return item.sourceKey ? (
					<img
						src={item.sourceKey}
						alt={item.title ?? ""}
						className="w-full rounded-lg object-contain bg-base-200"
					/>
				) : (
					<MediaPreview item={item} icon={<PhotoIcon className="w-16 h-16" />} />
				);
			case "game":
			case "software":
				return item.embedUrl ? (
					<ProjectEmbed
						embedUrl={item.embedUrl}
						title={item.title || post.title || "Embedded content"}
					/>
				) : null;
			case "physical":
			case "service":
				return <PhysicalServiceCard item={item} />;
			default:
				return null;
		}
	};

	/** Render one ordered post entry (text block or content reference). */
	const renderEntry = (entry: PostEntry): React.ReactNode => {
		if (entry.kind === "text") {
			return entry.bodyHtml ? (
				<SanitizedHtml className="prose prose-sm max-w-none" html={entry.bodyHtml} />
			) : null;
		}

		const item = entry.contentItem;
		if (!item) {
			return (
				<div className="rounded-lg bg-base-200 p-4 text-sm text-base-content/50">
					This content is no longer available.
				</div>
			);
		}

		const media = renderContentItem(item);
		const showDownloads = post.downloadEnabled && item.assets.length > 0;
		if (!media && !showDownloads) return null;

		return (
			<>
				{media}
				{entry.caption && <p className="text-sm text-base-content/60 mt-2">{entry.caption}</p>}
				{showDownloads && (
					<div className="mt-4">
						<ProjectDownloads
							assets={item.assets}
							contentType={item.type}
							postSlug={post.slug}
							canAccess={canAccess}
						/>
					</div>
				)}
			</>
		);
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

				{canAccess ? (
					<>
						{/* Post body (sanitized server-side; withheld when locked). */}
						{(post.bodyHtml || post.body) && (
							<div className="prose prose-sm max-w-none mb-8">
								{post.bodyHtml ? (
									<SanitizedHtml html={post.bodyHtml} />
								) : (
									<Markdown remarkPlugins={[remarkGfm]}>{post.body}</Markdown>
								)}
							</div>
						)}

						{/* Deliverable — the ordered post entries. */}
						{contents.map((entry) => {
							const node = renderEntry(entry);
							if (!node) return null;
							return (
								<div key={entry.id} className="mb-6">
									{node}
								</div>
							);
						})}

						{/* Rating */}
						<div className="mb-8 mt-8">
							<ProjectRating slug={post.slug} />
						</div>
					</>
				) : (
					// Locked: the whole post is gated — blurred cover + reason-aware unlock CTA.
					// The title/creator/date above stay visible; body + media are withheld server-side.
					access && (
						<div className="mb-8">
							<LockedCover thumbnail={post.thumbnail} className="aspect-video rounded-lg mb-6" />
							{access.requiresPurchase ? (
								<ProjectPricing slug={post.slug} access={access} creatorHasStripe={false} />
							) : (
								<UnlockPanel
									access={access}
									creatorName={
										post.creator?.displayName || post.creator?.username || "this creator"
									}
									creatorUsername={post.creator?.username}
								/>
							)}
						</div>
					)
				)}
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
