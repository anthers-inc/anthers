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
import { useAuth } from "@anthers/web-shared/auth";
import TranscodingStatus from "@anthers/web-shared/media/TranscodingStatus";
import { LockedCover, lockedByBadge, presentsAsLocked } from "@anthers/web-shared/post/unlock";
import { postUrl, workUrl } from "@anthers/web-shared/postUrl";
import { Link, useLocation, useNavigate, useParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { studioEditWorkUrl } from "@anthers/web-shared/studio";
import type { TranscodingJob } from "@anthers/web-shared/types";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { MegaphoneIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import AddToBasket from "../components/basket/AddToBasket";
import PreviewBar, { usePreviewQuery } from "../components/creator/PreviewBar";
import SaveButton from "../components/library/SaveButton";
import { PublicAccessWall } from "../components/media/PublicAccessNotice";
import InlineUnlock from "../components/post/InlineUnlock";
import StickerBar from "../components/post/StickerBar";
import ProjectDownloads from "../components/project/ProjectDownloads";
import ProjectPricing from "../components/project/ProjectPricing";
import WorkReviews from "../components/project/WorkReviews";
import SharedWorkBanner from "../components/work/SharedWorkBanner";
import ShareLinkButton from "../components/work/ShareLinkButton";
import {
	isWriting,
	pageHoldsTheMeter,
	WorkColumn,
	WorkDeliverable,
	WorkDescription,
	type WorkDetail,
	WorkHeader,
} from "../components/work/WorkLayout";
import { useAttentionClaim } from "../lib/attention";
import { useMeteredBudget } from "../lib/public-access";
import { useShareToken, withShareToken } from "../lib/share-link";

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
	/** See `pageHoldsTheMeter`, which says which media's meter the page owns and why. */
	const playerless = work != null && pageHoldsTheMeter(work.type);
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
	const isOwner = isAuthenticated && user?.id === work.creatorId;
	/**
	 * Whether this viewer may open the Work.
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

	return (
		<WorkColumn type={work.type}>
			{/* Creator preview — only ever offered to the person who made it, and only ever
			    able to subtract access (the server guards that per Work). Beside it, the way back
			    to the Work's Edit page, which is where the preview is usually reached from. */}
			{isOwner && (
				<div className="flex flex-wrap items-start gap-2">
					<div className="flex-1">
						<PreviewBar />
					</div>
					<Link to={studioEditWorkUrl(work.publicId ?? work.id)} className="btn btn-primary btn-sm">
						Edit This Work
					</Link>
				</div>
			)}

			{work.visibility === "private" && isOwner && (
				<div className="alert alert-warning">
					<span>
						This Work is still private — only you can see it. Release it from your Catalog when it's
						ready.
					</span>
				</div>
			)}

			<WorkHeader
				work={work}
				titleAside={
					// Save sits beside the title rather than under the player, because it applies
					// to a gated Work too — it keeps the thing, it does not open it.
					<SaveButton workId={work.id} className="shrink-0" />
				}
			/>

			{/* A piece of writing's description is its standfirst, under the headline where a reader
			    expects one; every other kind keeps it under the Work, below. */}
			{isWriting(work.type) && <WorkDescription work={work} />}

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
									{work.creatorHasStripe && access.price && work.creator?.handle && (
										<AddToBasket
											workId={work.id}
											slug={work.slug ?? ""}
											title={work.title ?? "Untitled"}
											price={access.price}
											creatorHandle={work.creator.handle}
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
					<WorkDeliverable work={work} shareToken={shareToken} />
				)}
			</section>

			{/* Who sent them, and the way to an account of their own. Rendered under the
			    deliverable rather than above it: they came here to watch something, and an
			    invitation that interrupted that would be the funnel this deliberately is not. */}
			{shareToken && !user && <SharedWorkBanner sharedBy={work.sharedBy ?? null} />}

			{!isWriting(work.type) && <WorkDescription work={work} />}

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
			{/* 🚨 A Work takes no votes and no comments: a review is the only feedback it accepts
			    (Parker, 2026-09-13). */}
			{isAuthenticated && !shareToken && (
				<div className="flex items-center justify-end">
					<ShareLinkButton workId={work.id} />
				</div>
			)}

			{/* A Sticker may be given on any Work, gated or not, purchased or not, because it is
			    a gift to the creator rather than payment for the Work. It moves into the review
			    composer when Stickers become attachments to reviews, comments and votes. */}
			<StickerBar subjectType="work" subjectId={work.id} label={work.title ?? "this Work"} />

			{/* Reviews — a verdict on the work itself, which is the only thing a review
			    was ever about. Gated behind access on the server: you can't review what you
			    haven't been able to see. */}
			<WorkReviews workId={work.id} />

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
		</WorkColumn>
	);
}
