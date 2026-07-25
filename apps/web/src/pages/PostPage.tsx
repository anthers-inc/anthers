// SPDX-License-Identifier: AGPL-3.0-or-later

import { consumptionModeFor } from "@anthers/shared/attention";
import { useAuth } from "@anthers/web-shared/auth";
import { LockedCover } from "@anthers/web-shared/post/unlock";
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
import { useCallback, useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import AudioPlayer from "../components/media/AudioPlayer";
import TranscodingStatus from "../components/media/TranscodingStatus";
import VideoPlayer from "../components/media/VideoPlayer";
import InlineUnlock from "../components/post/InlineUnlock";
import ProjectDownloads from "../components/project/ProjectDownloads";
import ProjectEmbed from "../components/project/ProjectEmbed";
import ProjectPricing from "../components/project/ProjectPricing";
import ProjectRating from "../components/project/ProjectRating";
import SanitizedHtml from "../components/ui/SanitizedHtml";
import { useAttentionClaim } from "../lib/attention";
import { useMediaPlayer } from "../lib/media-player";
import { studioEditPostUrl } from "../lib/studio";

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
				if (data.post.access?.canAccess) return;
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

	// Attention is earned by the post's CONTENT ELEMENTS, never by the page itself
	// — the post body is connective tissue, so a body-only announcement earns
	// nothing. Timed media (video/audio) claims its own time from inside its
	// player, gated on real playback; this claim covers the attended elements
	// (text blocks, images, embedded games) that are consumed by being present.
	const attendedContentType = useMemo(() => {
		for (const entry of post?.contents ?? []) {
			const type = entry.kind === "text" ? "text" : entry.contentItem?.type;
			if (type && consumptionModeFor(type) === "presence") return type;
		}
		return null;
	}, [post]);

	useAttentionClaim({
		creatorId: post?.creatorId ?? null,
		postId: post?.id ?? null,
		contentType: attendedContentType ?? "",
		active: !!post && !!attendedContentType && (post.access?.canAccess ?? true),
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
				if (src)
					return (
						<VideoPlayer
							src={src}
							poster={item.thumbnail ?? undefined}
							attention={canAccess ? { creatorId: post.creatorId, postId: post.id } : undefined}
						/>
					);
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
							attention={canAccess ? { creatorId: post.creatorId, postId: post.id } : undefined}
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
					{post.estimatedReadMinutes && (
						<div className="flex items-center gap-2 ml-auto">
							<span className="flex items-center gap-1 text-xs text-base-content/50">
								<ClockIcon className="w-3 h-3" />
								{post.estimatedReadMinutes} min read
							</span>
						</div>
					)}
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
								<ProjectPricing
									slug={post.slug}
									access={access}
									creatorHasStripe={post.creator?.hasStripe ?? false}
									onPurchaseComplete={refetchPost}
								/>
							) : (
								<InlineUnlock post={post} access={access} onUnlocked={refetchPost} />
							)}
						</div>
					)
				)}
			</article>

			{/* Delete confirmation (with an offer to purge now-orphaned library media). */}
			{showDelete && (
				<div className="modal modal-open">
					<div className="modal-box">
						<h3 className="text-lg font-bold">Delete this post?</h3>
						<p className="py-3 text-sm text-base-content/70">
							This permanently removes the post along with its comments and ratings. It can't be
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
