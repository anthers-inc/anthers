// SPDX-License-Identifier: Apache-2.0
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
import { deliverableIsEmpty, isListened } from "@anthers/shared/content";
import { gridFor, normalizeMaturityRows } from "@anthers/shared/content-rating";
import { useAuth } from "@anthers/web-shared/auth";
import TranscodingStatus from "@anthers/web-shared/media/TranscodingStatus";
import { usePageTitle } from "@anthers/web-shared/page-title";
import { LockedCover, lockedByBadge, presentsAsLocked } from "@anthers/web-shared/post/unlock";
import { workUrl } from "@anthers/web-shared/postUrl";
import { useLocation, useNavigate, useParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { type AccessResult, isAccessResult, type TranscodingJob } from "@anthers/web-shared/types";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { usePreviewQuery } from "../components/creator/PreviewBar";
import SaveButton from "../components/library/SaveButton";
import { PublicAccessWall } from "../components/media/PublicAccessNotice";
import InlineUnlock from "../components/post/InlineUnlock";
import StickerBar from "../components/post/StickerBar";
import ProjectDownloads from "../components/project/ProjectDownloads";
import ProjectPricing from "../components/project/ProjectPricing";
import WorkReviews from "../components/project/WorkReviews";
import OwnerWorkEditor, {
	CaptionsSummary,
	DateValueLine,
	ReleaseSummary,
} from "../components/work/OwnerWorkEditor";
import SharedWorkBanner from "../components/work/SharedWorkBanner";
import ShareLinkButton from "../components/work/ShareLinkButton";
import { WorkViewAsSection } from "../components/work/ViewAs";
import WorkInfoTabs from "../components/work/WorkInfoTabs";
import {
	formatOriginallyReleased,
	isGoods,
	isWriting,
	pageHoldsTheMeter,
	WORK_DETAILS_HEADING_CLASS,
	WorkAccessChip,
	WorkByline,
	WorkColumn,
	WorkCredits,
	WorkDeliverable,
	WorkDescription,
	type WorkDetail,
	WorkPlaceholder,
	WorkRating,
} from "../components/work/WorkLayout";
import WorkMediaFrame from "../components/work/WorkMediaFrame";
import WorkSideColumn, { ShowingsStub } from "../components/work/WorkSideColumn";
import { reportExternalActivity, useAttentionClaim } from "../lib/attention";
import { useMeteredBudget } from "../lib/public-access";
import { useShareToken, withShareToken } from "../lib/share-link";
import { RatingMatrixReadOnly } from "../studio/RatingMatrix";

export default function WorkPage() {
	const { slug } = useParams<{ slug: string }>();
	const navigate = useNavigate();
	const location = useLocation();
	const { user, isAuthenticated } = useAuth();
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

	/**
	 * Where playback opens — the `?t` a shared timestamp link carried in the bar. Read
	 * ONCE, at the first load: the canonical-URL settle below rewrites the address and
	 * a later re-read would yank a viewer who has kept watching in the meantime back to
	 * their entry point.
	 */
	const [startSeconds] = useState(() => {
		const param = new URLSearchParams(window.location.search).get("t");
		if (!param) return null;
		const seconds = Number(param);
		return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : null;
	});

	const [work, setWork] = useState<WorkDetail | null>(null);
	const [loading, setLoading] = useState(true);
	usePageTitle(work?.title ?? null);

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

	/** Re-read the Work — the access verdict changes under us when a user unlocks it. */
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
	// A video plays its original whether or not a ladder encode is running (70.06), and
	// since 2026-10-16 a track plays its original the same way while its MP3 and
	// waveform process — so `encoding` no longer gates what renders for either; it only
	// drives this poll, which ends the moment the processed deliverable exists and the
	// player swaps to it.
	const jobStatus = work?.transcoding?.status;
	const encoding = jobStatus != null && jobStatus !== "completed" && jobStatus !== "failed";
	/** A Work whose original is not on hand yet (or is not a play surface), for the encoder-status fallback. */
	const playsOriginal =
		work != null && (work.type === "video" || isListened(work.type)) && !!work.originalUrl;

	/*
	 * The Public Access meter, for the media that have no player of their own.
	 *
	 * Video and audio carry their own countdown and wall inside `VideoPlayer` and
	 * `AudioPlayer`, because those components own the playback state the footer needs.
	 * Text, games, software and images have no such component — so the page holds it.
	 */
	const meterBudget = useMeteredBudget();
	/** See `pageHoldsTheMeter`, which says which media's meter the page owns and why. */
	const playerless = work != null && pageHoldsTheMeter(work.type);
	/**
	 * The allowance is gone *and* it applies here. Both halves matter: a spent allowance
	 * says nothing about gated work the user cleared, work they bought, or their own
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
			!!work &&
			presence &&
			isTimePoolEligible(work.type) &&
			isAccessResult(work.access) &&
			work.access.canAccess,
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

	// The user's verdict. `Work` types both serializations' `access`, and this page is a
	// user's — the owner's own shape carries the editable rows instead, which read as no
	// verdict at all here (`null`), the same absence the comment below already describes.
	const access = isAccessResult(work.access) ? work.access : null;
	const isOwner = isAuthenticated && user?.id === work.creatorId;
	/**
	 * Whether this user may open the Work.
	 *
	 * ⚠️ **No verdict is the owner's own shape, not a refusal.** The server answers a creator's own
	 * Work with `serializeWork`, which carries no access verdict because a creator can always open
	 * their own Work, and reading that absence as `false` left a creator's page showing neither
	 * the Work nor a lock unless they turned a preview on. A verdict, which a preview always has,
	 * still decides, so previewing as a stranger still shows exactly what a stranger meets. Time a
	 * creator spends in their own catalog draws nothing from the Time Pool (`distribute-pool`).
	 */
	const canAccess = access ? access.canAccess : isOwner;
	const creatorName = work.creator?.displayName || work.creator?.handle || "this creator";
	/**
	 * Every kind's editing surface is the Work's own page now (the kinds pass,
	 * 2026-10-14 — the video surface propagated): its owner edits right here, and the
	 * View As row's modes are exactly that — when one is active the page is the user's
	 * rendering, which is what the row itself says (the editing banner is gone,
	 * 2026-10-16 — editing is inline, the pencil is the only edit affordance). The
	 * row does not move when a mode takes: the owner's copy of the user's rendering
	 * carries the same Manage tab the editor's does (Parker, 2026-10-17).
	 */
	const ownerEdits = isOwner && !preview.previewAs;

	if (ownerEdits) {
		// No column of its own here: the editor renders the page's one WorkColumn, and a
		// second would double its top padding against the topbar (Parker's fourth pass).
		return <OwnerWorkEditor work={work} onRefetch={refetch} />;
	}

	return (
		// One width everywhere, for every kind (the kinds pass, 2026-10-14 — the video
		// rule propagated): the creator's editor, the unlocked visitor page and the
		// locked one read the same, and the page starts tight under the topbar because
		// the first thing on it is the Work itself. A piece of writing keeps its reading
		// measure as its deliverable's own, centered inside the width.
		<WorkColumn type={work.type} wide tight>
			{work.visibility === "private" && isOwner && (
				<div className="alert alert-warning">
					<span>
						This Work is still private — only you can see it. Release it from your Works page when
						it's ready.
					</span>
				</div>
			)}

			{/* ── The deliverable, or the gate in front of it ── */}
			<section ref={deliverableRef}>
				{/*
				 * The page's one media card (`WorkMediaFrame` — the media-frame task,
				 * 2026-10-16, Parker): the video layout is canonical, and locked, processing,
				 * purchased-unavailable and open branches all hold it, so the page's shape
				 * never moves between kinds or between a gate and its opening. A piece of
				 * writing's standfirst rides inside the card above its branches' content,
				 * and the article renders inside it through `WorkDeliverable`'s lead slot.
				 */}
				{isGoods(work.type) ? (
					/* 🚨 A goods Work's deliverable is the goods themselves (Parker,
					    2026-10-09): the store panel stands exactly where a player would,
					    for owner, revisiting buyer, and signed-out visitor alike — the
					    resolver's goods rule carries the verdicts this reads
					    (`requiresPurchase` for every qualifying viewer, the gate
					    verdicts for a hard-gated one, no `isFree` posture at all). The
					    unlock card renders only under a badge or age gate, in which case
					    the store is nobody's to read. */
					access && !access.canAccess && !access.requiresPurchase ? (
						<WorkMediaFrame>
							<div className="w-full">
								<InlineUnlock post={work} access={access} />
							</div>
						</WorkMediaFrame>
					) : (
						// `h-full` as the panel's own: the store's columns fill the media
						// frame's whole profile — the picture column takes the height the
						// composition gives it (the store-panel task, 2026-10-17), rather
						// than a strip beside empty space.
						<WorkMediaFrame>
							<div className="h-full w-full">
								<ProjectPricing
									workId={work.id}
									slug={work.slug ?? ""}
									access={access ?? undefined}
									title={work.title ?? "Untitled"}
									creatorHandle={work.creator?.handle ?? ""}
									creatorHasStripe={work.creatorHasStripe ?? false}
									thumbnail={work.thumbnail}
									workType={work.type}
								/>
							</div>
						</WorkMediaFrame>
					)
				) : !canAccess ? (
					// A locked Work keeps the one 16:9 stage like every other state. A
					// video's gate fills it — the blur-and-overlay is the player's own
					// rectangle — while the other kinds' two-up is a composition inside the
					// stage: padded, centered where it fits, and scrolling where it does not.
					<WorkMediaFrame fill={work.type === "video"}>
						{isWriting(work.type) && <WorkDescription work={work} />}
						{work.type === "video" ? (
							/* A locked video is the feed's treatment at page scale (Parker,
							    2026-10-13): the thumbnail blurred beneath, and the unlock —
							    whatever it asks for — overlaid on it, rather than a two-up
							    of cover and card. The underlying cover is the same
							    `LockedCover` blur the tiles draw; the card overlay rides
							    above it, centered, on `z-10`. */
							<div className="relative w-full overflow-hidden rounded-lg">
								{presentsAsLocked(access) ? (
									<LockedCover
										thumbnail={work.thumbnail}
										className="aspect-video w-full"
										lockedBy={null}
									/>
								) : work.thumbnail ? (
									<img
										src={work.thumbnail}
										alt=""
										className="aspect-video w-full object-cover blur-xl scale-110"
									/>
								) : (
									// ⚠️ The base layer is this box's ONLY height (the overlay rides
									// `absolute inset-0`), so a thumbnail-free Work renders the gradient
									// fill `LockedCover` itself falls back to — unblurred and
									// un-padlocked, because this arm is exactly the not-a-lock state —
									// or the frame collapses to zero height and `overflow-hidden`
									// clips the account card invisible, rendering as absence (the
									// locked-preview task, 2026-10-17).
									<div className="aspect-video w-full bg-gradient-to-br from-base-300 to-base-200" />
								)}
								<div className="absolute inset-0 z-10 flex items-center justify-center p-6">
									{/*
									 * ⚠️ A user-shape Work always carries an access verdict, which is
									 * the only shape that reaches this branch — an owner without one
									 * reads canAccess true above and never gets here. So the card
									 * here is whichever the verdict asks for.
									 */}
									{access && (
										<div className="w-full max-w-md rounded-lg shadow-lg">
											{access.requiresPurchase ? (
												<ProjectPricing
													workId={work.id}
													slug={work.slug ?? ""}
													access={access}
													title={work.title ?? "Untitled"}
													creatorHandle={work.creator?.handle ?? ""}
													thumbnail={work.thumbnail}
													creatorHasStripe={work.creatorHasStripe ?? false}
													workType={work.type}
												/>
											) : (
												<InlineUnlock post={work} access={access} />
											)}
										</div>
									)}
								</div>
							</div>
						) : (
							<div className="flex h-full flex-col justify-start gap-4 sm:justify-center">
								{/* ⚠️ A signed-out visitor is refused the bytes of free work too, and
						    that is not a lock — the Work is free to everyone and stays free;
						    what is missing is an account for the time to be attributed to. So
						    the cover stays unblurred and un-padlocked here, and the card
						    underneath asks for the account instead. See `presentsAsLocked`. */}
								{/* The locked preview and the purchase decision are one composition: a
						    two-up, equal-height pairing (Parker, 2026-10-04, after Vimeo On
						    Demand's buy panel) — the blurred cover left, the price card right,
						    both cards' edges aligned. They stack below `sm` with the cover
						    first. Everything else on the page stays full-width; only this
						    pairing is two-up. */}
								{/* ⚠️ `w-full` is load-bearing on both children: a grid item stretched to
						    the row's height lets `aspect-video` derive its WIDTH from that
						    height (254 × 16/9 ≈ 452px), overflowing its 424px track — the
						    aspect ratio silently outranks the track. An explicit width breaks
						    the derive-back and the cover sizes to its column. Found by
						    measuring, invisible in the DOM string. */}
								<div className="w-full sm:grid sm:grid-cols-2 sm:gap-4 sm:items-stretch">
									{presentsAsLocked(access) ? (
										<LockedCover
											thumbnail={work.thumbnail}
											className="aspect-video w-full rounded-lg"
											lockedBy={access ? lockedByBadge(access, creatorName) : null}
										/>
									) : work.thumbnail ? (
										<img
											src={work.thumbnail}
											alt=""
											className="aspect-video w-full rounded-lg object-cover"
										/>
									) : (
										// Same fill as the video arm above: the two-up's cover is its own
										// height and the composition's first column — dropping it for a
										// thumbnail-free Work leaves the pairing one-sided (the
										// locked-preview task, 2026-10-17).
										<div className="aspect-video w-full rounded-lg bg-gradient-to-br from-base-300 to-base-200" />
									)}
									{access &&
										(access.requiresPurchase ? (
											/* Every purchase goes through the basket (Parker, 2026-10-03): the
									   pricing card offers the two doors into it and nothing about a
									   card lives on this page. */
											<ProjectPricing
												workId={work.id}
												slug={work.slug ?? ""}
												access={access}
												title={work.title ?? "Untitled"}
												creatorHandle={work.creator?.handle ?? ""}
												thumbnail={work.thumbnail}
												creatorHasStripe={work.creatorHasStripe ?? false}
												workType={work.type}
											/>
										) : (
											<InlineUnlock post={work} access={access} />
										))}
								</div>
							</div>
						)}
					</WorkMediaFrame>
				) : spentOnThis ? (
					<WorkMediaFrame>
						{isWriting(work.type) && (
							<div className="mx-auto w-full max-w-2xl">
								<WorkDescription work={work} />
							</div>
						)}
						{/* The server withheld the deliverable because the allowance is gone, so
						    there is nothing to render in its place but the reason. `w-full` as
						    everywhere in the frame: the wall's card has no width of its own. */}
						<div className="w-full">
							<PublicAccessWall budget={meterBudget} />
						</div>
					</WorkMediaFrame>
				) : encoding && !playsOriginal ? (
					// The processing block, held inside the media frame rather than replacing
					// it (the placeholder task, 2026-10-16): the page's proportions do not move
					// while the Work's processed deliverable is being made.
					<WorkMediaFrame>
						<WorkPlaceholder
							type={work.type}
							note=""
							status={
								<TranscodingStatus
									status={work.transcoding?.status ?? "pending"}
									progress={work.transcoding?.progress ?? 0}
									etaSeconds={work.transcoding?.etaSeconds ?? undefined}
									errorMessage={work.transcoding?.errorMessage ?? undefined}
								/>
							}
						/>
					</WorkMediaFrame>
				) : deliverableIsEmpty(work) ? (
					// A draft the owner is previewing: the record renders the same silhouette
					// the editor's deliverable draws — the page keeps its proportions and the
					// box names what will fill it — rather than showing nothing at all
					// (Parker, 2026-10-17, after a previewed unreleased video's media area
					// was gone entirely). Silent on purpose: the editor's own silhouette is
					// the one that points at a Manage tab, and this surface cannot know
					// whose reading it is.
					<WorkMediaFrame>
						{isWriting(work.type) && <WorkDescription work={work} />}
						<WorkPlaceholder type={work.type} note="" />
					</WorkMediaFrame>
				) : (
					<WorkDeliverable
						work={work}
						shareToken={shareToken}
						onFrameActivity={reportExternalActivity}
						startSeconds={startSeconds}
						// The account's Use Persistent Miniplayer — an account-level
						// setting, so null (never answered) reads as on. Signed-out, there
						// is no bar preference at all and the page plays inline.
						persistentMiniPlayer={isAuthenticated ? (user?.persistentMiniplayer ?? true) : false}
						// A piece of writing's description is its standfirst, above the
						// article where a user expects one — and it also rides in the Details
						// tab below, kept in both places on purpose (Parker, 2026-10-14).
						lead={isWriting(work.type) ? <WorkDescription work={work} /> : undefined}
					/>
				)}
			</section>

			{/* Who sent them, and the way to an account of their own. Rendered under the
			    deliverable rather than above it: they came here for the thing, and an
			    invitation that interrupted that would be the funnel this deliberately is not. */}
			{shareToken && !user && <SharedWorkBanner sharedBy={work.sharedBy ?? null} />}

			{/* The byline strip, under the deliverable — every kind now (the kinds pass,
			    2026-10-14): the title and the maker between the thing and its record, with
			    Share and Save to the right, and the Access chip that names who may open it. */}
			<WorkByline
				work={work}
				actions={
					<div className="flex shrink-0 items-center gap-1">
						{isAuthenticated && !shareToken && (
							<ShareLinkButton workId={work.id} slug={work.slug ?? ""} />
						)}
						<SaveButton workId={work.id} className="shrink-0" />
					</div>
				}
				chips={<WorkAccessChip access={access} />}
			/>

			{/* Every kind gets the SAME tab groups its editor renders — a user's read-only
			    version of the very same information, in the same two columns (the kinds pass,
			    2026-10-14); the per-kind linear pages and the goods two-up are gone. An owner
			    previewing gets their Manage tab back in the side column (Parker, 2026-10-17):
			    the row that switched the mode is where the mode is switched back, on the same
			    tab it never left in the editor. */}
			<VisitorRecord
				work={work}
				refetch={refetch}
				access={access}
				canAccess={canAccess}
				ownerManage={isOwner ? <WorkViewAsSection /> : undefined}
			/>
		</WorkColumn>
	);
}

/**
 * A Work's information for a viewer — the same Info and side tab groups its owner
 * edits in (`WorkInfoTabs`/`WorkSideColumn`), read-only, for every kind (the kinds
 * pass, 2026-10-14). For the owner previewing their own Work it is the same Record
 * with the Manage tab handed back in, holding the View As row where the editor
 * holds it (Parker, 2026-10-17). Rough views on purpose: Parker reviews the layout in
 * screenshots and the reads get tuned against what they look like, not a spec.
 */
function VisitorRecord({
	work,
	refetch,
	access,
	canAccess,
	ownerManage,
}: {
	work: WorkDetail;
	refetch: () => void;
	/** The user's own verdict — the access line's and the chip's truth, not the flag. */
	access: AccessResult | null | undefined;
	/** Whether this user may open the Work — the buyer files' own gate. */
	canAccess: boolean;
	/**
	 * The Manage tab's content for the owner previewing their own Work — the View As
	 * row, on the tab it lives on in the editor — or nothing for every visitor's page.
	 */
	ownerManage?: ReactNode;
}) {
	const publicAccess = access ? access.isFree : (work.publicAccess ?? false);
	const rating = work.maturity;
	// The rating on its grid, unanswered rows left unanswered — a released Work carries none,
	// and the read-only table is the answer as its creator marked it.
	const ratingGrid = gridFor(work.type);
	const ratingRows = normalizeMaturityRows(work.maturityRows, ratingGrid);
	return (
		<>
			{/* The columns' hairline above (Parker, 2026-10-16) — the same two-pixel rule the
			    halves' own divider draws, laid flat, so the tab columns read separately from
			    the title's lines above them; the column's `space-y-6` sets its air. */}
			<div aria-hidden className="h-0.5 bg-base-content/20" />
			<div className="grid lg:grid-cols-[minmax(0,1fr)_2px_minmax(0,1fr)]">
				<div className="lg:pr-4">
					<WorkInfoTabs
						tabs={[
							{
								key: "details",
								label: "Details",
								content: (
									// Named parts, as the creator's Details tab is (Parker, 2026-10-13):
									// what it says, when it came out and who may open it. The
									// buyer's files ride at its end when the kind carries any: they
									// are part of what owning this opens, and a record column had
									// them wedged under a store panel before. The description leads
									// the tab (Parker, 2026-10-19): what the Work is comes before
									// when it came out.
									<div className="flex flex-col gap-6">
										<section className="flex flex-col gap-2">
											<h3 className={WORK_DETAILS_HEADING_CLASS}>Description</h3>
											<WorkDescription work={work} />
										</section>
										<section className="flex flex-col gap-2">
											<h3 className={WORK_DETAILS_HEADING_CLASS}>Release</h3>
											<div className="flex flex-col gap-2">
												<ReleaseSummary work={work} scheduled={work.scheduledReleaseAt ?? null} />
												{work.originallyReleased && (
													<DateValueLine
														label="Original Release"
														value={formatOriginallyReleased(work.originallyReleased) ?? "—"}
													/>
												)}
											</div>
										</section>
										<section className="flex flex-col gap-2">
											<h3 className={WORK_DETAILS_HEADING_CLASS}>Access</h3>
											{/* The chip names this in the byline strip; the line says the terms. */}
											<p className="text-sm">
												{publicAccess ? (
													"Free to everyone."
												) : (
													<span className="text-base-content/60">
														Not free to everyone — the unlock above says what opens it.
													</span>
												)}
											</p>
										</section>
										{/* The buyer's files, when the kind carries any: they are part of what
								    owning this opens, and a record column had them wedged under a
								    store panel before. No section heading of its own —
								    `ProjectDownloads` names itself. */}
										{work.assets.length > 0 && (
											<ProjectDownloads
												assets={work.assets}
												contentType={work.type}
												workId={work.id}
												canAccess={canAccess}
											/>
										)}
									</div>
								),
							},
							{
								key: "credits",
								label: "Credits",
								content: <WorkCredits work={work} onCreditDecided={refetch} />,
							},
							{
								key: "rating",
								label: "Rating",
								// The full table, read-only, whatever the Work is rated (Parker,
								// 2026-10-16): the tab exists for the table, and a General Work's
								// all-General table says the rating in the same shape the other rungs
								// say theirs in. The badge above still carries the user-facing words.
								content: (
									<div className="flex flex-col gap-3">
										{(rating === "mature" || rating === "adult") && <WorkRating work={work} />}
										<RatingMatrixReadOnly grid={ratingGrid} rows={ratingRows} />
									</div>
								),
							},
							{
								key: "accessibility",
								label: "Accessibility",
								content: <CaptionsSummary captions={work.captions ?? []} />,
							},
						]}
					/>
				</div>
				<div aria-hidden className="w-0.5 self-stretch bg-base-content/20 max-lg:hidden" />
				<div className="lg:pl-4">
					<WorkSideColumn
						tabs={[
							// The owner's Manage tab, first and active as the editor's is
							// (Parker, 2026-10-17): while previewing, the row that switched the
							// mode stays where it was rather than jumping to the page's top.
							...(ownerManage ? [{ key: "manage", label: "Manage", content: ownerManage }] : []),
							{
								key: "reviews",
								label: "Reviews",
								// 🚨 A Work takes no votes and no comments: a review is the only feedback
								// it accepts (Parker, 2026-09-13).
								content: (
									<WorkReviews
										workId={work.id}
										aside={
											<StickerBar
												subjectType="work"
												subjectId={work.id}
												label={work.title ?? "this Work"}
												align="end"
											/>
										}
									/>
								),
							},
							{
								key: "showings",
								label: "Showings",
								content: <ShowingsStub work={work} />,
							},
						]}
						work={work}
					/>
				</div>
			</div>
		</>
	);
}
