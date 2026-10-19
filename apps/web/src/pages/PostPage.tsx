// SPDX-License-Identifier: Apache-2.0
/**
 * A post's page — the viewable version, which is also its editing surface for the
 * creator (Parker, 2026-10-16): the same model every kind's Work page runs on
 * (`OwnerWorkEditor.tsx` carries the pattern's ruling). The creator and any user see
 * the SAME page; the creator's edit controls are the pencil beside what the user sees,
 * the banner that says the page is being edited, and the publishing machinery that
 * only the creator reaches. A save is one field's PATCH, the response is adopted, and
 * the page then re-reads the post — the PATCH response carries neither the edit-history
 * row it just wrote nor the record link, and both render here.
 *
 * The URL settles to canonical `/posts/{slug}-{publicId}` on load AND on a retitle save
 * (the slug re-derives from the title now), by the same canonicalization effect.
 *
 * The card outlines only the body; the header and the reaction row sit outside it —
 * see the layout comments below.
 */
import { useAuth } from "@anthers/web-shared/auth";
import { RecordLinkButton } from "@anthers/web-shared/content/RecordLink";
import RichTextEditor from "@anthers/web-shared/editor/RichTextEditor";
import { isoToLocalInput, localInputToIso } from "@anthers/web-shared/local-datetime";
import { usePageTitle } from "@anthers/web-shared/page-title";
import { usePayoutsReady } from "@anthers/web-shared/payouts";
import { markdownToEditorHtml } from "@anthers/web-shared/post-body";
import { tagsFromBodyHtml } from "@anthers/web-shared/post-tags";
import { postUrl } from "@anthers/web-shared/postUrl";
import { profileUrl } from "@anthers/web-shared/profile";
import { usePublishingPermissionMissing } from "@anthers/web-shared/publishing";
import { Link, useLocation, useNavigate, useParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { studioUrl } from "@anthers/web-shared/studio";
import type { Post, PostListItem } from "@anthers/web-shared/types";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import WorkCard from "../components/cards/WorkCard";
import SaveButton from "../components/library/SaveButton";
import CommentThread from "../components/post/CommentThread";
import SharePostButton from "../components/post/SharePostButton";
import StickerBar from "../components/post/StickerBar";
import VoteControl from "../components/post/VoteControl";
import { InlineField } from "../components/work/Editing";

const SCHEDULE_FALLBACK = "Couldn't save this just now.";

/** A post PATCH's wire shape: the row's own fields plus the editor's `bodyHtml`. */
type PostPatch = Partial<Post> & { bodyHtml?: string };

export default function PostPage() {
	const { slug } = useParams<{ slug: string }>();
	const location = useLocation();
	const navigate = useNavigate();
	const { isAuthenticated, user } = useAuth();
	const [post, setPost] = useState<Post | null>(null);
	const [loading, setLoading] = useState(true);
	usePageTitle(post?.title ?? null);

	// ── Owner actions (publish / pin) ──
	const [showHistory, setShowHistory] = useState(false);
	const [showUnpublish, setShowUnpublish] = useState(false);
	/** The post a new pin would replace, when there is one — the confirmation's cue. */
	const [pinTarget, setPinTarget] = useState<PostListItem | null>(null);
	const [actioning, setActioning] = useState(false);

	const payoutsReady = usePayoutsReady();
	const permissionMissing = usePublishingPermissionMissing();

	/** Path whose post is already in state — see the skip below. */
	const loadedPath = useRef<string | null>(null);

	/** Put a loaded post in state, remembering the canonical address its guards use. */
	const applyLoaded = useCallback((loaded: Post) => {
		setPost(loaded);
		loadedPath.current = postUrl(loaded);
	}, []);

	useEffect(() => {
		if (!slug) return;
		// Don't re-fetch when the URL merely settled to its canonical form. The canonicalize
		// effect below rewrites a bare `/posts/{slug}` to `/posts/{slug}-{publicId}`, which
		// changes the route param and re-runs this effect — so without the guard the page
		// fetched itself a second time behind a `setLoading(true)` that tore the rendered
		// page down to a spinner first.
		if (loadedPath.current === `/posts/${slug}`) return;
		setLoading(true);

		// Only the post. Comments belong to <CommentThread>, which fetches and owns them —
		// this page used to fetch them too, into state nothing rendered, so every post view
		// asked the API for the same comments twice.
		client.api.content.posts[":slug"]
			.$get({ param: { slug } })
			.then(async (res) => (res.ok ? ((await res.json()) as unknown as { post: Post }) : null))
			.then((postData) => {
				if (postData?.post) applyLoaded(postData.post);
			})
			.catch(console.error)
			.finally(() => setLoading(false));
	}, [slug, applyLoaded]);

	// Canonicalize the URL to /posts/{slug}-{publicId} once the post resolves — on load,
	// and after a retitle save (the slug re-derives from the title, and the save adopts
	// the post whose canonical address is the new one).
	// Guard: only navigate when the path differs, so replacing (which re-runs this
	// effect via the new slug param) settles rather than looping.
	useEffect(() => {
		if (!post) return;
		const canonical = postUrl(post);
		if (location.pathname !== canonical) {
			navigate(canonical, { replace: true });
		}
	}, [post, location.pathname, navigate]);

	// Escape closes whichever modal is open, the keyboard half of the door; the pointer
	// half is each modal's own ✕ / Cancel.
	useEffect(() => {
		if (!showHistory && !showUnpublish && !pinTarget) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			setShowHistory(false);
			setShowUnpublish(false);
			setPinTarget(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [showHistory, showUnpublish, pinTarget]);

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

	const stamp = new Date(post.createdAt).toLocaleString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});

	const linkedWorks = post.linkedWorks ?? [];

	const isOwner = isAuthenticated && user?.id === post.creatorId;
	const edits = post.edits ?? [];
	// Editing is inline, and the pencil is the only edit affordance (Parker's #569
	// ruling, 2026-10-16 — "the mode a creator is in is what the page itself is"): no
	// banner and no preview toggle. Every owner-only block below reads `isOwner`.
	const isLive = post.isPublished === true;
	// Going live takes payout setup and the publish permission — a live post stays
	// editable (and unpublishable) when either lapses.
	const goLiveBlocked = !isLive && (payoutsReady === false || permissionMissing === true);

	/**
	 * One narrow save: the field's PATCH, the response adopted, then the post re-read.
	 * The server's own rules answer in their own words (a slug-only refusal among them)
	 * and surface in the field that raised them.
	 */
	const saveField = async (fields: PostPatch): Promise<void> => {
		const res = await client.api.content.posts[":slug"].$patch({
			param: { slug: post.slug },
			json: fields as never,
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as { error?: string } | null;
			throw new Error(body?.error ?? SCHEDULE_FALLBACK);
		}
		const { post: adopted } = (await res.json()) as { post: Post };
		// Re-read: the PATCH response carries neither the edit-history row it just wrote
		// nor the record link, and both render here. The GET at the possibly new slug
		// also freshens the canonical address the guards above use.
		const fresh = await client.api.content.posts[":slug"].$get({
			param: { slug: adopted.slug },
		});
		if (fresh.ok) {
			applyLoaded(((await fresh.json()) as unknown as { post: Post }).post);
		} else {
			applyLoaded({ ...post, ...adopted });
		}
	};

	/** Unpublish, once the confirmation has been answered. Returns the post to draft. */
	const confirmUnpublish = async () => {
		setActioning(true);
		try {
			await saveField({ isPublished: false });
			setShowUnpublish(false);
		} catch (err) {
			console.error(err);
		} finally {
			setActioning(false);
		}
	};

	const handlePublish = async () => {
		setActioning(true);
		try {
			await saveField({ isPublished: true });
		} catch (err) {
			console.error(err);
		} finally {
			setActioning(false);
		}
	};

	/** Apply a pin or unpin. Pinning takes the creator's one pin slot server-side. */
	const applyPin = async (pinned: boolean) => {
		setActioning(true);
		try {
			await saveField({ isPinned: pinned });
			setPinTarget(null);
		} catch (err) {
			console.error(err);
		} finally {
			setActioning(false);
		}
	};

	/**
	 * Pin asks first **only** when another post already holds the pin. Unpin never asks,
	 * because taking a pin off your own post is the direction that loses nothing.
	 */
	const requestPin = async () => {
		if (post.isPinned) {
			await applyPin(false);
			return;
		}
		setActioning(true);
		try {
			const res = await client.api.content.posts.$get({ query: { mine: "true" } });
			if (res.ok) {
				const { posts } = (await res.json()) as { posts: PostListItem[] };
				// Pinned rows sort first, so the one holding the slot is on this page.
				const other = posts.find((p) => p.isPinned && p.id !== post.id);
				if (other) {
					setPinTarget(other);
					return;
				}
			}
			await applyPin(true);
		} catch (err) {
			console.error(err);
		} finally {
			setActioning(false);
		}
	};

	// ── The creator's inline fields — what a user reads, with a pencil beside it. ──

	const titleField = (
		<InlineField<string>
			label="Title"
			saved={post.title ?? ""}
			renderRead={() => (
				<h1 className="text-3xl font-bold mb-2">
					{post.title || <span className="text-base-content/40">Untitled</span>}
				</h1>
			)}
			renderEdit={(draft, setDraft) => (
				<input
					type="text"
					className="input input-bordered w-full"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder="Post title"
					aria-label="Post title"
				/>
			)}
			save={(draft) => saveField({ title: draft.trim() })}
		/>
	);

	// The editor speaks HTML; the stored body is markdown. The round trip is the write
	// boundary's own pair (marked ↔ turndown, through the same sanitizer), the same shape
	// the post page has always loaded the editor with.
	const bodyField = (
		<InlineField<string>
			label="Body"
			saved={markdownToEditorHtml(post.body)}
			className="w-full"
			renderRead={() =>
				post.body ? (
					<div className="prose prose-sm max-w-none flush post-body">
						<Markdown remarkPlugins={[remarkGfm]}>{post.body}</Markdown>
					</div>
				) : (
					<p className="text-sm text-base-content/40">Nothing written yet.</p>
				)
			}
			renderEdit={(draft, setDraft) => (
				<RichTextEditor
					content={draft}
					onChange={(html) => setDraft(html)}
					placeholder="Write your post... (use #tags to categorize)"
				/>
			)}
			// Tags derive from the body's own text (`lib/post-tags.ts`), so a body save
			// recomputes them — there is no tag field to fall out of step.
			save={(htmlDraft) => saveField({ bodyHtml: htmlDraft, tags: tagsFromBodyHtml(htmlDraft) })}
		/>
	);

	// The publish-time machinery, draft only (publishing now supersedes any schedule).
	const scheduleField = (
		<InlineField<string>
			label="Schedule"
			saved={isoToLocalInput(post.scheduledFor)}
			renderRead={() =>
				post.scheduledFor ? (
					<span>
						Publishes{" "}
						{new Date(post.scheduledFor).toLocaleString("en-US", {
							month: "short",
							day: "numeric",
							hour: "numeric",
							minute: "2-digit",
						})}
					</span>
				) : (
					<span className="text-base-content/40">Not scheduled</span>
				)
			}
			renderEdit={(draft, setDraft) => (
				<input
					type="datetime-local"
					className="input input-bordered input-sm"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					aria-label="Schedule publish"
				/>
			)}
			// Empty clears the schedule; a time keeps it a scheduled draft.
			save={(draft) => saveField({ scheduledFor: localInputToIso(draft) })}
		/>
	);

	return (
		<div className="container mx-auto px-4 py-8 max-w-3xl">
			{/* The card outlines only the post body (Parker, 2026-10-16): the header —
			    creator, title, stamp — and the reaction row live OUTSIDE the outline, so
			    the border says "the thing itself" the way the body it wraps is; the comments
			    sit below the whole arrangement. */}
			{post.creator && (
				<div className="mb-4">
					<Link
						to={profileUrl(post.creator.handle ?? "")}
						className="inline-flex items-center gap-3 hover:underline"
					>
						{post.creator.avatar ? (
							<img
								src={post.creator.avatar}
								alt={post.creator?.handle}
								className="w-10 h-10 rounded-full object-cover"
							/>
						) : (
							<div className="w-10 h-10 rounded-full bg-base-300 flex items-center justify-center font-bold">
								{(post.creator?.handle ?? "?").charAt(0).toUpperCase()}
							</div>
						)}
						<span className="font-medium">{post.creator?.displayName || post.creator?.handle}</span>
					</Link>
				</div>
			)}

			{/* The creator's action pack sits at the title's right (Parker, 2026-10-19):
			    one pair for the post's state — Publish/Unpublish and Pin/Unpin — where the
			    page used to scatter a publish button, an unpublish link, a delete link and
			    two toggles across three rows. Delete lives in the Studio's Posts table. */}
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					{isOwner ? (
						titleField
					) : (
						<h1 className="text-3xl font-bold mb-2">
							{post.title || <span className="text-base-content/40">Untitled</span>}
						</h1>
					)}
				</div>
				{isOwner && (
					<div className="flex shrink-0 items-center gap-1">
						<button
							type="button"
							className="btn btn-sm btn-outline"
							onClick={() => (isLive ? setShowUnpublish(true) : void handlePublish())}
							disabled={actioning || (!isLive && goLiveBlocked)}
						>
							{isLive ? "Unpublish" : "Publish"}
						</button>
						<button
							type="button"
							className="btn btn-sm btn-outline"
							onClick={() => void requestPin()}
							disabled={actioning}
						>
							{post.isPinned ? "Unpin" : "Pin"}
						</button>
					</div>
				)}
			</div>

			{/* The stamp carries the record button beside it — the standard icon form
			    ({@link RecordLinkButton}); nothing renders when the post has no record,
			    which is ordinary. */}
			<div className="flex flex-wrap items-center gap-2 mb-6 text-sm text-base-content/60">
				<span>{stamp}</span>
				{edits.length > 0 && (
					<>
						<span aria-hidden="true">·</span>
						<button type="button" className="link link-hover" onClick={() => setShowHistory(true)}>
							Edited{" "}
							{new Date(edits[0].editedAt).toLocaleDateString("en-US", {
								month: "short",
								day: "numeric",
								year: "numeric",
							})}
						</button>
					</>
				)}
				<RecordLinkButton recordUrl={post.recordUrl} />
			</div>

			{/* The draft's own state, on its own line — the action that changes it lives
			    in the pack above. */}
			{isOwner && !isLive && (
				<div className="mb-6">
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
				</div>
			)}

			{/* When a draft goes out on its own. Owner-only chrome, in one quiet row. */}
			{isOwner && !isLive && <div className="mb-6 text-sm">{scheduleField}</div>}

			{/* The gates the publish machinery answers to, said before the click lands —
			    the builder's wording, carried over (Parker's alerts). */}
			{isOwner && !isLive && goLiveBlocked && (
				<div className="alert alert-warning mb-6 text-sm">
					<span>
						{permissionMissing === true ? (
							<>
								<strong>Anthers can't publish for you yet.</strong> A post is written into your own
								repository when it goes out, and we don't have your permission to do that.{" "}
								<Link to={studioUrl("/payments")} className="link">
									Give it in the Studio's Payments tab
								</Link>
								.
							</>
						) : (
							<>
								<strong>Set up payouts before publishing.</strong> A post can be paid for with
								Stickers, and payout setup is also what lets us say every creator here is an adult.{" "}
								<Link to={studioUrl("/payments")} className="link">
									Set it up in the Studio's Payments tab
								</Link>
								.
							</>
						)}
					</span>
				</div>
			)}

			{/* The card: the body only. Always visible — a post is an announcement, and an
			    announcement nobody can read is not one. The body is the pencil's field only
			    for the creator editing; every other reader gets the read alone — the embeds
			    under it refresh with each save (they derive from the body; the save re-reads
			    them). */}
			<article className="rounded-xl border border-base-300 bg-base-100 p-6 sm:p-8 mb-8">
				{isOwner ? (
					bodyField
				) : post.body ? (
					<div className="prose prose-sm max-w-none flush post-body">
						<Markdown remarkPlugins={[remarkGfm]}>{post.body}</Markdown>
					</div>
				) : (
					<p className="text-sm text-base-content/40">Nothing written yet.</p>
				)}

				{/* The Works this post embeds. Each resolves on its OWN gates, so a post
				    the user can read may link something they cannot open — which is
				    the separation working, not a bug. */}
				{linkedWorks.length > 0 && (
					<section className={post.body ? "mt-6" : ""}>
						<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
							{linkedWorks.map((ref) => (
								<WorkCard key={ref.work.id} work={{ ...ref.work, creator: post.creator }} />
							))}
						</div>
					</section>
				)}
			</article>

			{/* The reaction row: the votes and the Sticker button on the left — the work
			    page's review row's shape (Parker, 2026-10-16), with the votes carrying
			    their counts on the buttons — and Share and Save at its right end
			    (Parker, 2026-10-19), the same pair the Work page's byline carries. */}
			<footer className="flex flex-wrap items-center gap-3">
				<VoteControl
					variant="boxed"
					subjectType="post"
					subjectId={post.id}
					label={post.title ?? "this post"}
				/>
				<StickerBar subjectType="post" subjectId={post.id} label={post.title ?? "this post"} />
				<div className="ml-auto flex items-center gap-1">
					<SharePostButton
						url={new URL(postUrl(post), window.location.origin).toString()}
						label={post.title ?? "this post"}
					/>
					<SaveButton postId={post.id} className="shrink-0" />
				</div>
			</footer>

			{/* ── The modals ────────────────────────────────────────────────────────
			    Each one is a state the page owns, not a route: closing it leaves the page
			    exactly where it was, which is the point of moving these off the layout. */}

			{/* Edit history — public, opened by the "Edited …" line above. */}
			{showHistory && edits.length > 0 && (
				<div className="modal modal-open" role="dialog" aria-label="Edit history">
					<div className="modal-box">
						<button
							type="button"
							className="btn btn-ghost btn-sm btn-circle absolute right-2 top-2"
							aria-label="Close"
							onClick={() => setShowHistory(false)}
						>
							<XMarkIcon className="h-4 w-4" />
						</button>
						<h3 className="text-lg font-semibold mb-3">Edit History</h3>
						<ul className="flex flex-col gap-2 text-sm">
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
						<p className="mt-4 text-xs text-base-content/50">
							The history names what changed. Showing the change itself needs the before and after
							kept, which the edit log does not store yet.
						</p>
					</div>
					<button
						type="button"
						className="modal-backdrop"
						onClick={() => setShowHistory(false)}
						aria-label="Close"
					/>
				</div>
			)}

			{/* Unpublish confirmation — the post goes back to being a draft. */}
			{showUnpublish && (
				<div className="modal modal-open" role="dialog" aria-label="Unpublish this post">
					<div className="modal-box">
						<h3 className="text-lg font-bold">Unpublish this post?</h3>
						<p className="py-3 text-sm text-base-content/70">
							It returns to being a draft: it leaves the feed, and its address stops resolving for
							anyone but you. You can publish it again at any time.
						</p>
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost"
								onClick={() => setShowUnpublish(false)}
								disabled={actioning}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-primary"
								onClick={() => void confirmUnpublish()}
								disabled={actioning}
							>
								{actioning ? "Unpublishing..." : "Unpublish"}
							</button>
						</div>
					</div>
					<button
						type="button"
						className="modal-backdrop"
						onClick={() => setShowUnpublish(false)}
						aria-label="Close"
					/>
				</div>
			)}

			{/* Pin replacement — only when another post holds the creator's one pin slot. */}
			{pinTarget && (
				<div className="modal modal-open" role="dialog" aria-label="Replace the pinned post">
					<div className="modal-box">
						<h3 className="text-lg font-bold">Replace your pinned post?</h3>
						<p className="pt-3 text-sm text-base-content/70">
							Pinning this post would replace the post you have pinned now:
						</p>
						<div className="my-3 rounded-lg border border-base-300 bg-base-200/50 p-4">
							<p className="font-medium">{pinTarget.title || "Untitled"}</p>
							{pinTarget.excerpt && (
								<p className="mt-1 line-clamp-3 text-sm text-base-content/70">
									{pinTarget.excerpt}
								</p>
							)}
						</div>
						<p className="text-sm text-base-content/70">Do you want to proceed?</p>
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost"
								onClick={() => setPinTarget(null)}
								disabled={actioning}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-primary"
								onClick={() => void applyPin(true)}
								disabled={actioning}
							>
								{actioning ? "Pinning..." : "Replace it"}
							</button>
						</div>
					</div>
					<button
						type="button"
						className="modal-backdrop"
						onClick={() => setPinTarget(null)}
						aria-label="Close"
					/>
				</div>
			)}

			<CommentThread subject={{ kind: "post", slug: post.slug }} />
		</div>
	);
}
