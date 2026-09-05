// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A single **Work** — the public face of one entry in a creator's Catalog.
 *
 * Almost everything on this page used to live on the post page, and moving it here is the
 * whole revamp in one file: the player, the gate, the unlock panel, the download list, the
 * transcode poller and the Time Pool claim are all properties of the *work*, not of an
 * announcement that happens to mention it. A Work reaches this page whether or not a post
 * was ever written about it.
 *
 * Three dates exist and only two are ours to assert. **Created** is what the creator says —
 * rendered at exactly the precision they claimed, so a Work back-dated to "2015" reads
 * "2015" and never "1 January 2015". **Released** is when we made it public. The upload
 * date is bookkeeping and is deliberately not shown.
 */

import { consumptionModeFor, isTimePoolEligible } from "@anthers/shared/attention";
import { contentNoteLabel } from "@anthers/shared/content-rating";
import { useAuth } from "@anthers/web-shared/auth";
import { LockedCover, lockedByBadge, presentsAsLocked } from "@anthers/web-shared/post/unlock";
import { postUrl, workUrl } from "@anthers/web-shared/postUrl";
import { profileUrl } from "@anthers/web-shared/profile";
import { Link, useLocation, useNavigate, useParams } from "@anthers/web-shared/router";
import { apiBaseUrl, client } from "@anthers/web-shared/rpc";
import type { TranscodingJob, Work } from "@anthers/web-shared/types";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { CalendarIcon, ClockIcon, MegaphoneIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import AddToBasket from "../components/basket/AddToBasket";
import PreviewBar, { usePreviewQuery } from "../components/creator/PreviewBar";
import SaveButton from "../components/library/SaveButton";
import AudioPlayer from "../components/media/AudioPlayer";
import ComicReader from "../components/media/ComicReader";
import { PublicAccessFooter, PublicAccessWall } from "../components/media/PublicAccessNotice";
import TranscodingStatus from "../components/media/TranscodingStatus";
import VideoPlayer from "../components/media/VideoPlayer";
import CommentThread from "../components/post/CommentThread";
import InlineUnlock from "../components/post/InlineUnlock";
import ReactionControl from "../components/post/ReactionControl";
import StickerBar from "../components/post/StickerBar";
import ProjectDownloads from "../components/project/ProjectDownloads";
import ProjectEmbed from "../components/project/ProjectEmbed";
import ProjectPricing from "../components/project/ProjectPricing";
import ProjectRating from "../components/project/ProjectRating";
import ContentTypeBadge from "../components/ui/ContentTypeBadge";
import SanitizedHtml from "../components/ui/SanitizedHtml";
import SharedWorkBanner from "../components/work/SharedWorkBanner";
import ShareLinkButton from "../components/work/ShareLinkButton";
import { useAttentionClaim } from "../lib/attention";
import { useMediaPlayer } from "../lib/media-player";
import { useMeteredBudget } from "../lib/public-access";
import { useShareToken, withShareToken } from "../lib/share-link";
import { trackFromWork } from "../lib/tracks";

/** A Work as the detail endpoint returns it — with its creator and posting history. */
type WorkDetail = Work & {
	creator?: { username: string; displayName: string | null; avatar: string | null };
	/** Whether the creator can actually take a direct payment (Connect onboarded). */
	creatorHasStripe?: boolean;
	/**
	 * Display name of whoever shared the link this page was reached by. Present only on a
	 * share view — a display name and nothing else, since the rest of that person's account
	 * is none of the recipient's business.
	 */
	sharedBy?: string | null;
	postedIn?: {
		slug: string;
		title: string | null;
		isPublished: boolean;
		postedAt: string | null;
	}[];
};

/**
 * The creator-asserted Created date, at the precision they actually claimed.
 *
 * Inventing a day the creator never asserted is exactly the false precision the
 * `authoredPrecision` column exists to prevent, so this never widens what was said.
 */
export function formatAuthored(
	iso: string | null | undefined,
	precision: string | null | undefined,
): string | null {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	switch (precision) {
		case "year":
			return String(d.getUTCFullYear());
		case "month":
			return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
		default:
			return d.toLocaleDateString("en-US", {
				month: "long",
				day: "numeric",
				year: "numeric",
				timeZone: "UTC",
			});
	}
}

export default function WorkPage() {
	const { slug } = useParams<{ slug: string }>();
	const navigate = useNavigate();
	const location = useLocation();
	const { user, isAuthenticated } = useAuth();
	const { playTracks } = useMediaPlayer();
	const preview = usePreviewQuery();
	/**
	 * The **share link** this page was reached by, if any.
	 *
	 * It changes the ANSWER the server gives, exactly as a preview does, so it travels with
	 * the request rather than being interpreted here — the frontend must never decide a gate
	 * itself. What it conveys is an allowance, never a permission; see `services/share-links.ts`.
	 */
	const shareToken = useShareToken();
	/** Stable string for the preview, so effects re-run on a change of value not identity. */
	const previewKey = JSON.stringify({ preview, shareToken });

	const [work, setWork] = useState<WorkDetail | null>(null);
	const [loading, setLoading] = useState(true);

	/**
	 * What is already in state — the canonical path AND the preview it was fetched under.
	 *
	 * 🚨 The preview half is load-bearing rather than tidy. This was the path alone, which
	 * was correct for the case it was written for (a bare `/works/{slug}` settling to its
	 * canonical form) and silently wrong for every other reason to re-read: arriving
	 * *already* at the canonical URL makes `loadedPath` equal the current path immediately,
	 * so the guard below returned early on every subsequent run and the page never fetched
	 * again. Changing the preview updated the URL and changed nothing on screen.
	 */
	const loadedKey = useRef<string | null>(null);

	/** Re-read the Work — the access verdict changes under us when a viewer unlocks it. */
	const refetch = useCallback(async () => {
		if (!slug) return;
		const res = await client.api.content.works[":id"].$get({
			param: { id: slug },
			// A preview changes the ANSWER, so it has to reach the server — the frontend
			// must never compute a gate itself or it will drift from the resolver. A share
			// token travels for the same reason and is refused server-side if it names a
			// different Work.
			query: shareToken ? { ...preview, share: shareToken } : preview,
		});
		if (!res.ok) {
			setWork(null);
			return;
		}
		const data = (await res.json()) as unknown as { work: WorkDetail };
		setWork(data.work);
		// Record the canonical path this Work answers to, so the redirect that is about to
		// happen is recognized as "already loaded" rather than a new Work to go and get.
		loadedKey.current = `${workUrl(data.work)}|${previewKey}`;
	}, [slug, preview, shareToken, previewKey]);

	useEffect(() => {
		if (!slug) return;
		// Don't re-fetch when the URL merely settled to its canonical form.
		//
		// Arriving at a bare `/works/{slug}` loads the Work and then the effect below
		// rewrites the URL to `/works/{slug}-{publicId}`. That changes the route param, so
		// without this guard the very next thing that happens is a SECOND fetch of the
		// same Work — with `setLoading(true)` in front of it, which tears the rendered
		// page back down to a spinner and rebuilds it. Imperceptible on a fast machine and
		// a real double round-trip on a slow one, which is why it went unnoticed: a shared
		// link, a stale slug, and the gauntlet's own navigation all take this path.
		if (loadedKey.current === `/works/${slug}|${previewKey}`) return;
		setLoading(true);
		refetch()
			.catch(() => setWork(null))
			.finally(() => setLoading(false));
	}, [slug, refetch, previewKey]);

	// Keep the canonical `/works/{slug}-{publicId}` URL in the bar, so a link shared from a
	// bare id or a stale slug settles on the durable form.
	useEffect(() => {
		if (!work) return;
		const canonical = workUrl(work);
		if (location.pathname === canonical) return;
		// 🚨 The token has to survive the rewrite. It is a recipient's only claim to this
		// Work, so settling the URL without it would load the page, 401 the player, and say
		// nothing about why — see `withShareToken`.
		navigate(withShareToken(canonical, shareToken), { replace: true });
	}, [work, location.pathname, navigate, shareToken]);

	// Poll while the media is still encoding, so the player swaps in without a refresh.
	const jobStatus = work?.transcoding?.status;
	const encoding = jobStatus != null && jobStatus !== "completed" && jobStatus !== "failed";

	/*
	 * The Public Access meter, for the media that have no player of their own.
	 *
	 * Video and audio carry their own countdown and wall inside `VideoPlayer` and
	 * `AudioPlayer`, because those components own the playback state the footer needs.
	 * Text, games, software and images have no such component — so the page holds it.
	 */
	const meterBudget = useMeteredBudget();
	/**
	 * Media whose METER the page owns, rather than the component.
	 *
	 * `VideoPlayer` and `AudioPlayer` each subscribe to the budget and render their own
	 * countdown and wall, because they own the playback state the footer needs. Nothing
	 * else does — and that now includes the **ebook** reader, which is deliberate rather
	 * than an oversight: its pages are fetched one at a time from a metered endpoint, so
	 * a spent allowance would otherwise surface as a reader full of broken images, which
	 * is the dead-player failure this whole meter design exists to avoid. The page shows
	 * the wall instead.
	 *
	 * (The name predates the reader. What it means is "the page holds the meter", not
	 * "there is no player" — a distinction worth keeping straight before adding a type.)
	 */
	const playerless = work != null && work.type !== "video" && work.type !== "audio";
	/**
	 * The allowance is gone *and* it applies here. Both halves matter: a spent allowance
	 * says nothing about gated work the viewer cleared, work they bought, or their own
	 * catalog — none of which is Public Access, and none of which the meter touches.
	 */
	const spentOnThis =
		playerless && (work?.publicAccess ?? false) && meterBudget != null && !meterBudget.allowed;
	useEffect(() => {
		if (!work || !encoding) return;
		const tick = async () => {
			try {
				const res = await client.api.content.works[":id"].transcoding.$get({
					param: { id: String(work.id) },
				});
				if (!res.ok) return;
				const { jobs } = (await res.json()) as unknown as { jobs: TranscodingJob[] };
				const latest = jobs[0];
				if (!latest) return;
				setWork((prev) => (prev ? { ...prev, transcoding: latest } : prev));
			} catch {
				// transient — keep polling
			}
		};
		const interval = setInterval(tick, 2000);
		return () => clearInterval(interval);
	}, [work, encoding]);

	// Time Pool. A Work is what earns, and its own type decides how. Playback-mode media
	// (video/audio) claims from inside its player, gated on real playback; this covers the
	// presence-mode types (text, image, game, software) that are consumed by being there.
	// The deliverableRef gates the presence claim on the deliverable being on screen, so a
	// Work scrolled past into a long comment thread stops earning — the comments are not
	// the work. Playback claims don't consult the ref (audio in the mini-player is exempt).
	const deliverableRef = useRef<HTMLElement>(null);
	const presence = work ? consumptionModeFor(work.type) === "presence" : false;
	useAttentionClaim({
		creatorId: work?.creatorId ?? null,
		workId: work?.id ?? null,
		contentType: work?.type ?? "",
		active:
			!!work && presence && isTimePoolEligible(work.type) && (work.access?.canAccess ?? false),
		elementRef: presence ? deliverableRef : undefined,
	});

	if (loading) return <LoadingSpinner />;
	if (!work) {
		return (
			<div className="text-center py-20">
				<h1 className="text-2xl font-bold mb-2">Not Found</h1>
				<p className="text-base-content/60">This work doesn't exist, or isn't public yet.</p>
			</div>
		);
	}

	const access = work.access;
	const canAccess = access?.canAccess ?? false;
	const isOwner = isAuthenticated && user?.id === work.creatorId;
	const creatorName = work.creator?.displayName || work.creator?.username || "this creator";
	const made = formatAuthored(work.authoredAt, work.authoredPrecision);
	const released = work.releasedAt
		? new Date(work.releasedAt).toLocaleDateString("en-US", {
				month: "long",
				day: "numeric",
				year: "numeric",
			})
		: null;

	return (
		<div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
			{/* Creator preview — only ever offered to the person who made it, and only ever
			    able to subtract access (the server guards that per Work). */}
			{isOwner && <PreviewBar />}

			{work.visibility === "private" && isOwner && (
				<div className="alert alert-warning">
					<span>
						This Work is still private — only you can see it. Release it from your Catalog when it's
						ready.
					</span>
				</div>
			)}

			<header className="space-y-3">
				<div className="flex flex-wrap items-center gap-3">
					<ContentTypeBadge contentType={work.type} />
					{work.creator && (
						<Link
							to={profileUrl(work.creator.username)}
							className="flex items-center gap-2 text-sm hover:underline"
						>
							{work.creator.avatar ? (
								<img
									src={work.creator.avatar}
									alt={work.creator.username}
									className="w-6 h-6 rounded-full object-cover"
								/>
							) : (
								<div className="w-6 h-6 rounded-full bg-base-300 flex items-center justify-center text-xs font-bold">
									{work.creator.username.charAt(0).toUpperCase()}
								</div>
							)}
							{creatorName}
						</Link>
					)}
				</div>

				<div className="flex flex-wrap items-start justify-between gap-3">
					<h1 className="text-3xl font-bold">{work.title || "Untitled"}</h1>
					{/* Save sits beside the title rather than under the player, because it
					    applies to a gated Work too — it keeps the thing, it does not open it. */}
					<SaveButton workId={work.id} className="shrink-0" />
				</div>

				{/* Made, then released — never the upload date, which is bookkeeping. */}
				<div className="flex flex-wrap items-center gap-4 text-sm text-base-content/60">
					{made && (
						<span className="flex items-center gap-1">
							<CalendarIcon className="w-4 h-4" />
							Made {made}
						</span>
					)}
					{released && <span>Released {released}</span>}
					{work.type === "text" && work.estimatedReadMinutes && (
						<span className="flex items-center gap-1">
							<ClockIcon className="w-4 h-4" />
							{work.estimatedReadMinutes} min read
						</span>
					)}
				</div>

				{/* The rating and its notes sit above the deliverable, not below it: a warning
				    that only appears once you already have the thing is not a warning. Nothing
				    renders for a General Work, which is nearly all of them. */}
				{work.maturity === "mature" && (
					<div className="flex flex-wrap items-center gap-2 text-sm">
						<span className="badge badge-warning badge-sm">Mature</span>
						{(work.maturityNotes ?? []).length > 0 && (
							<span className="text-base-content/60">
								{(work.maturityNotes ?? []).map(contentNoteLabel).join(" · ")}
							</span>
						)}
					</div>
				)}
			</header>

			{/* ── The deliverable, or the gate in front of it ── */}
			<section ref={deliverableRef}>
				{!canAccess ? (
					<div className="space-y-4">
						{/* ⚠️ A signed-out visitor is refused the bytes of free work too, and that
						    is not a lock — the Work is free to everyone and stays free; what is
						    missing is an account for the time to be attributed to. So the cover
						    stays unblurred and un-padlocked here, and the card underneath asks
						    for the account instead. See `presentsAsLocked`. */}
						{presentsAsLocked(access) ? (
							<LockedCover
								thumbnail={work.thumbnail}
								className="aspect-video rounded-lg"
								lockedBy={access ? lockedByBadge(access, creatorName) : null}
							/>
						) : (
							work.thumbnail && (
								<img
									src={work.thumbnail}
									alt=""
									className="aspect-video w-full rounded-lg object-cover"
								/>
							)
						)}
						{access &&
							(access.requiresPurchase ? (
								<>
									<ProjectPricing
										slug={work.slug ?? ""}
										access={access}
										creatorHasStripe={work.creatorHasStripe ?? false}
										onPurchaseComplete={refetch}
									/>
									{/* Only where there is actually a charge to share. */}
									{work.creatorHasStripe && access.price && work.creator?.username && (
										<AddToBasket
											workId={work.id}
											slug={work.slug ?? ""}
											title={work.title ?? "Untitled"}
											price={access.price}
											creatorUsername={work.creator.username}
											thumbnail={work.thumbnail}
										/>
									)}
								</>
							) : (
								<InlineUnlock post={work} access={access} />
							))}
					</div>
				) : spentOnThis ? (
					// The server withheld the deliverable because the allowance is gone, so
					// there is nothing to render in its place but the reason.
					<PublicAccessWall budget={meterBudget} />
				) : encoding ? (
					<TranscodingStatus
						status={work.transcoding?.status ?? "pending"}
						progress={work.transcoding?.progress ?? 0}
						etaSeconds={work.transcoding?.etaSeconds ?? undefined}
						errorMessage={work.transcoding?.errorMessage ?? undefined}
					/>
				) : (
					<>
						{work.type === "video" && work.transcoding?.hlsManifestUrl && (
							<VideoPlayer
								src={work.transcoding.hlsManifestUrl}
								poster={work.thumbnail ?? undefined}
								attention={{ creatorId: work.creatorId ?? null, workId: work.id }}
								publicAccess={work.publicAccess ?? false}
							/>
						)}
						{work.type === "audio" && work.transcoding?.outputFileUrl && (
							<>
								<AudioPlayer
									src={work.transcoding.outputFileUrl}
									waveform={work.transcoding.waveformData ?? undefined}
									attention={{ creatorId: work.creatorId ?? null, workId: work.id }}
									publicAccess={work.publicAccess ?? false}
									// Hand it to the persistent bar, so listening survives navigating
									// away — which is the whole reason the bar exists.
									onPlayInMiniPlayer={() => playTracks([trackFromWork(work)])}
								/>
								{/* The words, under the player. Gated with the audio: the API blanks
								    them for a viewer without access, so reaching this branch at all
								    means the viewer may read them. */}
								{work.lyrics?.trim() && (
									<section className="mt-4 rounded-lg bg-base-200/60 p-4">
										<h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-base-content/50">
											Lyrics
										</h2>
										<p className="whitespace-pre-wrap text-sm leading-relaxed text-base-content/85">
											{work.lyrics}
										</p>
									</section>
								)}
							</>
						)}
						{work.type === "ebook" && (
							<ComicReader
								workId={work.id}
								pageCount={work.pageCount ?? 0}
								apiBase={apiBaseUrl()}
								title={work.title ?? "Untitled"}
								shareToken={shareToken}
							/>
						)}
						{work.type === "image" && work.sourceKey && (
							<img src={work.sourceKey} alt={work.title ?? ""} className="w-full rounded-lg" />
						)}
						{(work.type === "game" || work.type === "software") && work.embedUrl && (
							<ProjectEmbed embedUrl={work.embedUrl} title={work.title ?? "Play"} />
						)}
						{work.bodyHtml && (
							<article className="prose max-w-none">
								<SanitizedHtml html={work.bodyHtml} />
							</article>
						)}
						{/*
						 * Reading, playing and looking draw the allowance exactly as watching does,
						 * and until now said nothing about it — the countdown and the wall were
						 * wired into the two players and nowhere else, so a reader nine hours in
						 * got no signal at all and then met a wall at a video.
						 *
						 * 🚨 Rendered here rather than inside each medium's block because there is
						 * no component to hang it on: text is an <article>, a game is an <iframe>,
						 * an image is an <img>. The players own their own footer; everything else
						 * has this one.
						 */}
						{playerless && <PublicAccessFooter />}
					</>
				)}
			</section>

			{/* Who sent them, and a free account without leaving the page. Rendered under the
			    deliverable rather than above it: they came here to watch something, and an
			    invitation that interrupted that would be the funnel this deliberately is not. */}
			{shareToken && !user && (
				<SharedWorkBanner sharedBy={work.sharedBy ?? null} onSignedIn={refetch} />
			)}

			{/* The public blurb — visible whether or not the viewer can open the Work, because a
			    locked Work still has to say what it is. The gated prose renders above, inside
			    the deliverable. */}
			{work.description && (
				<section className="prose max-w-none text-base-content/80">
					<p>{work.description}</p>
				</section>
			)}

			{work.assets.length > 0 && (
				<ProjectDownloads
					assets={work.assets}
					contentType={work.type}
					workId={work.id}
					canAccess={canAccess}
				/>
			)}

			{/* Sharing is offered to anyone with an account, and the SERVER decides whether this
			    particular Work can be shared — a client-side copy of that rule would be free to
			    disagree, and the direction that matters is a stale page offering to share
			    something that has since become gated or Adult. */}
			{/* ⭐ A like on a Work needs NO access, unlike a review or a comment. A Sticker
			    rides a like and may be given on any Work "gated or not, purchased or not",
			    because it is a gift to the creator rather than payment for the Work — so
			    gating this control would make that rule unbuildable. */}
			<div className="flex items-center justify-between">
				<ReactionControl subjectType="work" subjectId={work.id} label={work.title ?? "this Work"} />
				{isAuthenticated && !shareToken && <ShareLinkButton workId={work.id} />}
			</div>

			{/* A Sticker rides a like and follows the same access rule: it may be given on any
			    Work, gated or not, purchased or not, because it is a gift to the creator
			    rather than payment for the Work. */}
			<StickerBar subjectType="work" subjectId={work.id} label={work.title ?? "this Work"} />

			{/* Reviews — a verdict on the work itself, which is the only thing a review
			    was ever about. Gated behind access on the server: you can't review what you
			    haven't been able to see. */}
			<ProjectRating workId={work.id} />

			<CommentThread subject={{ kind: "work", id: work.id }} canComment={canAccess} />

			{/* Where this Work has been announced — the other half of an inert reference. */}
			{work.postedIn && work.postedIn.length > 0 && (
				<section className="border-t border-base-300 pt-6">
					<h2 className="flex items-center gap-2 text-lg font-semibold mb-3">
						<MegaphoneIcon className="w-5 h-5" />
						Posted about
					</h2>
					<ul className="space-y-2">
						{work.postedIn
							.filter((p) => p.isPublished)
							.map((p) => (
								<li key={p.slug}>
									<Link
										to={postUrl({ slug: p.slug, publicId: 0 })}
										className="link link-hover text-sm"
									>
										{p.title || p.slug}
									</Link>
									{p.postedAt && (
										<span className="text-xs text-base-content/40 ml-2">
											{new Date(p.postedAt).toLocaleDateString("en-US", {
												month: "short",
												day: "numeric",
												year: "numeric",
											})}
										</span>
									)}
								</li>
							))}
					</ul>
				</section>
			)}
		</div>
	);
}
